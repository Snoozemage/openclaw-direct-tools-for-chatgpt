import path from "node:path";
import {createHash} from "node:crypto";
import {lstat,realpath,readdir,readFile,mkdir,rename,open,stat} from "node:fs/promises";
import {ProjectRegistryError} from "./registry.mjs";
import {sanitizeSource,readSafeFile} from "./scanner.mjs";
import {openExistingIndex,currentRevision} from "./store.mjs";

export const DOCS_MAX={files:900,fileBytes:256*1024,totalBytes:12*1024*1024,
  linksPerNote:40,searchResults:24};
const fail=(code,msg)=>{throw new ProjectRegistryError(code,msg);};
export const sha=x=>createHash("sha256").update(x).digest("hex");
export const normalized=x=>String(x??"").normalize("NFKC").toLocaleLowerCase("vi");
export const contained=(root,item)=>{
  const rel=path.relative(root,item);
  return rel===""||(!path.isAbsolute(rel)&&rel!==".."&&!rel.startsWith(".."+path.sep));
};
function configPath(stateRoot){return path.join(stateRoot,"docs-scope.json");}
export async function loadDocsConfig({stateRoot,projectId}){
  let text,parsed;
  try{
    const name=configPath(stateRoot),info=await lstat(name);
    if(!info.isFile()||info.isSymbolicLink()||info.size>32*1024)fail("DOC_SCOPE_INVALID","Docs scope must be a regular JSON file under 32 KiB.");
    text=await readFile(name,"utf8");
  }catch(err){
    if(err?.code==="ENOENT")fail("DOC_SCOPE_MISSING","Create an explicit docs-scope.json read allowlist in OpenClaw state before indexing Obsidian.");
    throw err;
  }
  try{parsed=JSON.parse(text);}catch{fail("DOC_SCOPE_INVALID","Docs scope JSON is malformed.");}
  const cfg=parsed?.projects?.[projectId];
  if(parsed?.version!==1||!cfg||typeof cfg.vaultRoot!=="string"||
    !Array.isArray(cfg.readRoots)||cfg.readRoots.length<1||cfg.readRoots.length>8||
    cfg.readRoots.some(x=>typeof x!=="string"||x.length>1024)||
    (cfg.generatedRoot!=null&&(typeof cfg.generatedRoot!=="string"||cfg.generatedRoot.length>1024)))
    fail("DOC_SCOPE_MISSING","Project needs vaultRoot and 1–8 explicitly allowed readRoots; generatedRoot may be null.");
  let vault;
  try{
    vault=await realpath(cfg.vaultRoot);
    const info=await lstat(cfg.vaultRoot);
    if(!info.isDirectory()||info.isSymbolicLink())throw Error("not_a_directory");
  }catch{fail("DOC_SCOPE_INVALID","Configured vault root is not a safe real directory.");}
  const readRoots=[];
  for(const item of cfg.readRoots){
    let real;
    try{
      const info=await lstat(item);
      if(!info.isDirectory()||info.isSymbolicLink())throw Error("not_directory");
      real=await realpath(item);
    }catch{fail("DOC_SCOPE_INVALID","Configured readRoot is missing or a symlink.");}
    if(!contained(vault,real))fail("DOC_SCOPE_INVALID","Read root escapes configured Obsidian vault.");
    if(!readRoots.includes(real))readRoots.push(real);
  }
  let generatedRoot=null;
  if(cfg.generatedRoot!=null){
    generatedRoot=path.resolve(cfg.generatedRoot);
    if(!contained(vault,generatedRoot)||
       !generatedRoot.replace(/\\/gu,"/").endsWith("/Generated/Codebase Intelligence")||
       generatedRoot===vault)
      fail("DOC_SCOPE_INVALID","generatedRoot must be inside vault as .../Generated/Codebase Intelligence.");
    // Validate existing parents before preview reads anything under this path;
    // a symlink or Windows junction must not route Generated operations outside the vault.
    let current=vault;
    for(const part of path.relative(vault,generatedRoot).split(path.sep)){
      current=path.join(current,part);
      let info;
      try{info=await lstat(current);}catch(e){if(e?.code==="ENOENT")break;throw e;}
      if(!info.isDirectory()||info.isSymbolicLink())
        fail("DOC_SCOPE_INVALID","Generated path contains a symlink/non-directory.");
      const real=await realpath(current);
      if(!contained(vault,real)||path.normalize(real).toLowerCase()!==path.normalize(current).toLowerCase())
        fail("DOC_SCOPE_INVALID","Generated path contains a junction or escapes the vault.");
    }
  }
  return {projectId,vaultRoot:vault,readRoots,generatedRoot,
    configHash:sha(text),scopePath:configPath(stateRoot)};
}
export async function safeNoteRead(root,relative){
  if(typeof relative!=="string"||!relative.endsWith(".md")||path.isAbsolute(relative)||
    relative.split(/[\\/]/u).some(s=>!s||s===".."||s.startsWith(".")))return null;
  const target=path.resolve(root,relative);
  if(!contained(root,target))return null;
  try{
    const info=await lstat(target);
    if(!info.isFile()||info.isSymbolicLink()||info.size>DOCS_MAX.fileBytes)return null;
    const real=await realpath(target);
    if(!contained(root,real))return null;
    const bytes=await readFile(real);
    if(bytes.byteLength>DOCS_MAX.fileBytes||bytes.includes(0))return null;
    const text=bytes.toString("utf8");
    if(text.includes("\uFFFD"))return null;
    return {text,sha256:sha(bytes),bytes:bytes.byteLength,target:real};
  }catch(e){if(e?.code==="ENOENT")return null;return null;}
}
const pathPattern=/\b(?:src|app|routes|database|resources|tests)\/(?:[A-Za-z0-9_@.()-]+\/)*[A-Za-z0-9_@.-]+\.(?:blade\.php|php|cs|ts|tsx|sql)\b/gu;
export function parseMarkdown(text,relativePath,inventory=new Map()){
  const lines=text.split(/\r?\n/u),fields={},tags=[],headings=[],wikilinks=[];
  let start=0;
  if(lines[0]?.trim()==="---"){
    const end=lines.slice(1,72).findIndex(x=>x.trim()==="---");
    if(end>=0){
      let active="";
      for(const line of lines.slice(1,end+1)){
        const prop=line.match(/^([a-zA-Z_][a-zA-Z0-9_-]*):\s*(.*?)\s*$/u);
        if(prop){
          active=prop[1];fields[active]=prop[2].replace(/^["']|["']$/gu,"").slice(0,250);
          if(active==="tags"&&prop[2].startsWith("[")){
            tags.push(...prop[2].slice(1,-1).split(",").map(x=>x.trim().replace(/^["']|["']$/gu,"")).filter(Boolean).slice(0,20));
          }
        }else if(active==="tags"&&/^\s*-\s+/u.test(line)){
          tags.push(line.replace(/^\s*-\s+/u,"").slice(0,70));
        }
      }
      start=end+2;
    }
  }
  for(const [i,line] of lines.entries()){
    if(i<start)continue;
    const heading=line.match(/^\s*(#{1,6})\s+(.+?)\s*#*\s*$/u);
    if(heading&&headings.length<70)headings.push({level:heading[1].length,title:heading[2].slice(0,150),line:i+1});
    for(const match of line.matchAll(/\[\[([^\]]{1,240})\]\]/gu)){
      if(wikilinks.length<80)wikilinks.push({target:match[1].split("|")[0].split("#")[0],
        line:i+1});
    }
  }
  const references=[],seen=new Set();
  // Only explicit full relative code paths are considered evidence references.
  // They are documentary claims, not static call or runtime graph edges.
  for(const [i,line] of lines.entries()){
    for(const m of line.matchAll(pathPattern)){
      if(references.length>=DOCS_MAX.linksPerNote)break;
      const local=m[0],match=inventory.get(local)??[];
      const k=i+":"+local;if(seen.has(k))continue;seen.add(k);
      references.push({claimedPath:local,line:i+1,
        status:match.length===1?"indexed_source_reference":match.length>1?"ambiguous_source_reference":"unindexed_source_reference",
        ...(match.length===1?{repoId:match[0].repoId,relativePath:match[0].relativePath,
          indexedSha256:match[0].sha256}:{}),
      });
    }
  }
  const title=(fields.title||headings.find(x=>x.level===1)?.title||path.basename(relativePath,".md")).slice(0,180);
  return {title,tags:[...new Set(tags)].slice(0,20),fields:{
      title:fields.title??null,status:fields.status??null,updated:fields.updated??null,
      generated_by:fields.generated_by??null},
    headings,wikilinks,references,
    // This is a bounded indexed text for lexical retrieval, not a verbatim note export.
    searchText:sanitizeSource(lines.slice(0,650).join("\n")).slice(0,16000),
  };
}
async function readSourceInventory(indexRoot,projectId){
  const db=await openExistingIndex(indexRoot,projectId);
  if(!db||!currentRevision(db)){db?.close();fail("INDEX_MISSING","Run source index before linking Obsidian notes.");}
  try{
    const files=db.prepare("SELECT repo_id,relative_path,sha256 FROM files ORDER BY relative_path").all();
    const inventory=new Map();
    for(const r of files){
      const x={repoId:r.repo_id,relativePath:r.relative_path,sha256:r.sha256};
      inventory.set(r.relative_path,[...(inventory.get(r.relative_path)??[]),x]);
    }
    return {inventory,sourceRevision:currentRevision(db).revision};
  }finally{db.close();}
}
function indexPath(stateRoot,projectId){return path.join(stateRoot,"docs-index",projectId+".json");}
export async function readDocsIndex({stateRoot,projectId,config}){
  let data;
  try{
    const p=indexPath(stateRoot,projectId),info=await lstat(p);
    if(!info.isFile()||info.isSymbolicLink()||info.size>16*1024*1024)
      fail("DOC_INDEX_INVALID","Obsidian index has invalid bounds/type.");
    data=JSON.parse(await readFile(p,"utf8"));
  }catch(e){
    if(e?.code==="ENOENT")fail("DOC_INDEX_MISSING","Run docs/index before docs/search or preview.");
    if(e instanceof ProjectRegistryError)throw e;
    fail("DOC_INDEX_INVALID","Obsidian index cannot be loaded.");
  }
  if(data.version!==1||data.projectId!==projectId||data.configHash!==config.configHash||
     !Array.isArray(data.notes)||data.notes.length>DOCS_MAX.files)
    fail("DOC_INDEX_STALE","Docs scope or index changed; run docs/index.");
  return data;
}
export async function buildDocsIndex({stateRoot,indexRoot,projectId,config}){
  const {inventory,sourceRevision}=await readSourceInventory(indexRoot,projectId);
  const prev=await readDocsIndex({stateRoot,projectId,config}).catch(e=>{
    if(["DOC_INDEX_MISSING","DOC_INDEX_STALE"].includes(e?.code))return null;
    throw e;
  });
  const notes=[],seenPaths=new Set(),stack=config.readRoots.map(root=>({root,dir:root,depth:0}));
  let totalBytes=0,skipped=0,examined=0;
  while(stack.length){
    const {root,dir,depth}=stack.pop();
    if(depth>12)fail("DOC_INDEX_LIMIT","Obsidian read root has excessive directory depth.");
    const items=(await readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name));
    for(const entry of items){
      if(entry.name.startsWith(".")||entry.name==="node_modules"||entry.name==="vendor"||
         entry.name==="Generated"||entry.name==="Codebase Intelligence"&&depth>0)continue;
      const target=path.join(dir,entry.name);
      if(entry.isSymbolicLink())continue;
      const info=await lstat(target).catch(()=>null);
      if(!info)continue;
      const real=await realpath(target).catch(()=>null);
      if(!real||!contained(root,real))continue;
      if(info.isDirectory()){
        if(depth<12)stack.push({root,dir:real,depth:depth+1});
        continue;
      }
      if(!info.isFile()||!entry.name.toLowerCase().endsWith(".md"))continue;
      examined++;
      if(notes.length>=DOCS_MAX.files||totalBytes+info.size>DOCS_MAX.totalBytes)
        fail("DOC_INDEX_LIMIT","Doc index max files/bytes exceeded.");
      if(info.size>DOCS_MAX.fileBytes){skipped++;continue;}
      const relative=path.relative(root,target).replace(/\\/gu,"/");
      const note=await safeNoteRead(root,relative);
      if(!note){skipped++;continue;}
      const vaultRelative=path.relative(config.vaultRoot,note.target).replace(/\\/gu,"/");
      if(seenPaths.has(vaultRelative))continue;
      seenPaths.add(vaultRelative);totalBytes+=note.bytes;
      const parsed=parseMarkdown(note.text,relative,inventory);
      notes.push({relativePath:vaultRelative,readRoot:root,relativeToRoot:relative,
        sha256:note.sha256,bytes:note.bytes,...parsed});
    }
  }
  notes.sort((a,b)=>a.relativePath.localeCompare(b.relativePath));
  const old=new Map(prev?.notes?.map(n=>[n.relativePath,n.sha256])??[]);
  const changed=notes.filter(n=>old.get(n.relativePath)!==n.sha256).length;
  const removed=[...old.keys()].filter(x=>!seenPaths.has(x)).length;
  const data={version:1,projectId,configHash:config.configHash,sourceRevision,
    indexedAt:new Date().toISOString(),notes};
  const dir=path.join(stateRoot,"docs-index");
  await mkdir(dir,{recursive:true});
  const target=indexPath(stateRoot,projectId),tmp=target+"."+process.pid+"."+Date.now()+".tmp";
  let handle;
  try{
    handle=await open(tmp,"wx",0o600);
    await handle.writeFile(JSON.stringify(data));
    await handle.close();handle=null;
    await rename(tmp,target);
  }finally{
    await handle?.close().catch(()=>{});
    await import("node:fs/promises").then(fs=>fs.unlink(tmp).catch(()=>{}));
  }
  return {projectId,sourceRevision,notes:notes.length,changed,removed,skipped,examined,
    referenceCandidates:notes.reduce((a,n)=>a+n.references.length,0),
    indexedAt:data.indexedAt,readRoots:config.readRoots,
    sideEffect:"only_local_docs_index_metadata_outside_vault"};
}
export async function liveNoteStatus(note,config){
  const current=await safeNoteRead(note.readRoot,note.relativeToRoot);
  return current?.sha256===note.sha256?"verified_current_hash":"stale_note_changed_or_missing";
}
export async function verifySourceReferences({project,indexRoot,projectId,references,limit=30}){
  const roots=new Map(project.repositories.map(r=>[r.id,r.root]));
  const db=await openExistingIndex(indexRoot,projectId);
  const result=[],hashes=new Map();
  try{
    const file=db?.prepare("SELECT sha256 FROM files WHERE repo_id=? AND relative_path=?");
    for(const ref of references.slice(0,limit)){
      if(ref.status!=="indexed_source_reference"){
        result.push({...ref,sourceFreshness:ref.status});continue;
      }
      const key=ref.repoId+":"+ref.relativePath;
      if(!hashes.has(key)){
        let h=null;
        try{
          const root=roots.get(ref.repoId);
          const expected=file?.get(ref.repoId,ref.relativePath)?.sha256;
          if(root&&expected){
            const absolutePath=await realpath(path.join(root,ref.relativePath));
            const safe=await readSafeFile({root,relativePath:ref.relativePath,absolutePath});
            h=safe?.hash??null;
          }
        }catch{}
        hashes.set(key,h);
      }
      const current=hashes.get(key);
      const indexedSha=file?.get(ref.repoId,ref.relativePath)?.sha256;
      result.push({...ref,sourceFreshness:current===indexedSha&&current===ref.indexedSha256?
        "verified_current_hash":"stale_source_changed_or_missing"});
    }
  }finally{db?.close();}
  return result;
}
export async function searchDocs({stateRoot,indexRoot,projectId,project,config,query,limit=10}){
  if(typeof query!=="string"||!query.trim()||query.length>240||
     !Number.isInteger(limit)||limit<1||limit>24)
    fail("INVALID_ARGUMENTS","Docs search query/limit is invalid.");
  const index=await readDocsIndex({stateRoot,projectId,config});
  const q=normalized(query.trim()),terms=q.split(/[\s/._-]+/u).filter(x=>x.length>2).slice(0,8);
  const ranked=index.notes.map(note=>{
    const title=normalized(note.title),p=normalized(note.relativePath),
      headings=normalized(note.headings.map(x=>x.title).join(" ")),
      body=normalized(note.searchText);
    let score=title===q?100:title.includes(q)?65:p.includes(q)?55:headings.includes(q)?50:body.includes(q)?30:0;
    score+=terms.reduce((a,t)=>a+(title.includes(t)?9:headings.includes(t)?5:body.includes(t)?1:0),0);
    return {note,score};
  }).filter(x=>x.score>0).sort((a,b)=>b.score-a.score||a.note.relativePath.localeCompare(b.note.relativePath))
    .slice(0,limit);
  const results=[];
  for(const {note,score} of ranked){
    const freshness=await liveNoteStatus(note,config);
    const refs=freshness==="verified_current_hash"?
      await verifySourceReferences({project,indexRoot,projectId,references:note.references,limit:16}):[];
    // Never return a stale cached note excerpt as though it reflects the current file.
    const excerpt=freshness==="verified_current_hash"?
      sanitizeSource(note.searchText).slice(0,360).replace(/\s+/gu," "):null;
    results.push({title:note.title,relativePath:note.relativePath,
      wikilink:"[["+note.relativePath.replace(/\.md$/iu,"")+"]]",
      documentType:"documentation_claim_not_source_fact",
      score,sha256:note.sha256,freshness,
      ...(freshness==="verified_current_hash"?{
        headings:note.headings.slice(0,8),tags:note.tags,excerpt,sourceReferences:refs,
      }:{}),
    });
  }
  return {projectId,query,indexedAt:index.indexedAt,docsRevision:index.sourceRevision,
    results,count:results.length,notesIndexed:index.notes.length,
    interpretation:"Manual Obsidian notes are document claims, never source AST facts or verified runtime relationships."};
}
