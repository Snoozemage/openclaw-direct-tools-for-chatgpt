import test from "node:test";
import assert from "node:assert/strict";
import { toolDefinitions } from "../src/mcp/tool-definitions.mjs";

const expectedAnnotations = {
  start_here: [false, false, false],
  openclaw_bridge_restart: [false, true, false],
  openclaw_browser: [false, true, true],
  openclaw_computer: [false, true, true],
  openclaw_image_render: [true, false, false],
  openclaw_ls: [true, false, false],
  openclaw_read: [true, false, false],
  openclaw_edit: [false, true, false],
  openclaw_write: [false, true, false],
  openclaw_apply_patch: [false, true, false],
  openclaw_glob: [true, false, false],
  openclaw_grep: [true, false, false],
  openclaw_codebase_intelligence: [false, false, false],
  openclaw_exec: [false, true, true],
  openclaw_process: [false, true, true],
  openclaw_tool_search: [true, false, true],
  openclaw_tool_describe: [true, false, true],
  openclaw_dispatch_action: [false, true, true],
};

test("all public MCP tools declare annotations matching their actual effects and trust boundaries", () => {
  assert.deepEqual(
    new Set(toolDefinitions.map((tool) => tool.name)),
    new Set(Object.keys(expectedAnnotations)),
  );
  for (const tool of toolDefinitions) {
    const [readOnlyHint, destructiveHint, openWorldHint] = expectedAnnotations[tool.name];
    assert.deepEqual(tool.annotations, { readOnlyHint, destructiveHint, openWorldHint }, tool.name);
  }
});
