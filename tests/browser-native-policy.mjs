import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createPolicyBoundBrowserTool } from "../src/tools/browser/advanced.mjs";
const cfg=JSON.parse(await readFile(process.env.OPENCLAW_CONFIG_PATH,"utf8"));
for (const [name,modify,expected] of [
  ["current", c=>c, true],
  ["global-deny", c=>({...c,tools:{...c.tools,deny:[...(c.tools?.deny??[]),"browser"]}}),false],
  ["agent-deny", c=>({...c,agents:{...c.agents,list:(c.agents?.list??[{id:"main"}]).map(a=>a.id==="main"?{...a,tools:{...a.tools,deny:[...(a.tools?.deny??[]),"browser"]}}:a)}}),false],
  ["gateway-deny", c=>({...c,gateway:{...c.gateway,tools:{...c.gateway?.tools,deny:["browser"]}}}),false],
  ["browser-disabled", c=>({...c,browser:{...c.browser,enabled:false}}),false],
  ["plugin-disabled", c=>({...c,plugins:{...c.plugins,entries:{...c.plugins?.entries,browser:{enabled:false}}}}),false],
]) {
  const tool=await createPolicyBoundBrowserTool(modify(structuredClone(cfg)));
  console.log(JSON.stringify({check:name,available:Boolean(tool)}));
  assert.equal(Boolean(tool),expected,name);
}
