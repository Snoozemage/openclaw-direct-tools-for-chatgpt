import test from "node:test";
import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {mkdtemp,mkdir,cp,writeFile,readFile,rm,unlink} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {createProjectRegistry} from "../src/tools/codebase-intelligence/registry.mjs";
import {createIndexEngine} from "../src/tools/codebase-intelligence/engine.mjs";
import {createCodebaseIntelligenceHandler} from "../src/tools/codebase-intelligence/handler.mjs";
import {openExistingIndex} from "../src/tools/codebase-intelligence/store.mjs";

const fixture=path.join(path.dirname(fileURLToPath(import.meta.url)),"fixtures");
async function withProject(callback,{includePhp=false}={}){
  const temp=await mkdtemp(path.join(os.tmpdir(),"openclaw-csharp-p4-"));
  const csharp=path.join(temp,"csharp"),php=path.join(temp,"legacy");
  const stateRoot=path.join(temp,"state");
  await mkdir(csharp);await mkdir(stateRoot);
  try{
    await cp(path.join(fixture,"codebase-csharp"),csharp,{recursive:true});
    execFileSync("git",["init","-q",csharp],{windowsHide:true,timeout:5000});
    const roots=[csharp],repositories=[{id:"training-csharp",root:csharp,languages:["csharp","sql"]}];
    if(includePhp){
      await mkdir(php);
      await cp(path.join(fixture,"codebase-php"),php,{recursive:true});
      execFileSync("git",["init","-q",php],{windowsHide:true,timeout:5000});
      roots.push(php);repositories.push({id:"legacy-php",root:php,languages:["php","sql"]});
    }
    const registry=createProjectRegistry({stateRoot});
    await registry.register({projectId:"csharp-p4",repositories});
    await callback({temp,csharp,php,registry,stateRoot});
  } finally{await rm(temp,{recursive:true,force:true,maxRetries:8,retryDelay:150});}
}
async function index(engine,mode="incremental"){
  const a=await engine.index({projectId:"csharp-p4",mode});
  assert.equal(a.accepted,true);
  for(let i=0;i<450;i++){
    const s=await engine.status("csharp-p4",a.job.jobId);
    if(["completed","failed","cancelled"].includes(s.job?.state))return s;
    await new Promise(r=>setTimeout(r,20));
  }
  throw Error("Roslyn fixture index unfinished");
}
test("Roslyn index v3 persists C# facts, endpoint metadata, CQRS/DI/EF graph",async()=>withProject(async({registry,stateRoot})=>{
  const engine=createIndexEngine({registry});
  const result=await index(engine,"full");
  assert.equal(result.job.state,"completed",JSON.stringify(result.job.error));
  assert.equal(result.index.csharp.parseErrors,0);
  assert.ok(result.index.csharp.facts>20);
  assert.ok(result.index.csharp.edges>12);
  assert.equal(result.index.csharp.endpoints,2);
  const endpoints=await engine.csharpSearch({projectId:"csharp-p4",query:"GET /api/CourseSubjects/{id}",
    kinds:["endpoint"],repoIds:["training-csharp"]});
  assert.equal(endpoints.results[0].name,"GET /api/CourseSubjects/{id}");
  assert.equal(endpoints.results[0].freshness,"verified_current_hash");
  const trace=await engine.trace({projectId:"csharp-p4",query:"GET /api/CourseSubjects/{id}",
    language:"csharp",repoIds:["training-csharp"],maxDepth:7});
  assert.ok(trace.nodes.some(n=>n.kind==="mediator_send"&&n.target==="GetCourseSubjectQuery"),JSON.stringify({nodes:trace.nodes.map(n=>({id:n.id,kind:n.kind,name:n.name,target:n.target})),edges:trace.edges.slice(0,15)}));
  assert.ok(trace.nodes.some(n=>n.kind==="cqrs_handler"&&n.name.endsWith("GetCourseSubjectQueryHandler")));
  assert.ok(trace.edges.some(e=>e.kind==="http_action"&&e.status==="inferred"),"Tokenized [controller] expansion is an inferred route convention.");
  assert.ok(trace.edges.some(e=>e.kind==="mediator_handler_candidate"&&e.status==="inferred"));
  const dotnet=await engine.csharpSearch({projectId:"csharp-p4",query:"SampleDbContext",kinds:["ef_context"]});
  assert.ok(dotnet.results.length>0);
  const dbset=await engine.csharpSearch({projectId:"csharp-p4",query:"CourseSubjects",kinds:["ef_dbset"]});
  assert.ok(dbset.results.some(n=>n.target==="CourseSubject"));
  const store=await openExistingIndex(path.join(stateRoot,"index"),"csharp-p4");
  assert.equal(store.prepare("PRAGMA user_version").get().user_version,4);
  assert.equal(store.prepare("PRAGMA integrity_check").get().integrity_check,"ok");
  store.close();
}));
test("indexed Roslyn method reference follows exact declaration path and signature location",async()=>withProject(async({registry,csharp})=>{
  await writeFile(path.join(csharp,"Api","DemoWorker.cs"),
    "namespace Demo; public class Worker { public void Execute() {} }");
  await writeFile(path.join(csharp,"Api","DemoCaller.cs"),
    "namespace Demo; public class Caller { public void Run() { new Worker().Execute(); } }");
  const engine=createIndexEngine({registry});
  const status=await index(engine,"full");
  assert.equal(status.job.state,"completed",JSON.stringify(status.job.error));
  const graph=await engine.evidenceGraph({projectId:"csharp-p4",
    query:"Demo.Worker@Execute",repoIds:["training-csharp"],
    languages:["csharp"],direction:"both",maxDepth:4,maxNodes:38});
  assert.ok(graph.nodes.some(x=>x.name==="Demo.Caller@Run"),JSON.stringify(graph.nodes.map(x=>x.name)));
  assert.ok(graph.edges.some(x=>x.kind==="references_resolved_method"&&
    x.status==="verified_static"),JSON.stringify(graph.edges.map(x=>x.kind)));
  assert.ok(!graph.edges.some(x=>x.status==="verified_runtime"));
}));
test("Incremental source deletion and renamed controller make stale facts unusable",async()=>withProject(async({registry,csharp})=>{
  const engine=createIndexEngine({registry});
  assert.equal((await index(engine,"full")).job.state,"completed");
  const unchanged=await index(engine);
  assert.equal(unchanged.index.changed,0);
  assert.equal(unchanged.job.progress.csharpParsed,0);
  const file=path.join(csharp,"Api","CourseSubjectsController.cs");
  await writeFile(file,(await readFile(file,"utf8")).replace("GetById(","FindById("));
  const stale=await engine.csharpSearch({projectId:"csharp-p4",query:"CourseSubjectsController@GetById",kinds:["controller_method"]});
  assert.ok(stale.results.some(f=>f.freshness==="stale_or_unavailable"&&f.details===null));
  const updated=await index(engine);
  assert.equal(updated.job.state,"completed");
  assert.equal(updated.index.changed,1);
  assert.equal(updated.job.progress.csharpParsed,1);
  const links=await engine.trace({projectId:"csharp-p4",query:"GET /api/CourseSubjects/{id}",language:"csharp"});
  assert.ok(links.edges.some(e=>e.kind==="http_action"&&e.targetLabel?.endsWith("@FindById")));
  await unlink(path.join(csharp,"Infrastructure","CourseSubjectConfiguration.cs"));
  const deleted=await index(engine);
  assert.equal(deleted.job.state,"completed");
  assert.equal(deleted.index.removed,1);
}));
test("Cross-language compare is candidates-only, never claims migration or API equivalence",async()=>withProject(async({registry})=>{
  const engine=createIndexEngine({registry});
  const status=await index(engine,"full");
  assert.equal(status.job.state,"completed",JSON.stringify(status.job.error));
  const compared=await engine.compare({projectId:"csharp-p4",query:"course books",limit:10});
  assert.equal(compared.mappingStatus,"not_verified");
  assert.deepEqual(compared.verifiedCrossRepositoryLinks,[]);
  assert.ok(compared.phpCandidates.length>0);
  const absent=await engine.csharpSearch({projectId:"csharp-p4",query:"GET /admin/course-books/phones",kinds:["endpoint"]});
  assert.equal(absent.results.length,0);
  const handler=createCodebaseIntelligenceHandler({registry,engine});
  const c=await handler("openclaw_codebase_intelligence",{action:"csharp",operation:"find",projectId:"csharp-p4",query:"DbContext"});
  assert.equal(c.structuredContent.ok,true);
  const cmp=await handler("openclaw_codebase_intelligence",{action:"compare",projectId:"csharp-p4",query:"course books"});
  assert.equal(cmp.structuredContent.comparison.mappingStatus,"not_verified");
  const trace=await handler("openclaw_codebase_intelligence",{action:"trace",language:"csharp",projectId:"csharp-p4",query:"GET /api/CourseSubjects/{id}"});
  assert.ok(trace.structuredContent.trace.nodes.length>0);
},{includePhp:true}));
test("Invalid C# source records parse error; no fake endpoint facts",async()=>withProject(async({registry,csharp})=>{
  await writeFile(path.join(csharp,"Api","BrokenController.cs"),"public class BrokenController { [HttpGet] void X( }");
  const engine=createIndexEngine({registry});
  const res=await index(engine,"full");
  assert.equal(res.job.state,"completed",JSON.stringify(res.job.error));
  assert.ok(res.index.csharp.parseErrors>=1);
  const found=await engine.csharpSearch({projectId:"csharp-p4",query:"BrokenController",kinds:["controller"]});
  assert.equal(found.results.length,0);
}));
