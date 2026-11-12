/**
 * Optional, read-only C1 metadata kept OUTSIDE Git in
 * <stateRoot>/contexts/<projectId>.json.
 * Every external system and relationship must name a current, indexed source
 * line and an identifier that actually occurs on that line. This validates
 * provenance, not runtime integration or the business meaning of the claim.
 */
import {lstat,readFile,realpath} from "node:fs/promises";
import path from "node:path";
import {readSafeFile} from "./scanner.mjs";

const LIMIT_BYTES=20*1024;
const NAME=/^[\p{L}\p{N}][\p{L}\p{N} _./()+:-]{0,110}$/u;
const ID=/^[a-z][a-z0-9_-]{1,62}$/u;
const limitedString=x=>typeof x==="string"&&x.length<120&&NAME.test(x);
function empty(status="not_configured",error=null){
  return {status,actors:[],externalSystems:[],relationships:[],
    ...(error?{errors:[error]}:{})};
}
export async function loadCuratedContext({stateRoot,projectId,project,db}){
  const configPath=path.join(stateRoot,"contexts",projectId+".json");
  let contents;
  try{
    const info=await lstat(configPath);
    if(!info.isFile()||info.isSymbolicLink()||info.size>LIMIT_BYTES)
      return empty("invalid","C1 context file must be a regular JSON file below 20KiB.");
    contents=await readFile(configPath,"utf8");
  }catch(e){
    if(e?.code==="ENOENT")return empty();
    return empty("unavailable","C1 context file cannot be read safely.");
  }
  let config;
  try{config=JSON.parse(contents);}catch{return empty("invalid","C1 context JSON is malformed.");}
  if(!config||config.version!==1||config.projectId!==projectId||
     !Array.isArray(config.actors)||!Array.isArray(config.externalSystems)||
     !Array.isArray(config.relationships)||config.actors.length>20||
     config.externalSystems.length>20||config.relationships.length>40)
    return empty("invalid","C1 context requires version=1, matching projectId and bounded actors/externalSystems/relationships arrays.");
  const errors=[],actorIds=new Set(),externalIds=new Set(),actors=[],externalSystems=[],relationships=[];
  const repoById=new Map(project.repositories.map(r=>[r.id,r]));
  const fileMeta=db.prepare("SELECT sha256 FROM files WHERE repo_id=? AND relative_path=?");
  const evidenceCache=new Map();
  async function evidenceOf(src){
    if(!src||typeof src!=="object"||!repoById.has(src.repoId)||typeof src.relativePath!=="string"||
       !/^[a-zA-Z0-9_\-./]+$/u.test(src.relativePath)||
       src.relativePath.startsWith("/")||src.relativePath.includes("..")||
       !Number.isInteger(src.line)||src.line<1||src.line>50000||
       !limitedString(src.identifier))return null;
    const key=src.repoId+":"+src.relativePath;
    const expected=fileMeta.get(src.repoId,src.relativePath);
    if(!expected)return null;
    if(!evidenceCache.has(key)){
      let value=null;
      try{
        const root=repoById.get(src.repoId).root;
        const resolved=await realpath(path.join(root,src.relativePath));
        const safe=await readSafeFile({root,relativePath:src.relativePath,absolutePath:resolved});
        if(safe?.hash===expected.sha256)value={hash:safe.hash,lines:safe.text.split("\n")};
      }catch{}
      evidenceCache.set(key,value);
    }
    const entry=evidenceCache.get(key);
    const line=entry?.lines[src.line-1]??"";
    if(!entry||!line.toLocaleLowerCase().includes(src.identifier.toLocaleLowerCase()))
      return null;
    return {repoId:src.repoId,relativePath:src.relativePath,startLine:src.line,
      endLine:src.line,sha256:entry.hash,sourceIdentifier:src.identifier,
      confidence:"verified_source_line_not_runtime"};
  }
  for(const a of config.actors){
    if(!a||!ID.test(a.id)||!limitedString(a.label)||actorIds.has(a.id)){
      errors.push("Invalid or duplicate actor identifier/label.");continue;
    }
    actorIds.add(a.id);
    actors.push({id:a.id,label:a.label,status:"manually_curated_unverified"});
  }
  for(const e of config.externalSystems){
    if(!e||!ID.test(e.id)||!limitedString(e.label)||externalIds.has(e.id)||
       actorIds.has(e.id)){
      errors.push("Invalid or duplicate external system identifier/label.");continue;
    }
    const proof=await evidenceOf(e.source);
    if(!proof){
      errors.push("External system "+String(e.id).slice(0,60)+" was omitted: indexed source-line evidence is missing or stale.");
      continue;
    }
    externalIds.add(e.id);
    externalSystems.push({id:e.id,label:e.label,status:"curated_source_reference_only",
      evidence:proof});
  }
  const known=new Set(["system",...actorIds,...externalIds]);
  for(const relation of config.relationships){
    if(!relation||!known.has(relation.from)||!known.has(relation.to)||
       relation.from===relation.to||!limitedString(relation.label)){
      errors.push("A curated relationship has unknown endpoints or an invalid label.");continue;
    }
    const proof=await evidenceOf(relation.source);
    if(!proof){errors.push("A curated relationship was omitted: source-line evidence is missing or stale.");continue;}
    relationships.push({from:relation.from,to:relation.to,label:relation.label,
      status:"curated_source_candidate_not_runtime",evidence:proof});
  }
  return {status:errors.length?"partially_verified":"curated_source_references",
    actors,externalSystems,relationships,errors};
}
