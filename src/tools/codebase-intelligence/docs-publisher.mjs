import path from "node:path";
import {randomBytes} from "node:crypto";
import {lstat,realpath,readFile,open,mkdir,rename,unlink} from "node:fs/promises";
import {createRequire} from "node:module";
import {ProjectRegistryError} from "./registry.mjs";
import {readSafeFile} from "./scanner.mjs";
import {openExistingIndex,currentRevision} from "./store.mjs";
import {sha,contained,readDocsIndex,safeNoteRead,normalized} from "./docs-index.mjs";

const fail=(code,msg)=>{throw new ProjectRegistryError(code,msg);};
const require=createRequire(import.meta.url);
const diff=require("diff");
const MAX_GENERATED=38*1024,TTL_MS=12*60*1000,TICK=String.fromCharCode(96);
const idPattern=/^[a-f0-9]{40}$/u;
const slug=x=>{
  if(typeof x!=="string"||!x.trim()||x.length>240)fail("INVALID_ARGUMENTS","Preview requires a valid query.");
  let s=normalized(x).replace(/[^\p{L}\p{N}]+/gu,"-").replace(/^-+|-+$/gu,"").slice(0,64);
  if(!s)s="source";
  if(/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:$|-)/iu.test(s))s="source-"+s;
  return s+"-source-map.md";
};
const quote=x=>JSON.stringify(String(x).replace(/[\x00-\x1f]/gu," ").slice(0,180));
async function hashOrNull(file){
  try{
    const s=await lstat(file);
    if(!s.isFile()||s.isSymbolicLink()||s.size>MAX_GENERATED)
      fail("DOC_OWNERSHIP_VIOLATION","Generated target must be a regular bounded Markdown file.");
    return sha(await readFile(file));
  }catch(e){if(e?.code==="ENOENT")return null;throw e;}
}
function targetOf(config,query){
  const filename=slug(query);
  if(!config.generatedRoot)return {filename,relativePath:"Generated/Codebase Intelligence/"+filename,
    absolute:null};
  const absolute=path.resolve(config.generatedRoot,filename);
  if(!contained(config.generatedRoot,absolute))fail("DOC_SCOPE_INVALID","Generated target escaped allowlisted root.");
  return {filename,relativePath:path.relative(config.vaultRoot,absolute).replace(/\\/gu,"/"),absolute};
}
const ledgerFile=(stateRoot,projectId,filename)=>
  path.join(stateRoot,"docs-published",projectId,filename+".json");
