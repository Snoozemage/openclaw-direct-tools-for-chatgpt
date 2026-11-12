import test from "node:test";
import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {mkdtemp,mkdir,cp,readFile,writeFile,rm,symlink,stat,unlink} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {createProjectRegistry} from "../src/tools/codebase-intelligence/registry.mjs";
import {createIndexEngine} from "../src/tools/codebase-intelligence/engine.mjs";
import {createCodebaseIntelligenceHandler} from "../src/tools/codebase-intelligence/handler.mjs";
import {openExistingIndex} from "../src/tools/codebase-intelligence/store.mjs";

const fixtures=path.join(path.dirname(fileURLToPath(import.meta.url)),"fixtures");
const projectId="hardening-p8";
async function withRepo(cb,{php=true,csharp=true,typescript=true}={}){
  const dir=await mkdtemp(path.join(os.tmpdir(),"openclaw-p8-")),stateRoot=path.join(dir,"state");
  const specs=[["legacy-php","codebase-php","php"],["training-csharp","codebase-csharp","csharp"],
    ["training-ts","codebase-typescript","typescript"]].filter(([, ,lang])=>
      ({php,csharp,typescript})[lang]);
  const repositories=[],roots=new Map();
  try{
    await mkdir(stateRoot);
    for(const [id,fixture,lang] of specs){
      const root=path.join(dir,id);
      await cp(path.join(fixtures,fixture),root,{recursive:true});
      execFileSync("git",["init","-q",root],{timeout:5000,windowsHide:true});
      repositories.push({id,root,languages:[lang]});roots.set(id,root);
    }
    const scopePath=path.join(stateRoot,"scope.json");
    await writeFile(scopePath,JSON.stringify({version:1,allowedRoots:repositories.map(x=>x.root)}));
    const registry=createProjectRegistry({stateRoot,scopePath});
    await registry.register({projectId,repositories});
    const engine=createIndexEngine({registry});
    async function index(mode="incremental",instance=engine){
      const started=await instance.index({projectId,mode});
      assert.equal(started.accepted,true);
      for(let i=0;i<550;i++){
        const s=await instance.status(projectId,started.job.jobId);
        if(["completed","failed","cancelled"].includes(s.job.state))return s;
        await new Promise(r=>setTimeout(r,23));
      }
      throw Error("P8 test index timeout");
    }
    await cb({dir,stateRoot,roots,registry,engine,index});
  }finally{await rm(dir,{recursive:true,force:true,maxRetries:9,retryDelay:175});}
}
test("P8 git status check explicitly flags branch/HEAD drift and incremental fixes snapshot",async()=>withRepo(async({roots,engine,index,registry})=>{
  const ts=roots.get("training-ts");
  execFileSync("git",["-C",ts,"add","."],{windowsHide:true});
  execFileSync("git",["-C",ts,"-c","user.name=Fixture",
    "-c","user.email=test@example.com","commit","-qm","baseline"],{windowsHide:true});
  const first=await index("full");
  assert.equal(first.job.state,"completed",JSON.stringify(first.job.error));
  const before=await engine.status(projectId,undefined,{checkWorktree:true});
  assert.ok(before.index.gitSnapshotDrift.every(x=>!x.drift));
  execFileSync("git",["-C",ts,"switch","-q","-c","feat/source-updated"],{windowsHide:true});
  const changed=await engine.status(projectId,undefined,{checkWorktree:true});
  assert.ok(changed.index.gitSnapshotDrift.some(x=>x.repoId==="training-ts"&&
    x.reasons.includes("branch_changed")));
  assert.equal(changed.index.snapshotRefreshRecommended,true);
  const handler=createCodebaseIntelligenceHandler({registry,engine});
  const via=await handler("openclaw_codebase_intelligence",{action:"status",projectId,checkWorktree:true});
  assert.equal(via.structuredContent.status.index.snapshotRefreshRecommended,true);
  const next=await index();
  assert.equal(next.job.state,"completed");
  const verified=await engine.status(projectId,undefined,{checkWorktree:true});
  assert.ok(verified.index.gitSnapshotDrift.every(x=>!x.drift));
}));
test("P8 dirty TS config, C# route, PHP migration and source deletion reconcile after incremental",async()=>withRepo(async({roots,engine,index})=>{
  const initial=await index("full");
  assert.equal(initial.job.state,"completed",JSON.stringify(initial.job.error));
  const ts=roots.get("training-ts"),cs=roots.get("training-csharp"),php=roots.get("legacy-php");
  const tsconfig=path.join(ts,"tsconfig.json");
  const tsOriginal=await readFile(tsconfig,"utf8");
  await writeFile(tsconfig,tsOriginal.replace('"@/*"','"~/*"'));
  const csFile=path.join(cs,"Api","CourseSubjectsController.cs");
  const csOriginal=await readFile(csFile,"utf8");
  await writeFile(csFile,csOriginal.replace('[Route("api/[controller]")]',
    '[Route("api/v8/[controller]")]'));
  const phpFile=path.join(php,"database","migrations","2026_11_12_000000_create_course_subjects.php");
  const phpOriginal=await readFile(phpFile,"utf8");
  await writeFile(phpFile,phpOriginal.replace("course_subjects","cohort_course_subjects"));
  await unlink(path.join(ts,"src","services","reexports.ts"));
  // Additional dirty worktree file changes must be caught even if Git HEAD is unchanged.
  const stale=await engine.status(projectId,undefined,{checkWorktree:true});
  assert.equal(stale.index.snapshotRefreshRecommended,false);
  const second=await index();
  assert.equal(second.job.state,"completed",JSON.stringify(second.job.error));
  assert.ok(second.index.changed>=3);
  assert.ok(second.index.removed>=1,"Deleted TS source must be removed from index.");
  const route=await engine.csharpSearch({projectId,query:"v8",limit:20});
  assert.ok(route.results.some(x=>x.name?.includes("v8")||JSON.stringify(x.details).includes("v8")));
  const tsTrace=await engine.trace({projectId,language:"typescript",query:"teachingDevicesService",maxDepth:7});
  assert.ok(!tsTrace.edges.some(e=>e.kind==="active_mock_binding"&&e.status==="verified_static"),
    "Removing a configured @ alias cannot remain verified_static.");
  const phpFind=await engine.phpSearch({projectId,query:"cohort_course_subjects",limit:20});
  assert.ok(phpFind.results.length>0);
}));
test("P8 limited index, transaction rollback and missing parser are isolated from prior good revision",async()=>withRepo(async({registry,engine,index,stateRoot})=>{
  const before=await index("full");
  assert.equal(before.job.state,"completed");
  const tooSmall=createIndexEngine({registry,limits:{
    maxFiles:1,maxFileBytes:2*1024*1024,maxSourceBytes:10*1024*1024,
    maxChunks:45000,maxChunkChars:1600,maxJobMs:300000,
  }});
  const limited=await index("incremental",tooSmall);
  assert.equal(limited.job.state,"failed");
  assert.equal(limited.job.error.code,"INDEX_LIMIT_EXCEEDED");
  const failCommit=createIndexEngine({registry,beforeCommit:()=>{throw Error("injected_failure");}});
  const stopped=await index("incremental",failCommit);
  assert.equal(stopped.job.state,"failed");
  assert.equal(stopped.job.error.code,"INDEX_FAILED");
  const after=await engine.status(projectId);
  assert.equal(after.index.revision,before.index.revision);
  const db=await openExistingIndex(path.join(stateRoot,"index"),projectId);
  assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check,"ok");db.close();
}));
test("P8 corrupt SQLite read rejects instead of trusting fake index",async()=>withRepo(async({stateRoot,engine})=>{
  const dir=path.join(stateRoot,"index");await mkdir(dir);
  await writeFile(path.join(dir,projectId+".sqlite"),"not a SQLite database");
  await assert.rejects(engine.status(projectId),e=>
    ["INDEX_STORAGE_ERROR","INDEX_SCHEMA_UNSUPPORTED"].includes(e.code));
},{php:false,csharp:false}));
test("P8 symlink source escape is never indexed and secret content excluded",async()=>withRepo(async({roots,registry})=>{
  const ts=roots.get("training-ts"),outside=path.join(ts,"..","outside-p8.txt");
  await writeFile(outside,"SENSITIVE_OUTSIDE_WILL_NOT_APPEAR");
  await writeFile(path.join(ts,".env.local"),"PASSWORD=EXCLUDED_SECRET\n");
  try{await symlink(outside,path.join(ts,"src","outside.ts"),"file");}catch(e){
    if(!["EPERM","EACCES","ENOTSUP"].includes(e.code))throw e;
  }
  const {scanProject}=await import("../src/tools/codebase-intelligence/scanner.mjs");
  const project=await registry.ensureProjectAllowed(projectId);
  const scan=await scanProject(project);
  assert.ok(!scan.files.some(x=>x.relativePath.includes("outside.ts")||x.relativePath.includes(".env.local")));
},{php:false,csharp:false}));
