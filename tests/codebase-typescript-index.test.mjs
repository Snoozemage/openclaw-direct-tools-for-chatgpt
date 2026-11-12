import test from "node:test";
import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {mkdtemp,mkdir,cp,readFile,writeFile,rm,unlink} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {createProjectRegistry} from "../src/tools/codebase-intelligence/registry.mjs";
import {createIndexEngine} from "../src/tools/codebase-intelligence/engine.mjs";
import {openExistingIndex} from "../src/tools/codebase-intelligence/store.mjs";
import {createCodebaseIntelligenceHandler} from "../src/tools/codebase-intelligence/handler.mjs";

const fixtures=path.join(path.dirname(fileURLToPath(import.meta.url)),"fixtures");
async function withProject(cb){
  const dir=await mkdtemp(path.join(os.tmpdir(),"openclaw-ts-p5-"));
  const fe=path.join(dir,"ts"),be=path.join(dir,"cs"),stateRoot=path.join(dir,"state");
  try{
    for(const d of [fe,be,stateRoot])await mkdir(d);
    await cp(path.join(fixtures,"codebase-typescript"),fe,{recursive:true});
    await cp(path.join(fixtures,"codebase-csharp"),be,{recursive:true});
    for(const repo of [fe,be])execFileSync("git",["init","-q",repo],{windowsHide:true,timeout:5000});
    const registry=createProjectRegistry({stateRoot});
    await registry.register({projectId:"ts-pilot",repositories:[
      {id:"training-ts",root:fe,languages:["typescript"]},
      {id:"training-csharp",root:be,languages:["csharp","sql"]},
    ]});
    await cb({dir,fe,be,stateRoot,registry});
  }finally{await rm(dir,{recursive:true,force:true,maxRetries:9,retryDelay:175});}
}
async function complete(engine,mode="incremental"){
  const started=await engine.index({projectId:"ts-pilot",mode});
  assert.equal(started.accepted,true);
  for(let i=0;i<480;i++){
    const status=await engine.status("ts-pilot",started.job.jobId);
    if(["completed","failed","cancelled"].includes(status.job.state))return status;
    await new Promise(r=>setTimeout(r,25));
  }
  throw Error("TS fixture index did not complete");
}
test("TS AST index v4 records imports/exports/pages, mock adapter and HTTP facts",async()=>withProject(async({registry,stateRoot})=>{
  const engine=createIndexEngine({registry});
  const status=await complete(engine,"full");
  assert.equal(status.job.state,"completed",JSON.stringify(status.job.error));
  assert.equal(status.index.typescript.parseErrors,0);
  assert.ok(status.index.typescript.facts>30);
  assert.equal(status.index.typescript.pages,2);
  assert.equal(status.index.typescript.mockBindings,1);
  const index=await openExistingIndex(path.join(stateRoot,"index"),"ts-pilot");
  assert.equal(index.prepare("PRAGMA user_version").get().user_version,4);
  assert.equal(index.prepare("PRAGMA integrity_check").get().integrity_check,"ok");
  index.close();
  const pages=await engine.typescriptSearch({projectId:"ts-pilot",query:"/teaching-devices",kinds:["next_page"]});
  assert.equal(pages.results[0].name,"/teaching-devices");
  assert.equal(pages.results[0].freshness,"verified_current_hash");
  const mock=await engine.trace({projectId:"ts-pilot",language:"typescript",query:"teachingDevicesService",maxDepth:7});
  assert.ok(mock.nodes.some(n=>n.kind==="export_binding"&&n.target==="mockTeachingDevicesService"));
  assert.ok(mock.edges.some(e=>e.kind==="active_mock_binding"&&e.status==="verified_static"));
  const route=await engine.trace({projectId:"ts-pilot",language:"typescript",query:"/teaching-devices",maxDepth:9});
  assert.ok(route.nodes.some(n=>n.kind==="module"&&n.relativePath.includes("teaching-devices-view")));
  assert.ok(route.nodes.some(n=>n.kind==="import"&&n.name==="teachingDevicesService"));
  assert.ok(route.edges.some(e=>e.kind==="active_mock_binding"));
  assert.ok(!route.nodes.some(n=>n.relativePath==="src/components/ui/button.tsx"),"Feature-focused trace must not traverse unrelated UI imports.");
}));
test("TypeChecker import usage creates source-only edge without shadowed call",async()=>withProject(async({registry,fe})=>{
  const folder=path.join(fe,"src","features");
  await mkdir(folder,{recursive:true});
  await writeFile(path.join(folder,"client.ts"),
    "export const client = { get: () => 1 };\n");
  await writeFile(path.join(folder,"consumer.ts"),[
    'import { client as service } from "./client";',
    'export function run(){ return service.get(); }',
    'export function shadow(service: any){ return service.get(); }',
  ].join("\n"));
  const engine=createIndexEngine({registry});
  const status=await complete(engine,"full");
  assert.equal(status.job.state,"completed",JSON.stringify(status.job.error));
  const graph=await engine.evidenceGraph({projectId:"ts-pilot",query:"src/features/consumer.ts",
    repoIds:["training-ts"],languages:["typescript"],maxDepth:4,maxNodes:80});
  assert.ok(graph.nodes.some(x=>x.kind==="import_usage"&&x.name==="service.get"));
  assert.equal(graph.nodes.filter(x=>x.kind==="import_usage"&&
    x.relativePath==="src/features/consumer.ts").length,1,
    "Shadowed parameter must not produce another import usage");
  assert.ok(graph.edges.some(x=>x.kind==="typechecker_resolved_import_binding"&&
    x.status==="verified_static"));
  assert.ok(!graph.edges.some(x=>x.status==="verified_runtime"));
}));
test("FE mock adapter audit never claims runtime backend; HTTP route match stays candidate",async()=>withProject(async({registry})=>{
  const engine=createIndexEngine({registry});
  assert.equal((await complete(engine,"full")).job.state,"completed");
  const mock=await engine.matchFrontendBackend({projectId:"ts-pilot",query:"teaching devices"});
  assert.equal(mock.activeMockAdapters.length,1);
  assert.equal(mock.activeMockAdapters[0].name,"teachingDevicesService");
  assert.equal(mock.matchedContracts.length,0);
  assert.deepEqual(mock.verifiedRuntimeLinks,[]);
  const contract=await engine.matchFrontendBackend({projectId:"ts-pilot",query:"CourseSubjects"});
  assert.ok(contract.matchedContracts.some(x=>
    x.frontend.httpMethod==="GET"&&x.backend.endpoint==="GET /api/CourseSubjects/{id}"));
  assert.deepEqual(contract.verifiedRuntimeLinks,[]);
  const handler=createCodebaseIntelligenceHandler({registry,engine});
  const r=await handler("openclaw_codebase_intelligence",{action:"typescript",operation:"find",
    projectId:"ts-pilot",query:"/teaching-devices",kinds:["next_page"]});
  assert.equal(r.structuredContent.result.results[0].name,"/teaching-devices");
  const m=await handler("openclaw_codebase_intelligence",{action:"match",projectId:"ts-pilot",query:"teaching devices"});
  assert.equal(m.structuredContent.result.activeMockAdapters.length,1);
}));
test("switching mock adapter to HTTP updates facts, removes mock edge and invalidates stale metadata",async()=>withProject(async({registry,fe})=>{
  const engine=createIndexEngine({registry});
  assert.equal((await complete(engine,"full")).job.state,"completed");
  const file=path.join(fe,"src","services","teaching-devices.service.ts");
  await writeFile(file,
    "import { axiosInstance } from '@/services/api';\nexport const teachingDevicesService = {list: () => axiosInstance.get('/api/CourseSubjects/{id}')};\n");
  const stale=await engine.typescriptSearch({projectId:"ts-pilot",query:"teachingDevicesService",kinds:["export_binding"]});
  assert.equal(stale.results[0].freshness,"stale_or_unavailable");
  assert.equal(stale.results[0].details,null);
  const updated=await complete(engine);
  assert.equal(updated.job.state,"completed",JSON.stringify(updated.job.error));
  assert.equal(updated.index.changed,1);
  assert.equal(updated.job.progress.typescriptParsed,1);
  assert.equal(updated.index.typescript.mockBindings,0);
  const match=await engine.matchFrontendBackend({projectId:"ts-pilot",query:"teaching devices"});
  assert.equal(match.activeMockAdapters.length,0);
  assert.ok(match.matchedContracts.some(x=>x.frontend.relativePath.endsWith("teaching-devices.service.ts")));
  await unlink(path.join(fe,"src","services","reexports.ts"));
  const gone=await complete(engine);
  assert.equal(gone.index.removed,1);
}));
test("bad TSX syntax cannot invent endpoints and index remains consistent",async()=>withProject(async({registry,fe})=>{
  await writeFile(path.join(fe,"src","services","broken.ts"),"export const x = ;");
  const engine=createIndexEngine({registry});
  const status=await complete(engine,"full");
  assert.equal(status.job.state,"completed");
  assert.ok(status.index.typescript.parseErrors>=1);
  const found=await engine.typescriptSearch({projectId:"ts-pilot",query:"broken",kinds:["http_request"]});
  assert.equal(found.results.length,0);
}));
