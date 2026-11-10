import { randomUUID } from "node:crypto";
import { computerNode } from "../../config/runtime.mjs";
import { invokeNodeCommand } from "../../openclaw-client.mjs";
import { computerToolDefinition, MAX_COMPUTER_BATCH_ACTIONS } from "./schema.mjs";
import { storeScreenshot } from "./screenshot-store.mjs";
import { screenBorder } from "../../monitor/screen-border.mjs";

const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const COMMON_INPUT_FIELDS = [
  "screenIndex", "refWidth", "windowRef", "elementRef", "observationId",
  "deliveryMode", "displayFrameId",
];

const ACTION_FIELDS = {
  left_click: [...COMMON_INPUT_FIELDS, "x", "y", "modifiers"],
  right_click: [...COMMON_INPUT_FIELDS, "x", "y", "modifiers"],
  middle_click: [...COMMON_INPUT_FIELDS, "x", "y", "modifiers"],
  double_click: [...COMMON_INPUT_FIELDS, "x", "y", "modifiers"],
  triple_click: [...COMMON_INPUT_FIELDS, "x", "y", "modifiers"],
  mouse_move: [...COMMON_INPUT_FIELDS, "x", "y", "modifiers"],
  left_click_drag: [...COMMON_INPUT_FIELDS, "x", "y", "fromX", "fromY", "durationMs"],
  left_mouse_down: [...COMMON_INPUT_FIELDS, "x", "y", "modifiers"],
  left_mouse_up: [...COMMON_INPUT_FIELDS, "x", "y", "modifiers"],
  scroll: [...COMMON_INPUT_FIELDS, "x", "y", "modifiers", "scrollDirection", "scrollAmount"],
  type: [...COMMON_INPUT_FIELDS, "text"],
  key: [...COMMON_INPUT_FIELDS, "keys"],
  hold_key: [...COMMON_INPUT_FIELDS, "keys", "durationMs"],
  list_apps: [],
  list_windows: [],
  get_cursor_position: [],
  get_accessibility_tree: ["windowRef", "query", "depth", "maxElements"],
  get_window_state: ["windowRef", "includeScreenshot", "query", "depth", "maxElements"],
  launch_app: ["app"],
  kill_app: ["app"],
  bring_to_front: ["windowRef"],
  set_value: ["windowRef", "elementRef", "observationId", "value", "deliveryMode"],
  invoke_menu: ["windowRef", "path", "deliveryMode"],
  zoom: ["windowRef", "observationId", "x1", "y1", "x2", "y2"],
};

function pick(source, keys) {
  return Object.fromEntries(keys.filter((key) => source[key] !== undefined).map((key) => [key, source[key]]));
}

function toolError(message) {
  return { isError: true, content: [{ type: "text", text: message }] };
}

function enqueue(queues, key, operation) {
  const previous = queues.get(key) ?? Promise.resolve();
  const current = previous.then(operation, operation);
  queues.set(key, current.then(() => undefined, () => undefined));
  return current;
}

function validateAction(action) {
  if (action === "snapshot" || action === "close_execution" || ACTION_FIELDS[action]) return undefined;
  if (action === "batch") return "Nested computer batches are not supported.";
  return "Unsupported desktop action: " + String(action);
}

