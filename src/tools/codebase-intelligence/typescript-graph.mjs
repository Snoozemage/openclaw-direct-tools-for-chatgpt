import path from "node:path";
import {readTypescriptAliases} from "./typescript-parser.mjs";
export function readTsAdapterVersion(db){
  try{return db.prepare("SELECT value FROM ts_meta WHERE key='adapter_version'").get()?.value??null;}
  catch(e){if(/no such table/iu.test(e?.message??""))return null;throw e;}
}
export function saveTsAdapterVersion(db,v){
  db.prepare("INSERT OR REPLACE INTO ts_meta(key,value) VALUES('adapter_version',?)").run(v);
}
export function insertTsFacts(db,file,facts,error=null){
  const id=file.repoId+":"+file.relativePath;
  db.prepare("DELETE FROM ts_parse_errors WHERE file_id=?").run(id);
  db.prepare("DELETE FROM ts_facts WHERE file_id=?").run(id);
  if(error){
    db.prepare("INSERT INTO ts_parse_errors(file_id,code,updated_at) VALUES(?,?,?)")
      .run(id,error.slice(0,90),new Date().toISOString());
    return;
  }
  const stmt=db.prepare("INSERT INTO ts_facts(file_id,repo_id,relative_path,kind,name,parent,target,start_line,end_line,status,details) VALUES(?,?,?,?,?,?,?,?,?,?,?)");
  for(const f of facts)stmt.run(id,file.repoId,file.relativePath,f.kind,String(f.name).slice(0,600),
    f.parent?.slice(0,600)??null,f.target?.slice(0,600)??null,
    f.startLine,f.endLine,f.status,JSON.stringify(f.details??{}).slice(0,5000));
}
export function getTsCounts(db){
  try{return {
    facts:db.prepare("SELECT COUNT(*) n FROM ts_facts").get().n,
    edges:db.prepare("SELECT COUNT(*) n FROM ts_edges").get().n,
    parseErrors:db.prepare("SELECT COUNT(*) n FROM ts_parse_errors").get().n,
    filesWithFacts:db.prepare("SELECT COUNT(DISTINCT file_id) n FROM ts_facts").get().n,
    pages:db.prepare("SELECT COUNT(*) n FROM ts_facts WHERE kind='next_page'").get().n,
    httpRequests:db.prepare("SELECT COUNT(*) n FROM ts_facts WHERE kind='http_request'").get().n,
    mockBindings:db.prepare("SELECT COUNT(*) n FROM ts_edges WHERE relation='active_mock_binding'").get().n,
  };}catch(e){if(/no such table/iu.test(e?.message??""))return {facts:0,edges:0,parseErrors:0,filesWithFacts:0,pages:0,httpRequests:0,mockBindings:0};throw e;}
}
function mapped(row){
  if(!row)return null;
  let details={};try{details=JSON.parse(row.details);}catch{}
  return {id:row.id,repoId:row.repo_id,relativePath:row.relative_path,
    kind:row.kind,name:row.name,parent:row.parent,target:row.target,
    startLine:row.start_line,endLine:row.end_line,status:row.status,
    sha256:row.sha256,details};
}
/** Resolution is purely local to already indexed, allowlisted file inventory. */
export function rebuildTsEdges(db){
  db.prepare("DELETE FROM ts_edges").run();
  const facts=db.prepare("SELECT * FROM ts_facts ORDER BY id").all();
  const mods=new Map(),byFile=new Map(),exports=new Map(),imports=new Map(),clients=new Map(),envBindings=new Map();
  const push=(map,key,f)=>map.set(key,[...(map.get(key)??[]),f]);
  const key=f=>f.repo_id+"\0"+f.relative_path;
  const details=f=>{try{return JSON.parse(f.details);}catch{return {};}};
  for(const f of facts){
    const k=key(f);
    push(byFile,k,f);
    if(f.kind==="module")mods.set(k,f);
    if(f.kind==="import")push(imports,k+"\0"+f.name,f);
    if(f.kind==="export_binding"||f.kind==="reexport")push(exports,k+"\0"+f.name,f);
    if(f.kind==="http_client")push(clients,k+"\0"+f.name,f);
    if(f.kind==="env_binding")push(envBindings,k,f);
  }
  const configRows=db.prepare("SELECT f.repo_id,c.body FROM files f JOIN chunks c ON c.file_id=f.file_id "+
    "WHERE f.relative_path='tsconfig.json' ORDER BY f.repo_id,c.start_line").all();
  const configs=new Map();
  for(const x of configRows)configs.set(x.repo_id,(configs.get(x.repo_id)??"")+x.body+"\n");
  const aliasesByRepo=new Map([...configs].map(([repo,body])=>[repo,readTypescriptAliases(body)]));
  function resolve(from,spec){
    if(typeof spec!=="string"||!spec.trim())return {module:null,mode:"external"};
    const aliases=aliasesByRepo.get(from.repo_id)??{};
    const aliasEntry=Object.entries(aliases).find(([prefix])=>spec.startsWith(prefix));
    const base=aliasEntry?path.posix.normalize(aliasEntry[1]+spec.slice(aliasEntry[0].length)):
      spec.startsWith(".")?path.posix.normalize(path.posix.join(path.posix.dirname(from.relative_path),spec)):null;
    if(!base||base.startsWith("../")||base.includes("\0"))return {module:null,mode:spec.startsWith("@/")?"alias_unconfigured":"external"};
    const options=[base,base+".ts",base+".tsx",base+"/index.ts",base+"/index.tsx"];
    const hit=options.map(p=>mods.get(from.repo_id+"\0"+p)).filter(Boolean);
    return {module:hit.length===1?hit[0]:null,
      mode:aliasEntry?"configured_alias":"relative_path",
      ambiguous:hit.length>1};
  }
  const sql=db.prepare("INSERT INTO ts_edges(from_fact,to_fact,relation,status,target_label) VALUES(?,?,?,?,?)");
  const seen=new Set();let total=0;
  function edge(a,b,relation,status,label=null){
    if(total>=120000)return;
    const id=a.id+"\0"+(b?.id??0)+"\0"+relation;
    if(seen.has(id))return;
    seen.add(id);sql.run(a.id,b?.id??null,relation,status,label?.slice(0,360)??null);total++;
  }
  function unique(arr){return (arr??[]).length===1?arr[0]:null;}
  for(const f of facts){
    const k=key(f),m=mods.get(k),d=details(f);
    if(!m)continue;
    if(f.kind==="next_page"||f.kind==="next_api_route")edge(f,m,"route_source_module","verified_static",f.name);
    if(f.kind==="import"||f.kind==="reexport"){
      if(f.kind==="import")edge(m,f,d.typeOnly?"type_only_import":"contains_import","verified_static",f.name);
      else edge(m,f,"contains_reexport","verified_static",f.name);
      const r=resolve(f,d.specifier??f.target);
      if(r.module) {
        edge(f,r.module,"resolves_import_module",
          ["relative_path","configured_alias"].includes(r.mode)?"verified_static":"inferred",
          d.specifier??f.target);
        // Named exported symbol must exist as a declaration before the binding can be traced further.
        const imported=d.imported??d.local;
        if(imported&&imported!=="*"&&imported!=="default"){
          const sym=(byFile.get(key(r.module))??[]).filter(x=>x.kind==="symbol"&&x.name===imported);
          const re=(exports.get(key(r.module)+"\0"+imported)??[]);
          const target=unique([...new Map([...sym,...re].map(x=>[x.id,x])).values()]);
          if(target)edge(f,target,"imported_symbol_candidate","inferred",imported);
        }
      }else if(r.mode!=="external"&&!r.ambiguous)edge(f,null,"unresolved_local_import","unresolved",d.specifier??f.target);
    }
    if(f.kind==="import_usage"){
      edge(m,f,"contains_import_usage","verified_static",f.name);
      const bound=unique(imports.get(k+"\0"+f.target));
      edge(f,bound,"typechecker_resolved_import_binding",
        bound?"verified_static":"unresolved",f.target);
    }
    if(f.kind==="export_binding"){
      edge(m,f,"declares_export_binding","verified_static",f.name);
      const referenced=d.referenced??f.target;
      if(referenced){
        const imp=unique(imports.get(k+"\0"+referenced));
        if(imp){
          edge(f,imp,"export_alias_import","verified_static",referenced);
          const impd=details(imp),resolved=resolve(imp,impd.specifier);
          if(resolved.module && /(?:^|\/)(?:mocks?|__mocks__)(?:\/|$)|mock[-._]/iu.test(resolved.module.relative_path)){
            const exported=(byFile.get(key(resolved.module))??[]).some(x=>
              x.kind==="symbol"&&x.name===impd.imported&&details(x).exported===true);
            // A local named export binding pointing into an existing mocks module is source evidence
            // of a mock adapter selection, not a claim that a server was called.
            if(exported)edge(f,resolved.module,"active_mock_binding","verified_static",impd.imported);
          }
        }
      }
    }
    if(["service_call","http_request"].includes(f.kind)){
      edge(m,f,f.kind==="service_call"?"contains_service_call":"contains_http_request","verified_static",f.name);
      const receiver=d.receiver??d.client;
      if(receiver){
        const imp=unique(imports.get(k+"\0"+receiver));
        if(imp)edge(f,imp,"receiver_import","verified_static",receiver);
        const local=unique(clients.get(k+"\0"+receiver));
        if(local)edge(f,local,"uses_local_http_client","verified_static",receiver);
      }
    }
    if(f.kind==="http_client"){
      edge(m,f,"declares_http_client","verified_static",f.name);
      const expr=d.baseURLExpression??"";
      const recv=expr.split(".")[0];
      const imp=unique(imports.get(k+"\0"+recv));
      if(imp) {
        edge(f,imp,"base_url_config_import","inferred",recv);
        const resolved=resolve(imp,details(imp).specifier);
        if(resolved.module){
          for(const env of (envBindings.get(key(resolved.module))??[]).slice(0,8))
            edge(f,env,"base_url_env_candidate","inferred",details(env).environment);
        }
      }
    }
    if(f.kind==="http_request"&&d.client==="fetch") {
      // The browser fetch() URL is relative or absolute at runtime; no backend link is inferred from this alone.
    }
  }
  return total;
}
const KIND_PRIORITY={next_page:0,next_api_route:1,export_binding:2,http_request:3,service_call:4,
  http_client:5,import_usage:6,import:7,reexport:8,module:9,symbol:10,env_binding:11};
