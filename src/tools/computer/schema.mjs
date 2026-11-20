export const COMPUTER_ACTIONS = Object.freeze([
  "snapshot",
  "close_execution",
  "batch",
  "left_click", "right_click", "middle_click", "double_click", "triple_click", "mouse_move",
  "left_click_drag", "left_mouse_down", "left_mouse_up", "scroll", "type", "key", "hold_key",
  "list_apps", "list_windows", "get_accessibility_tree", "get_cursor_position", "get_window_state",
  "launch_app", "kill_app", "bring_to_front", "set_value", "invoke_menu", "zoom",
]);

export const MAX_COMPUTER_BATCH_ACTIONS = 5;

const COMPUTER_BATCH_ACTIONS = COMPUTER_ACTIONS.filter((action) => action !== "batch" && action !== "close_execution");

const string = (description, extra = {}) => ({ type: "string", description, ...extra });
const integer = (description) => ({ type: "integer", description });
const number = (description) => ({ type: "number", description });
const boolean = (description) => ({ type: "boolean", description });

const properties = {
  action: {
    type: "string",
    enum: COMPUTER_ACTIONS,
    description: "Desktop action to perform. Use snapshot first and reuse its executionId. Use batch for 1–5 sequential actions only when each next step is predictable from the latest observation. End the batch before a step that depends on inspecting a changed screen; take a fresh snapshot after UI transitions when needed. For coordinate input, pass displayFrameId from the latest snapshot and do not assume stale coordinates remain valid after the layout changes. Batch reduces LLM/MCP round-trips, but this bridge still sends each desktop action separately to OpenClaw, so per-action Gateway latency remains. Use close_execution after the interaction is complete.",
  },
  actions: {
    type: "array",
    description: "Ordered desktop actions for action=batch. Choose only actions that are predictable from the latest snapshot and keep each batch to 1–5 steps. Stop before an action whose target or parameters depend on observing the UI after an earlier step. Actions execute sequentially and share the active execution. If included, snapshot must be the final action; take a separate snapshot before the batch to choose coordinates. Nested batches and close_execution are not supported. Maximum 5 actions.",
    minItems: 1,
    maxItems: MAX_COMPUTER_BATCH_ACTIONS,
    items: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: COMPUTER_BATCH_ACTIONS,
          description: "One desktop action to run in this position of the batch.",
        },
      },
      required: ["action"],
      additionalProperties: true,
    },
  },
  stopOnError: boolean("For action=batch, stop after the first failed action. Defaults to true."),
  screenIndex: integer("Screen index for snapshot or coordinate-based input."),
  maxWidth: integer("Maximum screenshot width for action=snapshot."),
  quality: number("Screenshot quality for action=snapshot, from 0 to 1."),
  format: { type: "string", enum: ["jpeg", "png"], description: "Screenshot image format." },
  x: number("Horizontal screen coordinate."),
  y: number("Vertical screen coordinate."),
  fromX: number("Starting horizontal coordinate for action=left_click_drag."),
  fromY: number("Starting vertical coordinate for action=left_click_drag."),
  x1: number("First horizontal coordinate for action=zoom."),
  y1: number("First vertical coordinate for action=zoom."),
  x2: number("Second horizontal coordinate for action=zoom."),
  y2: number("Second vertical coordinate for action=zoom."),
  refWidth: integer("Width of the screenshot used to choose coordinates, when known."),
  windowRef: string("Window reference returned by list_windows or an accessibility query."),
  elementRef: string("Element reference returned by get_accessibility_tree or get_window_state."),
  executionId: string("Execution UUID returned by snapshot. Reuse it for related actions; omit it to continue the bridge's active execution.", {
    pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$",
  }),
  observationId: string("Observation ID returned with the latest accessibility/window observation, when required."),
  displayFrameId: string("Display frame ID returned by the latest action=snapshot. Pass it with coordinate-based actions; take a fresh snapshot after the screen changes."),
  modifiers: string("Modifier keys, as accepted by the native driver."),
  deliveryMode: { type: "string", enum: ["background", "foreground"], description: "Whether to deliver input in the background or foreground." },
  durationMs: integer("Duration in milliseconds for drag or hold_key."),
  scrollDirection: { type: "string", enum: ["up", "down", "left", "right"], description: "Direction for action=scroll." },
  scrollAmount: integer("Amount to scroll for action=scroll."),
  text: string("Text to type for action=type."),
  keys: string("Key or key combination for action=key or action=hold_key."),
  app: string("Application name or executable to launch/terminate."),
  query: string("Optional filter for accessibility/window state results."),
  depth: integer("Maximum accessibility-tree depth."),
  maxElements: integer("Maximum accessibility elements to return."),
  includeScreenshot: boolean("Include a screenshot with action=get_window_state."),
  value: string("Value to set for action=set_value."),
  path: { type: "array", items: { type: "string" }, description: "Menu path segments for action=invoke_menu." },
  timeoutMs: integer("Maximum time to wait for the native node command, in milliseconds."),
};

export const computerToolDefinition = {
  name: "openclaw_computer",
  description: "Control desktop UI through a compatible paired OpenClaw computer node (Windows CUA by default on Windows; Linux requires OPENCLAW_COMPUTER_NODE and a separately installed driver). Use action=snapshot first, reuse its executionId, and pass its displayFrameId with coordinate-based actions. Take a fresh snapshot after screen changes. Batch up to 5 predictable actions between observations; use shorter batches when the next step depends on seeing the result of an interaction. Batch reduces LLM/MCP round-trips but each desktop action still incurs a separate Gateway call. Call action=close_execution when finished; idle executions are closed automatically after five minutes. This controls desktop UI, not browser DOM.",
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  inputSchema: {
    type: "object",
    properties,
    required: ["action"],
    additionalProperties: true,
  },
};
