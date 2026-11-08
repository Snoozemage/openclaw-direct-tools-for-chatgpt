import test from "node:test";
import assert from "node:assert/strict";
import { browserToolDefinition, BROWSER_ACTIONS, BROWSER_ACT_KINDS } from "../src/tools/browser/schema.mjs";

test("Browser schema exposes supported actions and only requires action", () => {
  const schema = browserToolDefinition.inputSchema;
  assert.equal(browserToolDefinition.name, "openclaw_browser");
  assert.deepEqual(schema.properties.action.enum, [...BROWSER_ACTIONS]);
  assert.deepEqual(schema.properties.kind.enum, [...BROWSER_ACT_KINDS]);
  assert.deepEqual(schema.required, ["action"]);
  assert.equal(schema.additionalProperties, true);
});

test("Browser schema keeps implementation details out of the public contract", () => {
  const schema = browserToolDefinition.inputSchema;
  assert.equal(schema.properties.profile, undefined);
  assert.equal(schema.properties.browser, undefined);
  assert.equal(schema.properties.systemProfile, undefined);
  assert.doesNotMatch(browserToolDefinition.description, /profile|systemProfile|timeout|extension|Gateway/i);
  assert.ok(Buffer.byteLength(JSON.stringify(schema)) < 30_000);
});

test("BrowserAct parameter descriptions explain operation-specific inputs", () => {
  const schema = browserToolDefinition.inputSchema;
  assert.match(schema.properties.fields.description, /kind=fill.*ref and value/i);
  assert.match(schema.properties.key.description, /kind=press/i);
  assert.match(schema.properties.x.description, /clickCoords/i);
  assert.match(schema.properties.startRef.description, /drag/i);
  assert.match(schema.properties.stopOnError.description, /batch/i);
  assert.match(schema.properties.kind.description, /Default to kind=batch when two or more consecutive necessary actions/i);
  assert.match(schema.properties.actions.description, /BrowserActRequest[\s\S]*one \/act request[\s\S]*snapshot[\s\S]*dependent actions/i);
  assert.match(schema.properties.actions.description, /click does not carry over to type/i);
  assert.match(schema.properties.actions.description, /same type action/i);
  assert.match(schema.properties.actions.items.properties.kind.description, /inherit/i);
  assert.match(schema.properties.ref.description, /not inherited from earlier batch actions/i);
  assert.match(schema.properties.selector.description, /not inherited from earlier batch actions/i);
  assert.match(browserToolDefinition.description, /do not add redundant hover, scrollIntoView, wait or delayMs/i);
  assert.match(schema.properties.url.description, /kind=wait/i);
  assert.match(schema.properties.fn.description, /kind=evaluate[\s\S]*function expression[\s\S]*not an immediately invoked function expression \(IIFE\) or its return value/i);
});

test("Browser description contains only essential usage guidance", () => {
  assert.equal(
    browserToolDefinition.description,
    "Control Chrome through OpenClaw. Use action=open or navigate with targetUrl; if Chrome is not running, use open to launch it and open the requested URL. Use snapshot before page interactions, then pass its refs to action=act. Prefer action=act with kind=batch for two or more necessary predictable interactions on the same tab. Use direct single actions otherwise; do not add redundant hover, scrollIntoView, wait or delayMs just to create a batch. Every element-targeting action must include its own ref or selector; click targets are not inherited by later type, fill, or press actions. For type, always repeat ref or selector on the type step, even after clicking the field. Batch entries are act kinds, not open, navigate, snapshot, or screenshot. Page-changing steps can invalidate refs. Batch stops on the first error by default; stopOnError:false continues. Extra actions: highlight(ref), trace(operation=start|stop), responsebody(url), cookies(operation), storage(storageKind,operation,key,value), set(setting), permissions(origin,permissions), dialogs, effects(enabled). Clear cookies/storage only when explicitly requested; effects provide visual feedback and do not move the system pointer."
  );
});