export function createComputerToolHandler({ idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS, indicator } = {}) {
  // OpenClaw's provider permits one active execution per computer. Keep a single
  // correlated execution per node, and serialize operations including whole batches.
  const sessions = new Map();
  const queues = new Map();

  function clearSessionTimer(session) {
    if (session.timer) clearTimeout(session.timer);
    session.timer = undefined;
  }

  function scheduleIdleCleanup(session) {
    clearSessionTimer(session);
    if (!(idleTimeoutMs > 0)) return;

    session.timer = setTimeout(() => {
      void enqueue(queues, session.key, async () => {
        if (sessions.get(session.key) !== session) return;

        const idleFor = Date.now() - session.lastUsedAt;
        if (idleFor < idleTimeoutMs) {
          scheduleIdleCleanup(session);
          return;
        }

        let result;
        try {
          result = await session.invoke(session.node, "computer.act", {
            action: "__close_execution",
            executionId: session.executionId,
            reason: "bridge-idle-timeout",
          }, 10000, { executionId: session.executionId });
        } catch {
          result = toolError("Could not close the idle computer execution.");
        }

        if (sessions.get(session.key) !== session) return;
        indicator?.close("legacy:" + session.executionId);
        if (result?.isError) {
          session.lastUsedAt = Date.now();
          scheduleIdleCleanup(session);
          return;
        }

        clearSessionTimer(session);
        sessions.delete(session.key);
      }).catch(() => {
        if (sessions.get(session.key) === session) {
          session.lastUsedAt = Date.now();
          scheduleIdleCleanup(session);
        }
      });
    }, idleTimeoutMs);
    session.timer.unref?.();
  }

  async function closeSession(session, reason, timeoutMs = 15000) {
    clearSessionTimer(session);
    let result;
    try {
      result = await session.invoke(session.node, "computer.act", {
        action: "__close_execution",
        executionId: session.executionId,
        reason,
      }, Math.min(timeoutMs, 15000), { executionId: session.executionId });
    } finally {
      indicator?.close("legacy:" + session.executionId);
    }

    if (!result?.isError) {
      if (sessions.get(session.key) === session) sessions.delete(session.key);
    } else {
      session.lastUsedAt = Date.now();
      scheduleIdleCleanup(session);
    }
    return result;
  }

  async function performAction(name, args, context) {
    const { invoke, node, key, timeoutMs } = context;
    let session = sessions.get(key);

    if (args.action === "close_execution") {
      if (!session && !args.executionId) {
        return { content: [{ type: "text", text: "No active computer execution to close." }] };
      }
      if (session && args.executionId && args.executionId !== session.executionId) {
        return toolError("executionId does not match the active computer execution.");
      }
      if (!session) {
        session = { key, node, invoke, executionId: args.executionId, lastUsedAt: Date.now() };
      }
      return closeSession(session, "bridge-client-close", timeoutMs);
    }

    const requestedId = args.executionId;
    if (session && requestedId && requestedId !== session.executionId) {
      const closed = await closeSession(session, "bridge-execution-replaced", timeoutMs);
      if (closed?.isError) return closed;
      session = undefined;
    }

    const executionId = requestedId ?? session?.executionId ?? randomUUID();
    if (!session || session.executionId !== executionId) {
      session = { key, node, invoke, executionId, lastUsedAt: Date.now(), timer: undefined };
      sessions.set(key, session);
    } else {
      session.node = node;
      session.invoke = invoke;
    }
    session.lastUsedAt = Date.now();
    scheduleIdleCleanup(session);

    const indicatorKey = "legacy:" + executionId;
    indicator?.open(indicatorKey);
    let result;
    try {
      if (args.action === "snapshot") {
        const params = { ...pick(args, ["screenIndex", "maxWidth", "quality", "format"]), executionId };
        result = await invoke(node, "screen.snapshot", params, timeoutMs, { executionId });
      } else {
        const params = { action: args.action, ...pick(args, ACTION_FIELDS[args.action]), executionId };
        result = await invoke(node, "computer.act", params, timeoutMs, {
          executionId,
          refWidth: args.refWidth,
        });
      }
    } catch (error) {
      indicator?.close(indicatorKey);
      throw error;
    }
    if (result?.isError) indicator?.close(indicatorKey);
    else indicator?.open(indicatorKey);

    if (sessions.get(key) === session) {
      session.lastUsedAt = Date.now();
      scheduleIdleCleanup(session);
    }
    return result;
  }

  async function closeAllExecutions() {
    const active = [...sessions.values()];
    const results = await Promise.all(active.map(session => enqueue(queues, session.key, async () => {
      if (sessions.get(session.key) !== session) return { closed: true };
      try {
        const result = await closeSession(session, "bridge-tray-close", 10000);
        return { closed: result?.isError !== true };
      } catch {
        if (sessions.get(session.key) === session) {
          session.lastUsedAt = Date.now();
          scheduleIdleCleanup(session);
        }
        return { closed: false };
      }
    })));
    indicator?.clear("legacy:");
    return {
      attempted: active.length,
      closed: results.filter(result => result.closed).length,
      failed: results.filter(result => !result.closed).length,
    };
  }

  const handleComputerTool = async function handleComputerTool(name, args = {}, dependencies = {}) {
    if (name !== computerToolDefinition.name) return undefined;

    const invoke = dependencies.invokeNodeCommand ?? invokeNodeCommand;
    const node = String(dependencies.node ?? computerNode);
    const key = node;
    const timeoutMs = Number.isInteger(args.timeoutMs) && args.timeoutMs > 0 ? args.timeoutMs : 30000;
    const context = { invoke, node, key, timeoutMs };

    if (args.executionId !== undefined && !UUID_PATTERN.test(args.executionId)) {
      return toolError("executionId must be the UUID returned by action=snapshot.");
    }

    if (args.action === "batch") {
      if (!Array.isArray(args.actions) || args.actions.length === 0 || args.actions.length > MAX_COMPUTER_BATCH_ACTIONS) {
        return toolError("actions must contain between 1 and " + MAX_COMPUTER_BATCH_ACTIONS + " desktop actions.");
      }
      for (let index = 0; index < args.actions.length; index += 1) {
        const step = args.actions[index];
        if (!step || typeof step !== "object" || Array.isArray(step)) {
          return toolError("actions[" + index + "] must be an action object.");
        }
        const error = validateAction(step.action);
        if (error) return toolError("actions[" + index + "]: " + error);
        if (step.action === "close_execution") {
          return toolError("actions[" + index + "]: close_execution cannot run inside a batch; call it after the batch.");
        }
        if (step.action === "snapshot" && index !== args.actions.length - 1) {
          return toolError("actions[" + index + "]: snapshot can only be the final batch action; take a snapshot before the batch to choose coordinates.");
        }
        if (step.executionId !== undefined) {
          return toolError("actions[" + index + "]: set executionId on the batch request, not on individual actions.");
        }
      }

      const stopOnError = args.stopOnError !== false;
      return enqueue(queues, key, async () => {
        const results = [];
        const content = [];
        let failed = false;

        for (let index = 0; index < args.actions.length; index += 1) {
          const step = args.actions[index];
          const stepArgs = {
            ...args,
            ...step,
            action: step.action,
            timeoutMs: Number.isInteger(step.timeoutMs) && step.timeoutMs > 0 ? step.timeoutMs : timeoutMs,
          };
          delete stepArgs.actions;
          delete stepArgs.stopOnError;

          let result;
          try {
            result = await performAction(name, stepArgs, { ...context, timeoutMs: stepArgs.timeoutMs });
          } catch (error) {
            result = toolError(error instanceof Error ? error.message : String(error));
          }

          const actionFailed = Boolean(result?.isError);
          failed ||= actionFailed;
          results.push({ index, action: step.action, isError: actionFailed });
          content.push({ type: "text", text: "Batch action " + (index + 1) + "/" + args.actions.length + ": " + step.action + (actionFailed ? " - FAILED" : " - completed") });
          for (const item of result?.content ?? []) content.push(item);

          if (actionFailed && stopOnError) break;
        }

        const completed = results.length;
        content.unshift({
          type: "text",
          text: "Computer batch finished: " + completed + "/" + args.actions.length + " actions executed; " +
            results.filter((item) => !item.isError).length + " succeeded, " +
            results.filter((item) => item.isError).length + " failed. " +
            (completed < args.actions.length ? "Stopped after the first failure." : ""),
        });
        return { content, isError: failed || undefined, structuredContent: { results } };
      });
    }

    const error = validateAction(args.action);
    if (error) return toolError(error);
    return enqueue(queues, key, async () => {
      const result = await performAction(name, args, context);
      if (args.action !== "snapshot" || result?.isError) return result;

      const image = (result?.content ?? []).find((item) =>
        item?.type === "image" && typeof item.data === "string" && typeof item.mimeType === "string"
      );
      if (!image) return result;

      const screenshotRef = storeScreenshot(image.data, image.mimeType);
      const content = [...result.content];
      const refText = "Screenshot reference for optional UI rendering: " + screenshotRef + ". Call openclaw_image_render only when the screenshot should be displayed in the chat UI.";
      const textIndex = content.findIndex((item) => item?.type === "text" && typeof item.text === "string");
      if (textIndex >= 0) content[textIndex] = { ...content[textIndex], text: content[textIndex].text + "\n" + refText };
      else content.unshift({ type: "text", text: refText });

      return {
        ...result,
        content,
        structuredContent: {
          ...(result.structuredContent && typeof result.structuredContent === "object" ? result.structuredContent : {}),
          screenshot_ref: screenshotRef,
        },
      };
    });
  };
  handleComputerTool.closeAllExecutions = closeAllExecutions;
  handleComputerTool.activeExecutionCount = () => sessions.size;
  return handleComputerTool;
}

export const handleComputerTool = createComputerToolHandler({ indicator: screenBorder });
