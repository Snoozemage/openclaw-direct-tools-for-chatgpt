import test from "node:test";
import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {mkdtemp,mkdir,cp,readFile,writeFile,rm,symlink,stat} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {createProjectRegistry} from "../src/tools/codebase-intelligence/registry.mjs";
import {createIndexEngine} from "../src/tools/codebase-intelligence/engine.mjs";
import {createCodebaseIntelligenceHandler} from "../src/tools/codebase-intelligence/handler.mjs";
import {createDocsAdapter} from "../src/tools/codebase-intelligence/docs-adapter.mjs";
import {parseMarkdown} from "../src/tools/codebase-intelligence/docs-index.mjs";
const fixtures=path.join(path.dirname(fileURLToPath(import.meta.url)),"fixtures");
const id="docs-p7";
async function withProject(cb,{writeScope=true}={}){
  const base=await mkdtemp(path.join(os.tmpdir(),"openclaw-docs-p7-"));
  const ts=path.join(base,"ts"),cs=path.join(base,"cs"),state=path.join(base,"state");
  const vault=path.join(base,"Obsidian Vault"),manual=path.join(vault,"Manual");
  const generated=path.join(vault,"Generated","Codebase Intelligence"),outside=path.join(base,"outside");
  try{
    for(const p of [ts,cs,state,manual,outside])await mkdir(p,{recursive:true});
    await cp(path.join(fixtures,"codebase-typescript"),ts,{recursive:true});
    await cp(path.join(fixtures,"codebase-csharp"),cs,{recursive:true});
    for(const p of [ts,cs])execFileSync("git",["init","-q",p],{windowsHide:true,timeout:5000});
    const scopePath=path.join(state,"scope.json");
    await writeFile(scopePath,JSON.stringify({version:1,allowedRoots:[ts,cs]}));
    const registry=createProjectRegistry({stateRoot:state,scopePath});
    await registry.register({projectId:id,repositories:[
      {id:"training-ts",root:ts,languages:["typescript"]},
      {id:"training-csharp",root:cs,languages:["csharp","sql"]},
    ]});
    const engine=createIndexEngine({registry});
    async function sourceIndex(mode="incremental"){
      const req=await engine.index({projectId:id,mode});
      assert.equal(req.accepted,true);
      for(let i=0;i<500;i++){
        const res=await engine.status(id,req.job.jobId);
        if(["completed","failed","cancelled"].includes(res.job.state)){
          assert.equal(res.job.state,"completed",JSON.stringify(res.job.error));return res;
        }
        await new Promise(r=>setTimeout(r,25));
      }
      throw Error("source fixture timeout");
    }
    await sourceIndex("full");
    const note=path.join(manual,"Teaching Devices.md");
    await writeFile(note,[
      "---","title: Teaching Devices Notes","tags:","  - vaa","status: reviewed","updated: 2026-11-12","---",
      "# Teaching Devices Notes","## Adapter",
      "See source src/services/teaching-devices.service.ts",
      "Route src/app/(admin)/teaching-devices/page.tsx",
      "The UI uses teachingDevicesService. See [[Architecture Guide]] and [[Missing Page|Alias]].",
    ].join("\n"));
    await writeFile(path.join(manual,"Architecture Guide.md"),
      "# Architecture Guide\nThis is a manually authored C4 overview.\n");
    const scope={version:1,projects:{[id]:{
      vaultRoot:vault,readRoots:[manual],generatedRoot:writeScope?generated:null,
    }}};
    const scopeConfigPath=path.join(state,"docs-scope.json");
    await writeFile(scopeConfigPath,JSON.stringify(scope));
    const docs=createDocsAdapter({registry,engine});
    const handler=createCodebaseIntelligenceHandler({registry,engine,docs});
    await cb({base,ts,cs,state,vault,manual,generated,outside,note,
      scope,scopeConfigPath,registry,engine,docs,handler,sourceIndex});
  }finally{await rm(base,{recursive:true,force:true,maxRetries:9,retryDelay:160});}
}
const call=(handler,operation,other={})=>
  handler("openclaw_codebase_intelligence",{action:"docs",operation,projectId:id,...other});