export function findTsFacts(db,query,{repoIds=[],kinds=[],limit=10}={}){
  const lower=query.toLocaleLowerCase("vi").trim();
  const terms=[lower,...lower.split(/[\s/\\._-]+/u).filter(x=>x.length>2)].filter(Boolean).slice(0,9);
  const repos=repoIds.length?" AND f.repo_id IN ("+repoIds.map(()=>"?").join(",")+")":"";
  const kindFilter=kinds.length?" AND f.kind IN ("+kinds.map(()=>"?").join(",")+")":"";
  const sql="SELECT f.*,fi.sha256 FROM ts_facts f JOIN files fi ON fi.file_id=f.file_id WHERE ("+
    terms.map(()=>"LOWER(f.name) LIKE ? OR LOWER(f.relative_path) LIKE ?").join(" OR ")+")"+repos+kindFilter+" LIMIT 1200";
  const args=[...terms.flatMap(x=>["%"+x.replace(/[%_]/gu,"")+"%","%"+x.replace(/[%_]/gu,"")+"%"]),...repoIds,...kinds];
  const found=db.prepare(sql).all(...args);
  const rank=f=>{
    const n=f.name.toLowerCase(),p=f.relative_path.toLowerCase();
    return (n===lower?0:n.includes(lower)?1:p.includes(lower)?2:4)*100+
      (KIND_PRIORITY[f.kind]??30);
  };
  found.sort((a,b)=>rank(a)-rank(b)||a.name.length-b.name.length||a.id-b.id);
  return found.slice(0,limit).map(mapped);
}
export function traceTsGraph(db,ids,{maxDepth=7,maxNodes=150,focus=null}={}){
  const nodes=[],edges=[],visited=new Set(),queue=ids.map(id=>({id,depth:0}));
  const focusKey=typeof focus==="string"?focus.toLowerCase().replace(/[^\p{L}\p{N}]+/gu,""):"";
  const get=db.prepare("SELECT f.*,fi.sha256 FROM ts_facts f JOIN files fi ON fi.file_id=f.file_id WHERE f.id=?");
  const peek=db.prepare("SELECT kind,name,details FROM ts_facts WHERE id=?");
  const adjacent=db.prepare("SELECT to_fact,relation,status,target_label FROM ts_edges WHERE from_fact=? ORDER BY id LIMIT 75");
  while(queue.length&&nodes.length<maxNodes){
    const {id,depth}=queue.shift();
    if(visited.has(id))continue;
    const f=mapped(get.get(id));if(!f)continue;
    visited.add(id);nodes.push(f);
    if(depth>=maxDepth)continue;
    let outgoing=adjacent.all(id);
    if(f.kind==="module" && focusKey.length>=5){
      // Follow imports/calls carrying the requested feature name, rather than exhausting
      // the graph through unrelated components before reaching its selected adapter.
      const onTopic=outgoing.filter(e=>{
        const target=e.to_fact?peek.get(e.to_fact):null;
        if(!target)return false;
        // An import fact lives in the current module, so its relative_path is NOT
        // evidence that its imported target is related to this feature.
        let spec="";
        if(target.kind==="import"||target.kind==="reexport"){
          try{spec=JSON.parse(target.details).specifier??"";}catch{}
        }
        const label=(target.name+" "+spec).toLowerCase().replace(/[^\p{L}\p{N}]+/gu,"");
        return label.includes(focusKey);
      });
      if(onTopic.length)outgoing=onTopic;
    }
    for(const e of outgoing){
      if(edges.length>=maxNodes*5)break;
      edges.push({fromId:id,toId:e.to_fact,kind:e.relation,status:e.status,targetLabel:e.target_label});
      if(e.to_fact&&!visited.has(e.to_fact))queue.push({id:e.to_fact,depth:depth+1});
    }
  }
  return {nodes,edges,truncated:queue.length>0||edges.length>=maxNodes*5};
}
export function findActiveMockBindings(db,repoIds=[],limit=30){
  const repos=repoIds.length?" AND f.repo_id IN ("+repoIds.map(()=>"?").join(",")+")":"";
  const sql="SELECT f.*,fi.sha256, m.relative_path AS mock_path FROM ts_edges e JOIN ts_facts f ON f.id=e.from_fact "+
    "JOIN ts_facts m ON m.id=e.to_fact JOIN files fi ON fi.file_id=f.file_id "+
    "WHERE e.relation='active_mock_binding'"+repos+" ORDER BY f.relative_path LIMIT ?";
  return db.prepare(sql).all(...repoIds,limit).map(f=>({
    ...mapped(f),mockModule:f.mock_path,
  }));
}
export function findTsHttpRequests(db,repoIds=[],limit=200){
  const repos=repoIds.length?" AND f.repo_id IN ("+repoIds.map(()=>"?").join(",")+")":"";
  return db.prepare("SELECT f.*,fi.sha256 FROM ts_facts f JOIN files fi ON fi.file_id=f.file_id "+
    "WHERE f.kind='http_request'"+repos+" ORDER BY f.repo_id,f.relative_path,f.start_line LIMIT ?")
    .all(...repoIds,limit).map(mapped);
}
