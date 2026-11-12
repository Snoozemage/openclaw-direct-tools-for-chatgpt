import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, cp, writeFile, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createProjectRegistry } from "../src/tools/codebase-intelligence/registry.mjs";
import { createIndexEngine } from "../src/tools/codebase-intelligence/engine.mjs";
import { openExistingIndex } from "../src/tools/codebase-intelligence/store.mjs";
import { createCodebaseIntelligenceHandler } from "../src/tools/codebase-intelligence/handler.mjs";

const fixtureRoot=path.join(path.dirname(fileURLToPath(import.meta.url)),"fixtures","codebase-php");

async function withProject(callback) {
  const root=await mkdtemp(path.join(os.tmpdir(),"openclaw-php-index-"));
  const repo=path.join(root,"repo");
  const stateRoot=path.join(root,"state");
  await mkdir(repo); await mkdir(stateRoot);
  try {
    await cp(fixtureRoot,repo,{recursive:true});
    execFileSync("git",["init","-q",repo],{timeout:5000,windowsHide:true});
    const scopePath=path.join(stateRoot,"scope.json");
    await writeFile(scopePath,JSON.stringify({version:1,allowedRoots:[repo]}));
    const registry=createProjectRegistry({stateRoot,scopePath});
    await registry.register({projectId:"php-pilot",repositories:[
      {id:"legacy-php",root:repo,languages:["php","sql"]},
    ]});
    await callback({root,repo,stateRoot,registry});
  } finally { await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:150}); }
}
async function finish(engine,mode="incremental") {
  const started=await engine.index({projectId:"php-pilot",mode});
  assert.equal(started.accepted,true);
  for(let i=0;i<350;i++) {
    const status=await engine.status("php-pilot",started.job.jobId);
    if(["completed","failed","cancelled"].includes(status.job.state))return status;
    await new Promise(r=>setTimeout(r,20));
  }
  throw Error("PHP fixture index did not finish");
}
test("PHP AST index stores routes/models/migrations and connects static evidence only",async()=>withProject(async({registry,stateRoot})=>{
  const engine=createIndexEngine({registry});
  const status=await finish(engine,"full");
  assert.equal(status.job.state,"completed",JSON.stringify(status.job.error));
  assert.ok(status.index.php.facts>=20,JSON.stringify(status.index.php));
  assert.ok(status.index.php.edges>3);
  assert.equal(status.index.php.parseErrors,0);
  const routes=await engine.phpSearch({projectId:"php-pilot",query:"GET /admin/course-books/phones",kinds:["route"]});
  const exact=routes.results.find(x=>x.name==="GET /admin/course-books/phones");
  assert.ok(exact,JSON.stringify(routes.results.slice(0,4)));
  assert.equal(exact.target,"App\\Http\\Controllers\\CourseBooksController@phoneIndex");
  assert.equal(exact.freshness,"verified_current_hash");
  const look=await engine.phpSearch({projectId:"php-pilot",query:"tín chỉ",limit:30});
  assert.ok(look.results.some(x=>x.kind==="model_field"&&x.name==="credit"),
    JSON.stringify(look.results.slice(0,8)));

  const t=await engine.trace({projectId:"php-pilot",query:"GET /admin/course-books/phones"});
  const names=t.nodes.map(n=>n.name);
  assert.ok(names.includes("GET /admin/course-books/phones"));
  assert.ok(names.includes("App\\Http\\Controllers\\CourseBooksController@phoneIndex"),JSON.stringify(names));
  assert.ok(names.some(name=>name.includes("CourseSubject")),JSON.stringify(names));
  assert.ok(t.edges.some(e=>e.kind==="route_handler"&&e.status==="verified_static"));
  assert.ok(t.edges.some(e=>e.kind==="references_model_class"&&e.status==="inferred"));
  assert.ok(t.nodes.some(n=>n.kind==="view_render" && n.target==="resources/views/course_books/phones.blade.php"));
  assert.ok(t.nodes.some(n=>n.kind==="view_file" && n.relativePath.endsWith("phones.blade.php")));
  assert.ok(t.edges.some(e=>e.kind==="candidate_view_path" && e.status==="inferred"));
  const dbOperation=await engine.phpSearch({projectId:"php-pilot",query:"course_subjects",kinds:["table_operation"]});
  assert.ok(dbOperation.results.some(x=>x.details.operation==="update"));
  assert.ok(t.limitations.some(x=>x.includes("credit grain")));
  const blade=await engine.phpSearch({projectId:"php-pilot",query:"admin.course-books.phones",kinds:["blade_route_reference"]});
  assert.ok(blade.results.some(x=>x.relativePath.endsWith("phones.blade.php")));
  const fromUi=await engine.trace({projectId:"php-pilot",query:"admin.course-books.phones",limit:1});
  assert.ok(fromUi.edges.some(e=>e.kind==="named_route_reference"&&e.status==="inferred"));
  assert.ok(fromUi.edges.some(e=>e.kind==="route_handler"&&e.status==="verified_static"));

  const db=await openExistingIndex(path.join(stateRoot,"index"),"php-pilot");
  assert.equal(db.prepare("PRAGMA user_version").get().user_version,4);
  assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check,"ok");
  db.close();
}));
test("PHP AST metadata persists, incremental detects source changes and invalidates old edges",async()=>withProject(async({registry,repo})=>{
  const engine=createIndexEngine({registry});
  const first=await finish(engine,"full");
  assert.equal(first.job.state,"completed",JSON.stringify(first.job.error));
  const unchanged=await finish(engine);
  assert.equal(unchanged.job.state,"completed");
  assert.equal(unchanged.index.changed,0);
  assert.equal(unchanged.job.progress.phpParsed,0);
  const controller=path.join(repo,"app","Http","Controllers","CourseBooksController.php");
  const initial=await readFile(controller,"utf8");
  await writeFile(controller,initial.replace("function phoneIndex()","function phoneIndexRenamed()"));
  const stale=await engine.phpSearch({projectId:"php-pilot",query:"phoneIndex",kinds:["method"]});
  assert.ok(stale.results.some(x=>x.freshness==="stale_or_unavailable" && x.details===null));

  const next=await finish(engine);
  assert.equal(next.job.state,"completed");
  assert.equal(next.index.changed,1);
  assert.equal(next.job.progress.phpParsed,1);
  const after=await engine.trace({projectId:"php-pilot",query:"GET /admin/course-books/phones"});
  assert.ok(after.edges.some(e=>e.kind==="route_handler" && e.status==="unresolved"));
  assert.ok(!after.nodes.some(n=>n.name.endsWith("@phoneIndex")));
  const newMethod=await engine.phpSearch({projectId:"php-pilot",query:"phoneIndexRenamed",kinds:["method"]});
  assert.equal(newMethod.results[0].freshness,"verified_current_hash");
  await unlink(path.join(repo,"app","Models","Course.php"));
  const removed=await finish(engine);
  assert.equal(removed.job.state,"completed");
  assert.equal(removed.index.removed,1);
}));
test("malformed PHP reports parse error without inventing AST facts or breaking FTS",async()=>withProject(async({registry,repo})=>{
  await writeFile(path.join(repo,"app","Models","Broken.php"),"<?php class Broken { function x( }");
  const engine=createIndexEngine({registry});
  const status=await finish(engine,"full");
  assert.equal(status.job.state,"completed",JSON.stringify(status.job.error));
  assert.ok(status.index.php.parseErrors>=1);
  const found=await engine.phpSearch({projectId:"php-pilot",query:"Broken",kinds:["class"]});
  assert.equal(found.results.length,0);
}));
test("MCP single-tool exposes php find and PHP-only trace with evidence",async()=>withProject(async({registry})=>{
  const engine=createIndexEngine({registry});
  assert.equal((await finish(engine,"full")).job.state,"completed");
  const handler=createCodebaseIntelligenceHandler({registry,engine});
  const result=await handler("openclaw_codebase_intelligence",{
    action:"php",operation:"find",projectId:"php-pilot",query:"course books",limit:7
  });
  assert.equal(result.structuredContent.ok,true);
  assert.ok(result.structuredContent.result.results.length>0);
  const trace=await handler("openclaw_codebase_intelligence",{
    action:"trace",projectId:"php-pilot",query:"POST /admin/course-books/phones/batch-update"
  });
  assert.equal(trace.structuredContent.ok,true);
  assert.ok(trace.structuredContent.trace.nodes.length>0);
  const unsupported=await handler("openclaw_codebase_intelligence",{action:"php",operation:"write",projectId:"php-pilot"});
  assert.equal(unsupported.structuredContent.code,"INVALID_OPERATION");
}));