test("P7 Markdown parser extracts YAML/heads/wikilinks and source path references as claims",()=>{
  const text="---\ntitle: Example\ntags:\n - vaa\n---\n# Example\n## Module\n"+
    "See [[Related|alias]] and src/services/teaching-devices.service.ts";
  const source=new Map([["src/services/teaching-devices.service.ts",[
    {repoId:"training-ts",relativePath:"src/services/teaching-devices.service.ts",sha256:"sha"},
  ]]]);
  const r=parseMarkdown(text,"Example.md",source);
  assert.equal(r.title,"Example");
  assert.ok(r.tags.includes("vaa"));
  assert.equal(r.headings.length,2);
  assert.equal(r.wikilinks[0].target,"Related");
  assert.equal(r.references[0].status,"indexed_source_reference");
});
test("P7 docs/index and docs/search separate Obsidian claims from fresh indexed source",async()=>withProject(async({handler,docs})=>{
  const indexed=await call(handler,"index");
  assert.equal(indexed.structuredContent.result.notes,2);
  const r=(await call(handler,"search",{query:"teaching devices"})).structuredContent.result;
  assert.equal(r.mode,"document_claims_and_source_evidence");
  const note=r.noteClaims.results.find(n=>n.title==="Teaching Devices Notes");
  assert.ok(note);
  assert.equal(note.documentType,"documentation_claim_not_source_fact");
  assert.ok(note.wikilink.includes("Manual/Teaching Devices"));
  assert.ok(note.sourceReferences.some(x=>x.relativePath==="src/services/teaching-devices.service.ts"&&
    x.sourceFreshness==="verified_current_hash"));
  assert.ok(r.sourceEvidence.results.length>0);
  assert.ok(r.noteBackedSourceReferences.some(x=>
    x.relativePath==="src/services/teaching-devices.service.ts"&&
    x.evidenceType==="verified_source_path_cited_by_note_not_runtime_link"&&
    x.citingNotes.length===1));
  assert.equal((await docs.status({projectId:id})).notes,2);
}));
test("P7 stale manual note hides cached content after edits",async()=>withProject(async({docs,note})=>{
  await docs.index({projectId:id});
  await writeFile(note,"# New human note\nContent changed.\n");
  const r=await docs.search({projectId:id,query:"teaching devices"});
  const x=r.noteClaims.results.find(n=>n.title==="Teaching Devices Notes");
  assert.equal(x.freshness,"stale_note_changed_or_missing");
  assert.equal(x.excerpt,undefined);
  assert.equal(x.sourceReferences,undefined);
}));
test("P7 docs preview provides Mermaid + unified diff, without creating vault files",async()=>withProject(async({handler,generated,note})=>{
  await call(handler,"index");
  const before=await readFile(note);
  const res=await call(handler,"preview",{query:"teachingDevicesService"});
  assert.equal(res.structuredContent.ok,true,JSON.stringify(res.structuredContent));
  const preview=res.structuredContent.result;
  assert.match(preview.previewId,/^[a-f0-9]{40}$/u);
  assert.ok(preview.markdown.includes("generated_by: openclaw_codebase_intelligence"));
  assert.ok(preview.markdown.includes(String.fromCharCode(96).repeat(3)+"mermaid"));
  assert.ok(preview.diff.includes("+++"));
  await assert.rejects(stat(generated),{code:"ENOENT"});
  assert.deepEqual(await readFile(note),before);
  const denied=await call(handler,"apply",{previewId:preview.previewId});
  assert.equal(denied.structuredContent.code,"DOC_APPROVAL_REQUIRED");
}));
test("P7 user-approved apply writes only Generated, repeat is idempotent",async()=>withProject(async({handler,note,generated})=>{
  await call(handler,"index");
  const before=await readFile(note);
  const p=(await call(handler,"preview",{query:"teachingDevicesService"})).structuredContent.result;
  const result=await call(handler,"apply",{previewId:p.previewId,approved:true});
  assert.equal(result.structuredContent.ok,true,JSON.stringify(result.structuredContent));
  assert.equal(result.structuredContent.result.status,"applied_generated_only");
  const target=path.join(generated,"teachingdevicesservice-source-map.md");
  assert.ok((await readFile(target,"utf8")).includes("review_status: unreviewed"));
  const again=await call(handler,"apply",{previewId:p.previewId,approved:true});
  assert.equal(again.structuredContent.result.status,"already_applied");
  assert.deepEqual(await readFile(note),before);
}));
test("P7 manual and manually edited generated notes are never overwritten",async()=>withProject(async({handler,generated})=>{
  await call(handler,"index");
  await mkdir(generated,{recursive:true});
  const target=path.join(generated,"teachingdevicesservice-source-map.md");
  await writeFile(target,"# Human-edited source map\n");
  assert.equal((await call(handler,"preview",{query:"teachingDevicesService"})).structuredContent.code,
    "DOC_OWNERSHIP_VIOLATION");
  await import("node:fs/promises").then(fs=>fs.unlink(target));
  const p=(await call(handler,"preview",{query:"teachingDevicesService"})).structuredContent.result;
  assert.equal((await call(handler,"apply",{previewId:p.previewId,approved:true})).structuredContent.ok,true);
  await writeFile(target,(await readFile(target,"utf8"))+"\n## Manual correction\n");
  assert.equal((await call(handler,"preview",{query:"teachingDevicesService"})).structuredContent.code,
    "DOC_MANUALLY_MODIFIED");
}));
test("P7 source changes after preview reject apply",async()=>withProject(async({docs,ts})=>{
  await docs.index({projectId:id});
  const p=await docs.preview({projectId:id,query:"teachingDevicesService"});
  const file=path.join(ts,"src","services","teaching-devices.service.ts");
  await writeFile(file,(await readFile(file,"utf8"))+"\n// changed after preview\n");
  await assert.rejects(docs.apply({projectId:id,previewId:p.previewId,approved:true}),
    e=>e.code==="SOURCE_CHANGED");
}));
test("P7 revision change after preview rejects apply even when content same",async()=>withProject(async({docs,sourceIndex})=>{
  await docs.index({projectId:id});
  const p=await docs.preview({projectId:id,query:"teachingDevicesService"});
  await sourceIndex();
  await assert.rejects(docs.apply({projectId:id,previewId:p.previewId,approved:true}),
    e=>e.code==="INDEX_CHANGED");
}));
test("P7 linked note changes after preview trigger DOC_CHANGED",async()=>withProject(async({docs,note})=>{
  await docs.index({projectId:id});
  const p=await docs.preview({projectId:id,query:"teachingDevicesService"});
  assert.ok(p.linkedNotes>0);
  await writeFile(note,(await readFile(note,"utf8"))+"\nHuman update.\n");
  await assert.rejects(docs.apply({projectId:id,previewId:p.previewId,approved:true}),
    e=>e.code==="DOC_CHANGED");
}));
test("P7 sources that diverge from indexed hash are stale document references",async()=>withProject(async({docs,ts})=>{
  await docs.index({projectId:id});
  const file=path.join(ts,"src","services","teaching-devices.service.ts");
  await writeFile(file,(await readFile(file,"utf8"))+"\n// changed after index\n");
  const r=await docs.search({projectId:id,query:"teaching devices"});
  const ref=r.noteClaims.results.find(n=>n.title==="Teaching Devices Notes")
    .sourceReferences.find(x=>x.relativePath==="src/services/teaching-devices.service.ts");
  assert.equal(ref.sourceFreshness,"stale_source_changed_or_missing");
}));
test("P7 scope changes require reindex and outside vault reads are rejected",async()=>withProject(async({docs,scope,scopeConfigPath,outside,vault})=>{
  await docs.index({projectId:id});
  scope.projects[id].readRoots=[vault];
  await writeFile(scopeConfigPath,JSON.stringify(scope));
  await assert.rejects(docs.search({projectId:id,query:"teaching devices"}),
    e=>e.code==="DOC_INDEX_STALE");
  scope.projects[id].readRoots=[outside];
  await writeFile(scopeConfigPath,JSON.stringify(scope));
  await assert.rejects(docs.index({projectId:id}),e=>e.code==="DOC_SCOPE_INVALID");
}));
test("P7 skip symlinked docs and hidden vault settings",async()=>withProject(async({docs,manual,outside})=>{
  await writeFile(path.join(outside,"secret.md"),"# Secret external\n");
  const setting=path.join(manual,".obsidian");
  await mkdir(setting);
  await writeFile(path.join(setting,"private.md"),"# Hidden\n");
  try{await symlink(path.join(outside,"secret.md"),path.join(manual,"leak.md"),"file");}catch{}
  const indexed=await docs.index({projectId:id});
  assert.equal(indexed.notes,2);
  const res=await docs.search({projectId:id,query:"secret external"});
  assert.equal(res.noteClaims.results.length,0);
}));
test("P7 read-only scoped vault permits preview but refuses apply until destination selected",async()=>withProject(async({handler})=>{
  await call(handler,"index");
  const p=(await call(handler,"preview",{query:"teachingDevicesService"})).structuredContent.result;
  assert.equal(p.writeScopeConfigured,false);
  const res=await call(handler,"apply",{previewId:p.previewId,approved:true});
  assert.equal(res.structuredContent.code,"DOC_WRITE_SCOPE_MISSING");
},{writeScope:false}));
