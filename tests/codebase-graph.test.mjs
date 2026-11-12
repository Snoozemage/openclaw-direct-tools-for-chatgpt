import test from "node:test";
import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {mkdtemp,mkdir,cp,writeFile,readFile,rm} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {createProjectRegistry} from "../src/tools/codebase-intelligence/registry.mjs";
import {createIndexEngine} from "../src/tools/codebase-intelligence/engine.mjs";
import {createCodebaseIntelligenceHandler} from "../src/tools/codebase-intelligence/handler.mjs";
import {openExistingIndex} from "../src/tools/codebase-intelligence/store.mjs";
import {projectC4FromGraph} from "../src/tools/codebase-intelligence/graph-projector.mjs";

const fixtures=path.join(path.dirname(fileURLToPath(import.meta.url)),"fixtures");
async function withProject(cb){
  const dir=await mkdtemp(path.join(os.tmpdir(),"openclaw-p6-")),tsRepo=path.join(dir,"ts"),
    csRepo=path.join(dir,"cs"),stateRoot=path.join(dir,"state");
  try{
    for(const d of [tsRepo,csRepo,stateRoot])await mkdir(d);
    await cp(path.join(fixtures,"codebase-typescript"),tsRepo,{recursive:true});
    await cp(path.join(fixtures,"codebase-csharp"),csRepo,{recursive:true});
    for(const p of [tsRepo,csRepo])execFileSync("git",["init","-q",p],{timeout:5000,windowsHide:true});
    const registry=createProjectRegistry({stateRoot});
    await registry.register({projectId:"graph-p6",name:"Fixture Training",repositories:[
      {id:"training-ts",root:tsRepo,languages:["typescript"]},
      {id:"training-csharp",root:csRepo,languages:["csharp","sql"]},
    ]});
    const engine=createIndexEngine({registry});
    async function index(mode="incremental"){
      const req=await engine.index({projectId:"graph-p6",mode});
      assert.equal(req.accepted,true);
      for(let i=0;i<420;i++){
        const res=await engine.status("graph-p6",req.job.jobId);
        if(["completed","failed","cancelled"].includes(res.job.state)){
          assert.equal(res.job.state,"completed",JSON.stringify(res.job.error));
          return res;
        }
        await new Promise(r=>setTimeout(r,25));
      }
      throw Error("Graph index timed out");
    }
    await index("full");
    await cb({engine,registry,stateRoot,tsRepo,csRepo,index});
  }finally{await rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:180});}
}
const pid="graph-p6";
test("P6 source graph stable IDs, revision, evidence, named root and no ghost cross-repo link",async()=>withProject(async({engine,index})=>{
  const first=await engine.evidenceGraph({projectId:pid,query:"/teaching-devices",maxDepth:7,maxNodes:70,limit:1});
  assert.equal(first.roots.length,1);
  assert.ok(first.nodes.every(x=>x.indexRevision===first.indexRevision&&
    x.provenance.sha256&&x.freshness==="verified_current_hash"));
  assert.ok(first.edges.every(e=>first.nodes.some(x=>x.stableId===e.fromId)&&
    first.nodes.some(x=>x.stableId===e.toId)));
  assert.ok(first.edges.every(e=>e.evidence?.repoId));
  assert.equal(first.nodes.some(x=>x.language==="csharp"),false);
  const oldIds=first.nodes.map(x=>x.stableId).sort();
  const next=await index();
  assert.equal(next.index.changed,0);
  const second=await engine.evidenceGraph({projectId:pid,query:"/teaching-devices",maxDepth:7,maxNodes:70,limit:1});
  assert.ok(second.indexRevision>first.indexRevision);
  assert.deepEqual(second.nodes.map(x=>x.stableId).sort(),oldIds);
  assert.deepEqual(second.edges.map(x=>x.stableId).sort(),first.edges.map(x=>x.stableId).sort());
}));
test("P6 source-verified mock route graph and upstream impact only includes dependent files",async()=>withProject(async({engine})=>{
  const g=await engine.evidenceGraph({projectId:pid,query:"/teaching-devices",limit:1,maxDepth:8,maxNodes:80});
  assert.ok(g.nodes.some(x=>x.kind==="export_binding"&&x.name==="teachingDevicesService"));
  assert.ok(g.edges.some(x=>x.kind==="active_mock_binding"&&x.status==="verified_static"));
  assert.equal(g.truncated,false);
  const impact=await engine.impact({projectId:pid,query:"teachingDevicesService",
    direction:"upstream",limit:1,maxDepth:7,maxNodes:75});
  assert.ok(impact.direct.length+impact.indirect.length>0);
  assert.ok(impact.impactedFiles.some(x=>x.relativePath.includes("teaching-devices-view.tsx")));
  assert.ok(impact.impactedFiles.every(x=>x.relativePath!=="src/services/teaching-devices.service.ts"));
  assert.ok(impact.impactedFiles.every(x=>x.reason.includes("(verified_static)")||
    x.status==="potential_inferred"));
  const other=await engine.impact({projectId:pid,query:"teachingDevicesService",
    direction:"downstream",limit:1,maxDepth:7,maxNodes:75});
  assert.ok(other.impactedFiles.some(x=>x.relativePath.includes("mocks/teaching-devices.mock-service.ts")));
}));
test("P6 C1/C2 are deliberately incomplete without curated actors/runtime topology",async()=>withProject(async({engine})=>{
  const c1=await engine.architecture({projectId:pid,level:"C1"});
  assert.equal(c1.nodes.length,1);
  assert.equal(c1.edges.length,0);
  assert.equal(c1.mode,"system_context_incomplete");
  assert.ok(c1.missingEvidence.length>0);
  assert.ok(!c1.mermaid.includes("Masterdata"));
  const c2=await engine.architecture({projectId:pid,level:"C2",query:"teaching devices"});
  assert.equal(c2.nodes.length,2,"C# four layers must not create four C2 containers");
  assert.equal(c2.edges.length,0,"selected mock adapter must not produce a deployed FE→BE arrow");
  assert.ok(c2.nodes.every(n=>n.status==="deployment_unverified"));
  assert.ok(c2.nodes.some(n=>n.kind==="aspnet_web_project"));
  assert.ok(c2.nodes.some(n=>n.kind==="nextjs_package"));
  assert.ok(!c2.nodes.some(n=>n.name.includes("Application")),"Domain/Application/Infrastructure class libraries are not containers.");
  assert.equal(c2.activeMockAdapters.length,1);
  assert.ok(c2.dataFlowBreaks.some(b=>b.kind==="selected_mock_adapter"));
  assert.deepEqual(c2.verifiedRuntimeLinks,[]);
  const http=await engine.architecture({projectId:pid,level:"C2",query:"CourseSubjects",limit:3});
  assert.ok(http.edges.length>=1,"HTTP contract candidate uses actual API web assembly mapping.");
  assert.ok(http.edges.every(e=>e.status==="inferred"&&e.kind==="static_http_contract_candidate"));
  assert.deepEqual(http.verifiedRuntimeLinks,[]);
}));
test("P6 C3 grouped feature candidates and C4 Mermaid only renders verified evidence edges",async()=>withProject(async({engine,registry})=>{
  const c3=await engine.architecture({projectId:pid,level:"C3",query:"/teaching-devices",
    limit:1,maxDepth:8,maxNodes:70});
  assert.ok(c3.nodes.some(n=>n.label==="Feature teaching-devices"));
  assert.equal(c3.mode,"logical_component_candidates");
  assert.ok(c3.nodes.every(n=>n.status==="logical_source_group_needs_review"));
  const c4=await engine.architecture({projectId:pid,level:"C4",query:"teachingDevicesService",
    limit:1,maxDepth:7,maxNodes:65});
  assert.equal(c4.mode,"static_code_view");
  assert.ok(c4.mermaid.startsWith("flowchart LR"));
  assert.ok(c4.edges.some(e=>e.kind==="active_mock_binding"&&e.status==="verified_static"));
  assert.ok(c4.edges.every(e=>c4.nodes.some(n=>n.stableId===e.fromId)&&
    c4.nodes.some(n=>n.stableId===e.toId)));
  const fake={nodes:[{
    stableId:"id1",name:'symbol"]\nEVIL-->INJECT',kind:"symbol",language:"typescript",
    repoId:"training-ts",provenance:{repoId:"training-ts",relativePath:"x.ts",startLine:1}}],edges:[],gaps:[],
    truncated:false};
  const markdown=projectC4FromGraph(fake,{level:"C4"}).mermaid;
  assert.ok(!markdown.includes("\nEVIL-->INJECT"));
  const handler=createCodebaseIntelligenceHandler({registry,engine});
  const res=await handler("openclaw_codebase_intelligence",{
    action:"architecture",projectId:pid,level:"C4",query:"teachingDevicesService",limit:1});
  assert.equal(res.structuredContent.ok,true);
  assert.ok(res.structuredContent.architecture.mermaid.startsWith("flowchart LR"));
  const unified=await handler("openclaw_codebase_intelligence",{action:"trace",language:"all",
    projectId:pid,query:"/teaching-devices",direction:"downstream",limit:1,maxDepth:7,maxNodes:70});
  assert.equal(unified.structuredContent.ok,true);
  assert.ok(unified.structuredContent.trace.nodes.length>4);
  const changed=await handler("openclaw_codebase_intelligence",{action:"impact",
    projectId:pid,query:"teachingDevicesService",direction:"upstream",limit:1});
  assert.equal(changed.structuredContent.ok,true);
  assert.ok(changed.structuredContent.impact.impactedFiles.length>0);
  const denied=await handler("openclaw_codebase_intelligence",{
    action:"architecture",projectId:pid,level:"C4"});
  assert.equal(denied.structuredContent.ok,false);
}));
test("P6 C1 optionally loads curated metadata only with live indexed source-line evidence",async()=>withProject(async({engine,stateRoot,tsRepo})=>{
  const dir=path.join(stateRoot,"contexts");
  await mkdir(dir,{recursive:true});
  const config=path.join(dir,pid+".json");
  const source={repoId:"training-ts",relativePath:"src/configs/env.config.ts",
    line:1,identifier:"NEXT_PUBLIC_API_URL"};
  await writeFile(config,JSON.stringify({version:1,projectId:pid,
    actors:[{id:"academic-operator",label:"Academic Operator"}],
    externalSystems:[{id:"remote-catalog",label:"External API candidate",source}],
    relationships:[{from:"system",to:"remote-catalog",
      label:"Possible catalog lookup",source}]}));
  const good=await engine.architecture({projectId:pid,level:"C1"});
  assert.equal(good.contextStatus,"curated_source_references");
  assert.equal(good.nodes.length,3);
  assert.equal(good.edges.length,1);
  assert.equal(good.edges[0].status,"inferred");
  assert.ok(!good.nodes.some(n=>n.status==="verified_runtime"));
  // A newer source makes the supplied reference stale; fail closed with no ghost edge.
  const file=path.join(tsRepo,"src","configs","env.config.ts");
  await writeFile(file,(await readFile(file,"utf8")).replace("NEXT_PUBLIC_API_URL","NEXT_PUBLIC_OTHER_URL"));
  const stale=await engine.architecture({projectId:pid,level:"C1"});
  assert.equal(stale.nodes.length,2);
  assert.equal(stale.edges.length,0);
  assert.ok(stale.missingEvidence.some(x=>x.includes("omitted")));
}));
test("P6 cycles and node/depth budget terminate without claiming unknown runtime edges",async()=>withProject(async({engine,tsRepo,index})=>{
  await mkdir(path.join(tsRepo,"src","cycles"),{recursive:true});
  await writeFile(path.join(tsRepo,"src","cycles","a.ts"),
    "import { b } from './b';\nexport const uniqueCycleA = b;\n");
  await writeFile(path.join(tsRepo,"src","cycles","b.ts"),
    "import { uniqueCycleA } from './a';\nexport const b = uniqueCycleA;\n");
  await index();
  const g=await engine.evidenceGraph({projectId:pid,query:"src/cycles/a.ts",
    maxDepth:8,maxNodes:40,limit:1,languages:["typescript"]});
  assert.ok(g.nodes.length<=40);
  assert.ok(g.edges.every(e=>e.fromId&&e.toId));
  assert.ok(g.cycleCount>=1,"cyclic static module imports should be counted");
  const short=await engine.evidenceGraph({projectId:pid,query:"src/cycles/a.ts",
    maxDepth:2,maxNodes:8,limit:1,languages:["typescript"]});
  assert.ok(short.nodes.length<=8);
  assert.ok(short.edges.every(e=>e.status!=="verified_runtime"));
}));
test("P6 stale evidence removed from Mermaid/impact, reindex recovers",async()=>withProject(async({engine,tsRepo,index})=>{
  const file=path.join(tsRepo,"src","services","teaching-devices.service.ts");
  const original=await readFile(file,"utf8");
  await writeFile(file,original.replace("mockTeachingDevicesService;","mockTeachingDevicesService ?? {};"));
  const stale=await engine.architecture({projectId:pid,level:"C4",
    query:"teachingDevicesService",limit:1,maxDepth:7,maxNodes:65});
  assert.ok(stale.stale.length>=1);
  assert.equal(stale.nodes.some(n=>n.type==="export_binding"&&n.label==="teachingDevicesService"),false);
  assert.ok(stale.edges.every(e=>stale.nodes.some(n=>n.stableId===e.fromId)&&stale.nodes.some(n=>n.stableId===e.toId)));
  await index();
  const fresh=await engine.architecture({projectId:pid,level:"C4",
    query:"teachingDevicesService",limit:1,maxDepth:7,maxNodes:65});
  assert.equal(fresh.stale.length,0);
  assert.ok(fresh.nodes.some(n=>n.type==="export_binding"&&n.label==="teachingDevicesService"));
}));
test("P6 impact suggests only existing indexed test filenames, never claims coverage",async()=>withProject(async({engine,tsRepo,index})=>{
  const testDir=path.join(tsRepo,"src","features","teaching-devices");
  await writeFile(path.join(testDir,"teaching-devices.spec.ts"),"export const smokeTest = true;\n");
  await index();
  const impact=await engine.impact({projectId:pid,query:"teaching devices",limit:2});
  assert.ok(impact.existingTestCandidates.some(x=>x.relativePath.endsWith("teaching-devices.spec.ts")));
  assert.ok(impact.existingTestCandidates.every(x=>x.status==="test_file_name_candidate_only"&&
    x.freshness==="verified_current_hash"));
  assert.equal(impact.testCoverage,"not_verified_source_filename_matches_only");
}));
test("P6 missing C# route, dynamic URL and multiple candidates never form a verified runtime edge",async()=>withProject(async({engine,csRepo,index})=>{
  const no=await engine.architecture({projectId:pid,level:"C2",query:"teaching devices"});
  assert.equal(no.edges.length,0);
  const dyn=await engine.matchFrontendBackend({projectId:pid,query:"courses",limit:10});
  assert.deepEqual(dyn.verifiedRuntimeLinks,[]);
  await writeFile(path.join(csRepo,"Api","DuplicateCourseSubjectController.cs"),
    'using Microsoft.AspNetCore.Mvc;\n[Route("api/CourseSubjects")]\npublic class DuplicateCourseSubjectController : ControllerBase { [HttpGet("{id}")] public object Get(Guid id) => new {}; }\n');
  await index();
  const candidate=await engine.matchFrontendBackend({projectId:pid,query:"CourseSubjects",limit:10});
  assert.ok(candidate.matchedContracts.length>=2);
  assert.ok(candidate.matchedContracts.every(c=>c.status!=="verified_runtime"));
  const c2=await engine.architecture({projectId:pid,level:"C2",query:"CourseSubjects",limit:10});
  assert.ok(c2.edges.every(e=>e.status==="inferred"));
}));
