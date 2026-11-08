import test from "node:test";
import assert from "node:assert/strict";
import {
  beginToolEvent,
  clearMonitorEvents,
  finishToolEvent,
  getCurrentToolActivity,
  monitorEvents,
  removeMonitorEventsForSession,
} from "../src/monitor/events.mjs";

test("tool activity distinguishes regular MCP calls from computer use and returns to idle", () => {
  clearMonitorEvents();
  const regularCall = beginToolEvent("openclaw_read", {}, "activity-regular");
  assert.deepEqual(getCurrentToolActivity(), {
    state: "tool",
    activeCount: 1,
    computerCount: 0,
    toolCount: 1,
  });

  const computerCall = beginToolEvent("openclaw_computer", { action: "snapshot" }, "activity-computer");
  assert.deepEqual(getCurrentToolActivity(), {
    state: "computer",
    activeCount: 2,
    computerCount: 1,
    toolCount: 1,
  });

  finishToolEvent(computerCall, { content: [{ type: "text", text: "snapshot complete" }] });
  assert.deepEqual(getCurrentToolActivity(), {
    state: "tool",
    activeCount: 1,
    computerCount: 0,
    toolCount: 1,
  });

  finishToolEvent(regularCall, { content: [{ type: "text", text: "read complete" }] });
  assert.deepEqual(getCurrentToolActivity(), {
    state: "idle",
    activeCount: 0,
    computerCount: 0,
    toolCount: 0,
  });
});

test("native CUA dispatch counts as computer use and clears on refusal", () => {
  clearMonitorEvents();
  const regular = beginToolEvent("openclaw_dispatch_action", { id: "session_status" }, "native-regular");
  const cursor = beginToolEvent("openclaw_dispatch_action", { id: "cua-driver__move_cursor" }, "native-cursor");
  assert.deepEqual(getCurrentToolActivity(), { state: "computer", activeCount: 2, computerCount: 1, toolCount: 1 });
  finishToolEvent(cursor, { isError: true, content: [{ type: "text", text: "refused" }] });
  assert.equal(getCurrentToolActivity().state, "tool");
  finishToolEvent(regular, { content: [] });
  assert.equal(getCurrentToolActivity().state, "idle");
});

test("removing a session deletes its retained logs and suppresses completion of its in-flight calls", () => {
  clearMonitorEvents();
  const removedSession = { id: "agent-monitor-delete-a", task: "delete me" };
  const retainedSession = { id: "agent-monitor-delete-b", task: "keep me" };
  const inFlight = beginToolEvent("test_tool", {}, "delete-running", removedSession);
  const retained = beginToolEvent("test_tool", {}, "keep-running", retainedSession);

  assert.deepEqual(monitorEvents.map(event => event.sessionId), [removedSession.id, retainedSession.id]);
  assert.equal(removeMonitorEventsForSession(removedSession.id), 1);
  assert.deepEqual(monitorEvents.map(event => event.sessionId), [retainedSession.id]);

  finishToolEvent(inFlight, { content: [{ type: "text", text: "late result" }] }, null, removedSession);
  assert.deepEqual(monitorEvents.map(event => event.sessionId), [retainedSession.id]);

  finishToolEvent(retained, { content: [{ type: "text", text: "retained result" }] }, null, retainedSession);
  assert.equal(monitorEvents.length, 1);
  assert.equal(monitorEvents[0].status, "success");
});

test("clearing monitor events prevents already-running calls from restoring old log entries", () => {
  clearMonitorEvents();
  const session = { id: "agent-monitor-clear", task: "clear me" };
  const inFlight = beginToolEvent("test_tool", {}, "clear-running", session);
  assert.equal(monitorEvents.length, 1);

  assert.equal(clearMonitorEvents(), 1);
  assert.equal(monitorEvents.length, 0);
  finishToolEvent(inFlight, { content: [{ type: "text", text: "late result" }] }, null, session);

  assert.equal(monitorEvents.length, 0);
});

test("file mutation Monitor events retain structured unified diffs", () => {
  clearMonitorEvents();
  const session = { id: "agent-monitor-diffs", task: "show file mutation diffs" };
  const patch = "--- before.txt\n+++ after.txt\n@@ -1,2 +1,2 @@\n-old value\n+new value\n same line\n";

  for (const [index, tool] of ["openclaw_edit", "openclaw_write", "openclaw_apply_patch"].entries()) {
    const event = beginToolEvent(tool, { path: "test.txt" }, "mutation-" + index, session);
    finishToolEvent(event, {
      content: [{ type: "text", text: "File updated successfully." }],
      structuredContent: { changed: true, patch },
    }, null, session);

    const recorded = monitorEvents.find(item => item.id === event.id);
    assert.equal(recorded.output.patch, patch);
    assert.deepEqual(recorded.output.result, ["File updated successfully."]);
    assert.equal(recorded.status, "success");
  }
});