async function safeJson(file,maxBytes){
  try{
    const s=await lstat(file);
    if(!s.isFile()||s.isSymbolicLink()||s.size>maxBytes)return null;
    return JSON.parse(await readFile(file,"utf8"));
  }catch(e){if(e?.code==="ENOENT")return null;return null;}
}
async function checkGeneratedOwnership({stateRoot,projectId,filename,absolute}){
  if(!absolute)return {currentHash:null,ledger:null,existingText:null};
  const hash=await hashOrNull(absolute);
  if(!hash)return {currentHash:null,ledger:null,existingText:null};
  const body=await readFile(absolute,"utf8");
  if(!body.startsWith("---\n")||!body.includes("generated_by: openclaw_codebase_intelligence")||
     !body.includes("project_id: "+projectId+"\n"))
    fail("DOC_OWNERSHIP_VIOLATION","Target is a manual note or belongs to another generator/project.");
  const ledger=await safeJson(ledgerFile(stateRoot,projectId,filename),5000);
  if(!ledger||ledger.projectId!==projectId||ledger.filename!==filename||
     ledger.publishedSha256!==hash)
    fail("DOC_MANUALLY_MODIFIED","Generated note lacks a trusted publication ledger or was manually edited; refusing overwrite.");
  return {currentHash:hash,ledger,existingText:body};
}
async function ensureGeneratedDirectory(config){
  if(!config.generatedRoot)fail("DOC_WRITE_SCOPE_MISSING","Choose and configure Generated/Codebase Intelligence before applying.");
  let current=config.vaultRoot;
  const relative=path.relative(config.vaultRoot,config.generatedRoot);
  if(!relative||relative.startsWith("..")||path.isAbsolute(relative))fail("DOC_SCOPE_INVALID","Unsafe Generated directory.");
  for(const part of relative.split(path.sep)){
    if(!part||part==="."||part==="..")fail("DOC_SCOPE_INVALID","Invalid Generated path component.");
    current=path.join(current,part);
    try{await mkdir(current);}catch(e){if(e?.code!=="EEXIST")throw e;}
    const meta=await lstat(current);
    if(!meta.isDirectory()||meta.isSymbolicLink())fail("DOC_SCOPE_INVALID","Generated path contains symlink/non-directory.");
    const actual=await realpath(current);
    if(!contained(config.vaultRoot,actual)||
      path.normalize(actual).toLowerCase()!==path.normalize(current).toLowerCase())
      fail("DOC_SCOPE_INVALID","Generated directory resolves through junction or escapes vault.");
  }
}
async function checkSourceSnapshots({project,indexRoot,projectId,expectedSources}){
  const db=await openExistingIndex(indexRoot,projectId);
  if(!db||!currentRevision(db)){db?.close();fail("INDEX_MISSING","Source index missing.");}
  const byRepo=new Map(project.repositories.map(x=>[x.id,x.root]));
  try{
    const meta=db.prepare("SELECT sha256 FROM files WHERE repo_id=? AND relative_path=?");
    for(const item of expectedSources){
      const root=byRepo.get(item.repoId);
      if(!root||meta.get(item.repoId,item.relativePath)?.sha256!==item.sha256)
        fail("SOURCE_CHANGED","Referenced source changed in index since preview.");
      let current;
      try{
        const absolute=await realpath(path.join(root,item.relativePath));
        const safe=await readSafeFile({root,relativePath:item.relativePath,absolutePath:absolute});
        current=safe?.hash;
      }catch{}
      if(current!==item.sha256)fail("SOURCE_CHANGED","Referenced source file changed since preview.");
    }
  }finally{db.close();}
}
function render({projectId,query,graph,relatedNotes,indexedAt}){
  const esc=x=>String(x??"").replace(/[\r\n]+/gu," ").replaceAll(TICK,"").replace(/[|]/gu,"").slice(0,200);
  const proofs=new Map();
  for(const node of graph.nodes){
    if(!node.source?.sha256)continue;
    const s=node.source;
    proofs.set(s.repoId+":"+s.relativePath,{...s});
  }
  const verified=[...proofs.values()].sort((a,b)=>
    a.repoId.localeCompare(b.repoId)||a.relativePath.localeCompare(b.relativePath));
  const notes=relatedNotes.filter(x=>x.freshness==="verified_current_hash").slice(0,8);
  const paths=verified.slice(0,70).map(s=>
    "- **"+esc(s.repoId)+"** · "+TICK+s.relativePath.replaceAll(TICK,"")+TICK+
    " (line "+s.startLine+", SHA256 "+TICK+s.sha256.slice(0,12)+"…"+TICK+", revision "+s.indexRevision+")");
  const uncertain=graph.edges.filter(e=>e.status!=="verified_static").slice(0,25).map(e=>
    "- "+TICK+esc(e.kind)+TICK+" - "+esc(e.status)+"; source "+TICK+
    esc(e.evidence?.relativePath)+TICK);
  const gaps=(graph.unresolved??[]).slice(0,22).map(e=>
    "- "+TICK+esc(e.kind)+TICK+" target "+esc(e.targetLabel??"unresolved")+
    " - **unresolved**");
  const linkedNotes=notes.map(n=>"- "+n.wikilink+" - document claim, not AST evidence");
  const lines=[
    "---",
    "title: "+quote(query+" - Source Map"),
    "tags: [codebase-intelligence, generated, review-required]",
    "generated_by: openclaw_codebase_intelligence",
    "project_id: "+projectId,
    "source_revision: "+graph.indexRevision,
    "review_status: unreviewed",
    "generated_at: "+quote(indexedAt),
    "---","",
    "# "+esc(query)+" - Source Map","",
    "> [!warning] Automatically generated static evidence. Not proof of runtime deployment, Masterdata lineage or business equivalence. Needs review.","",
    "## Scope","",
    "- Project: "+TICK+projectId+TICK,
    "- Source index revision: "+TICK+graph.indexRevision+TICK,
    "- Query: "+TICK+esc(query)+TICK,
    "- Evidence nodes: "+graph.nodes.length+"; edges: "+graph.edges.length+
      "; truncated: "+Boolean(graph.truncated),"",
    "## C4 / data-flow view","",
    TICK.repeat(3)+"mermaid",graph.mermaid,TICK.repeat(3),"",
    "## Verified source paths (static evidence only)","",
    ...(paths.length?paths:["- No currently verified source path was found."]),"",
    "## Inferred / candidate relationships","",
    ...(uncertain.length?uncertain:["- No inferred edges in this bounded graph."]),"",
    "## Unresolved / missing evidence","",
    ...(gaps.length?gaps:["- No unresolved edges in this bounded view; absence does not prove complete coverage."]),
    ...(graph.truncated?["- Graph was truncated by node/edge/depth budget."]:[]),"",
    "## Linked Obsidian notes (claims, not source facts)","",
    ...(linkedNotes.length?linkedNotes:["- No verified indexed note links found for this query."]),"",
    "## Next review","",
    "- Confirm runtime base URLs, deployed branch, adapter selection and business boundaries separately.",
    "- Reindex after branch/source changes; preview again before replacing generated files.",
    "- Preserve manual plan, journal and architecture notes; write only to approved Generated namespace.","",
  ];
  const text=lines.join("\n");
  if(Buffer.byteLength(text,"utf8")>MAX_GENERATED)
    fail("DOC_PREVIEW_TOO_LARGE","Generated C4 view exceeds bounded Markdown size.");
  return {text,expectedSources:verified.map(s=>({repoId:s.repoId,
    relativePath:s.relativePath,sha256:s.sha256})),
    referencedNotes:notes.map(n=>({readRoot:n.readRoot??null,
      relativePath:n.relativePath,sha256:n.sha256}))};
}
export function createDocsPublisher({registry,indexRoot,architecture,docsSearch}){
  const stateRoot=registry.stateRoot;
  async function preview({projectId,query,config,level="C4"}){
    if(!["C3","C4"].includes(level))fail("INVALID_ARGUMENTS","Docs/preview supports C3 or C4.");
    await registry.ensureProjectAllowed(projectId);
    const index=await readDocsIndex({stateRoot,projectId,config});
    const graph=await architecture({projectId,level,query,maxDepth:7,maxNodes:58,limit:1});
    if(graph.stale?.length)fail("SOURCE_STALE","Source changed; reindex before publishing.");
    if(graph.truncated)fail("DOC_PREVIEW_INCOMPLETE","Graph truncated; use narrower query.");
    const linked=await docsSearch({projectId,query,config,limit:8});
    const relatedNotes=linked.results.map(n=>({
      ...n,readRoot:index.notes.find(x=>x.relativePath===n.relativePath)?.readRoot,
    }));
    const built=render({projectId,query,graph,relatedNotes,indexedAt:index.indexedAt});
    const target=targetOf(config,query);
    const owner=await checkGeneratedOwnership({stateRoot,projectId,...target});
    const patch=diff.createTwoFilesPatch(
      target.relativePath+" (current)",target.relativePath+" (proposed)",
      owner.existingText??"",built.text,"Current generated","Proposed evidence");
    const id=randomBytes(20).toString("hex");
    const pending={version:1,previewId:id,projectId,query,level,createdAt:Date.now(),
      expiresAt:Date.now()+TTL_MS,configHash:config.configHash,
      indexRevision:graph.indexRevision,target,
      expectedTargetSha256:owner.currentHash,expectedSources:built.expectedSources,
      expectedNotes:built.referencedNotes.filter(n=>n.readRoot&&n.sha256),
      proposedSha256:sha(built.text),content:built.text};
    const folder=path.join(stateRoot,"docs-previews",projectId);
    await mkdir(folder,{recursive:true});
    const handle=await open(path.join(folder,id+".json"),"wx",0o600);
    try{await handle.writeFile(JSON.stringify(pending));}finally{await handle.close();}
    return {projectId,query,level,previewId:id,expiresAt:new Date(pending.expiresAt).toISOString(),
      generatedTarget:target.relativePath,writeScopeConfigured:!!target.absolute,
      proposedSha256:pending.proposedSha256,expectedTargetSha256:owner.currentHash,
      expectedIndexRevision:pending.indexRevision,sourceCount:pending.expectedSources.length,
      linkedNotes:pending.expectedNotes.length,status:"preview_only_requires_explicit_user_approval",
      markdown:built.text,diff:patch.slice(0,45_000),
      warnings:["No Obsidian note was written; preview is stored only in OpenClaw local state.",
        "Apply requires configured Generated directory, a fresh preview ID and user approval.",
        "Static source diagram does not establish production runtime links."]};
  }
  async function apply({projectId,previewId,config,approved=false}){
    if(approved!==true)fail("DOC_APPROVAL_REQUIRED","The user must explicitly approve preview before apply.");
    if(typeof previewId!=="string"||!idPattern.test(previewId))
      fail("INVALID_ARGUMENTS","Apply requires the exact preview ID.");
    const project=await registry.ensureProjectAllowed(projectId);
    const p=path.join(stateRoot,"docs-previews",projectId,previewId+".json");
    const record=await safeJson(p,MAX_GENERATED*3);
    if(!record||record.version!==1||record.previewId!==previewId||
      record.projectId!==projectId||!record.target||
      sha(record.content??"")!==record.proposedSha256)
      fail("DOC_PREVIEW_MISSING","Preview missing or invalid; create another preview.");
    if(Date.now()>record.expiresAt)fail("DOC_PREVIEW_EXPIRED","Preview expired; preview again.");
    if(record.configHash!==config.configHash)fail("DOC_SCOPE_CHANGED","Docs scope changed after preview.");
    const target=targetOf(config,record.query);
    if(!target.absolute)fail("DOC_WRITE_SCOPE_MISSING","No user-selected Generated write destination is configured.");
    if(record.target.relativePath!==target.relativePath||record.target.absolute!==target.absolute)
      fail("DOC_SCOPE_CHANGED","Generated target changed since preview.");
    async function checkRevisionAndNotes(){
      const db=await openExistingIndex(indexRoot,projectId);
      const rev=db?currentRevision(db):null;db?.close();
      if(rev?.revision!==record.indexRevision)
        fail("INDEX_CHANGED","Source index revision changed since preview.");
      for(const note of record.expectedNotes??[]){
        if(!config.readRoots.includes(note.readRoot))
          fail("DOC_SCOPE_CHANGED","Linked note readRoot no longer belongs to the explicit allowlist.");
        const full=path.join(config.vaultRoot,note.relativePath);
        if(!contained(config.vaultRoot,full)||!contained(note.readRoot,full))
          fail("DOC_SCOPE_CHANGED","Linked note escaped the allowlisted vault folder.");
        const current=await safeNoteRead(note.readRoot,path.relative(note.readRoot,full));
        if(current?.sha256!==note.sha256)
          fail("DOC_CHANGED","Linked manual note changed since preview.");
      }
    }
    await checkRevisionAndNotes();
    await checkSourceSnapshots({project,indexRoot,projectId,
      expectedSources:record.expectedSources??[]});
    const lockFolder=path.join(stateRoot,"docs-publish-locks",projectId);
    await mkdir(lockFolder,{recursive:true});
    const lockPath=path.join(lockFolder,target.filename+".lock");
    let lock;
    try{lock=await open(lockPath,"wx",0o600);}
    catch(e){if(e?.code==="EEXIST")fail("DOC_LOCKED","A generated note apply is already in progress.");throw e;}
    let temporary=null;
    try{
      await ensureGeneratedDirectory(config);
      const owner=await checkGeneratedOwnership({stateRoot,projectId,...target});
      if(owner.currentHash===record.proposedSha256&&owner.ledger)
        return {projectId,previewId,status:"already_applied",target:target.relativePath,
          sha256:record.proposedSha256,sourceRevision:record.indexRevision};
      if(owner.currentHash!==record.expectedTargetSha256)
        fail("DOC_CHANGED","Generated file changed since preview; refuse overwrite.");
      await checkRevisionAndNotes();
      await checkSourceSnapshots({project,indexRoot,projectId,
        expectedSources:record.expectedSources??[]});
      if((await hashOrNull(target.absolute))!==record.expectedTargetSha256)
        fail("DOC_CHANGED","Target changed during apply; refuse overwrite.");
      temporary=path.join(config.generatedRoot,"."+previewId+".tmp");
      const handle=await open(temporary,"wx",0o600);
      try{await handle.writeFile(record.content,"utf8");await handle.sync();}finally{await handle.close();}
      // Atomic same-volume rename; lock serializes this tool's own publishers.
      await rename(temporary,target.absolute);temporary=null;
      const ledgerPath=ledgerFile(stateRoot,projectId,target.filename);
      await mkdir(path.dirname(ledgerPath),{recursive:true});
      const tempLedger=ledgerPath+"."+previewId+".tmp";
      const ledger={version:1,projectId,filename:target.filename,
        publishedSha256:record.proposedSha256,sourceRevision:record.indexRevision,
        publishedAt:new Date().toISOString()};
      const lh=await open(tempLedger,"wx",0o600);
      try{await lh.writeFile(JSON.stringify(ledger));await lh.sync();}finally{await lh.close();}
      await rename(tempLedger,ledgerPath);
      return {projectId,previewId,status:"applied_generated_only",target:target.relativePath,
        sha256:record.proposedSha256,sourceRevision:record.indexRevision};
    }finally{
      if(temporary)await unlink(temporary).catch(()=>{});
      await lock?.close().catch(()=>{});
      await unlink(lockPath).catch(()=>{});
    }
  }
  return {preview,apply};
}
