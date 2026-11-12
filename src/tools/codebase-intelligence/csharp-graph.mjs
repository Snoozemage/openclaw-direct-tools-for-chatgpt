/** Read-only C# static evidence indexing and conservatively resolved graph edges. */
export function readCsharpAdapterVersion(db){
  try{return db.prepare("SELECT value FROM csharp_meta WHERE key='adapter_version'").get()?.value??null;}
  catch(e){if(/no such table/iu.test(e?.message??""))return null;throw e;}
}
export function saveCsharpAdapterVersion(db,v){
  db.prepare("INSERT OR REPLACE INTO csharp_meta(key,value) VALUES('adapter_version',?)").run(v);
}
export function insertCsharpFacts(db,file,facts,error=null){
  const id=file.repoId+":"+file.relativePath;
  db.prepare("DELETE FROM csharp_parse_errors WHERE file_id=?").run(id);
  db.prepare("DELETE FROM csharp_facts WHERE file_id=?").run(id);
  if(error){
    db.prepare("INSERT INTO csharp_parse_errors(file_id,code,updated_at) VALUES(?,?,?)")
      .run(id,error.slice(0,80),new Date().toISOString());
    return;
  }
  const add=db.prepare("INSERT INTO csharp_facts (file_id,repo_id,relative_path,kind,name,parent,target,start_line,end_line,status,details) VALUES(?,?,?,?,?,?,?,?,?,?,?)");
  for(const f of facts){
    add.run(id,file.repoId,file.relativePath,f.kind,f.name.slice(0,600),f.parent?.slice(0,600)??null,
      f.target?.slice(0,600)??null,f.startLine,f.endLine,f.status,
      JSON.stringify(f.details??{}).slice(0,6000));
  }
}
export function getCsharpCounts(db) {
  try{return {
    facts:db.prepare("SELECT COUNT(*) AS n FROM csharp_facts").get().n,
    edges:db.prepare("SELECT COUNT(*) AS n FROM csharp_edges").get().n,
    parseErrors:db.prepare("SELECT COUNT(*) AS n FROM csharp_parse_errors").get().n,
    filesWithFacts:db.prepare("SELECT COUNT(DISTINCT file_id) AS n FROM csharp_facts").get().n,
    endpoints:db.prepare("SELECT COUNT(*) AS n FROM csharp_facts WHERE kind='endpoint'").get().n,
  };}catch(e){if(/no such table/iu.test(e?.message??""))return {facts:0,edges:0,parseErrors:0,filesWithFacts:0,endpoints:0};throw e;}
}
function short(s){return s?.replace(/<.*$/u,"").split(".").at(-1)??"";}
function row(r){
  if(!r)return null;let details={};try{details=JSON.parse(r.details);}catch{}
  return {id:r.id,repoId:r.repo_id,relativePath:r.relative_path,kind:r.kind,
    name:r.name,parent:r.parent,target:r.target,status:r.status,
    startLine:r.start_line,endLine:r.end_line,sha256:r.sha256,details};
}
export function rebuildCsharpEdges(db){
  db.prepare("DELETE FROM csharp_edges").run();
  const facts=db.prepare("SELECT id,file_id,repo_id,relative_path,kind,name,parent,target,start_line,status,details FROM csharp_facts").all();
  const symbols=new Map(),shortTypes=new Map(),handlerByRequest=new Map(),injectionByClass=new Map(),
    diByService=new Map(),dbsetsByContext=new Map(),configsByEntity=new Map(),methodAt=new Map();
  const push=(m,k,v)=>m.set(k,[...(m.get(k)??[]),v]);
  const typenames=new Set(["class","record","interface","struct","controller","ef_context","cqrs_request","dto","service"]);
  for(const f of facts) {
    const k=f.repo_id+"\0";
    if(typenames.has(f.kind)||["method","controller_method","cqrs_handler","ef_configuration","view_file"].includes(f.kind)) {
      push(symbols,k+f.kind+"\0"+f.name,f);
      if(typenames.has(f.kind))push(shortTypes,k+short(f.name),f);
    }
    if(f.kind==="method")push(methodAt,k+f.relative_path+"\0"+f.start_line+"\0"+f.name,f);
    if(f.kind==="cqrs_handler"&&f.target)push(handlerByRequest,k+short(f.target),f);
    if(f.kind==="constructor_dependency"&&f.parent)push(injectionByClass,k+f.parent,f);
    if(f.kind==="di_registration"||f.kind==="di_factory"){
      let d={};try{d=JSON.parse(f.details);}catch{}
      if(d.service)push(diByService,k+short(d.service),f);
    }
    if(f.kind==="ef_dbset"&&f.parent)push(dbsetsByContext,k+f.parent,f);
    if(f.kind==="ef_configuration"&&f.target)push(configsByEntity,k+short(f.target),f);
  }
  const once=(map,k)=>{const vals=map.get(k)??[];return vals.length===1?vals[0]:null;};
  const add=db.prepare("INSERT INTO csharp_edges(from_fact,to_fact,relation,status,target_label) VALUES(?,?,?,?,?)");
  const seen=new Set();let count=0;
  function edge(from,to,type,status,label=null){
    if(count>95000)return;
    const key=from.id+"\0"+(to?.id??0)+"\0"+type+"\0"+label;
    if(seen.has(key))return;
    seen.add(key);add.run(from.id,to?.id??null,type,status,label?.slice(0,500)??null);count++;
  }
  function resolveType(repo,name){
    if(!name)return null;
    const k=repo+"\0",fqKinds=["class","record","interface","struct","controller","ef_context","cqrs_request","dto","service"];
    if(name.includes(".")) {
      const all=fqKinds.flatMap(kind=>symbols.get(k+kind+"\0"+name)??[]);
      const unique=new Map(all.map(v=>[v.file_id+"\0"+v.name,v]));
      if(unique.size===1)return [...unique.values()][0];
    }
    const values=shortTypes.get(k+short(name))??[];
    const unique=new Map(values.map(v=>[v.file_id+"\0"+v.name,v]));
    return unique.size===1?[...unique.values()][0]:null;
  }
  for(const f of facts) {
    const repo=f.repo_id,k=repo+"\0";
    if(f.kind==="endpoint"&&f.target){
      const method=once(symbols,k+"controller_method"+"\0"+f.target);
      edge(f,method,"http_action",method?(f.status==="verified_static"?"verified_static":"inferred"):"unresolved",f.target);
    }
    if(["method","controller_method"].includes(f.kind) && f.parent) {
      // Constructor parameters are evidence of potential dependencies, not proof this method calls them.
      for(const dependency of (injectionByClass.get(k+f.parent)??[]).slice(0,14)){
        edge(f,dependency,"class_injection_candidate","inferred",dependency.target);
      }
    }
    if(f.kind==="semantic_method_call" && f.parent) {
      const declaring=once(symbols,k+"method\0"+f.parent);
      if(declaring)edge(declaring,f,"contains_semantic_call","verified_static",f.target);
      let evidence={};
      try{evidence=JSON.parse(f.details);}catch{}
      const target=typeof evidence.declarationPath==="string"&&
        Number.isInteger(evidence.declarationLine)?
        once(methodAt,k+evidence.declarationPath+"\0"+evidence.declarationLine+"\0"+f.target):null;
      edge(f,target,"references_resolved_method",
        target?"verified_static":"unresolved",f.target);
    }
    if(["mediator_send","table_operation","method_parameter","sql_operation"].includes(f.kind) && f.parent){
      const parent=once(symbols,k+"method"+"\0"+f.parent)??once(symbols,k+"controller_method"+"\0"+f.parent);
      if(parent)edge(parent,f,"contains_static_call","verified_static",f.name);
      const controllerMethod=once(symbols,k+"controller_method"+"\0"+f.parent);
      if(controllerMethod)edge(controllerMethod,f,"contains_static_call","verified_static",f.name);
    }
    if(f.kind==="method_parameter"&&f.target){
      const dto=resolveType(repo,f.target);
      edge(f,dto,"dto_type_candidate",dto?"inferred":"unresolved",f.target);
    }
    if(f.kind==="dto_field"&&f.parent){
      const dto=once(symbols,k+"dto"+"\0"+f.parent);
      if(dto)edge(dto,f,"declares_dto_field","verified_static",f.name);
    }
    if(f.kind==="mediator_send" && f.target){
      const candidates=handlerByRequest.get(k+short(f.target))??[];
      const unique=new Map(candidates.map(v=>[v.name,v]));
      const match=unique.size===1?[...unique.values()][0]:null;
      edge(f,match,"mediator_handler_candidate",match?"inferred":"unresolved",f.target);
    }
    if(f.kind==="cqrs_handler"){
      const handle=once(symbols,k+"method"+"\0"+f.name+"@Handle");
      edge(f,handle,"handler_method",handle?"verified_static":"unresolved",f.name+"@Handle");
      if(f.target){
        const request=resolveType(repo,f.target);
        edge(f,request,"handles_request_type",request?"inferred":"unresolved",f.target);
      }
      for(const dep of (injectionByClass.get(k+f.name)??[]).slice(0,18)){
        edge(f,dep,"constructor_dependency","verified_static",dep.target);
      }
    }
    if(f.kind==="constructor_dependency"&&f.target){
      const di=once(diByService,k+short(f.target));
      if(di)edge(f,di,"registered_implementation_candidate",di.kind==="di_factory"?"unresolved":"inferred",f.target);
      else {
        const type=resolveType(repo,f.target);
        if(type)edge(f,type,"typed_dependency_candidate","inferred",f.target);
      }
    }
    if(f.kind==="di_registration"){
      let d={};try{d=JSON.parse(f.details);}catch{}
      const type=resolveType(repo,d.implementation??f.target);
      edge(f,type,"registered_concrete_type",type?"inferred":"unresolved",d.implementation??f.target);
    }
    if(f.kind==="ef_context"){
      for(const set of (dbsetsByContext.get(k+f.name)??[]).slice(0,170)){
        edge(f,set,"declares_dbset","verified_static",set.name);
      }
    }
    if(f.kind==="ef_dbset"){
      const entity=resolveType(repo,f.target);
      edge(f,entity,"dbset_entity_candidate",entity?"inferred":"unresolved",f.target);
      for(const cfg of (configsByEntity.get(k+short(f.target))??[]).slice(0,6)) {
        edge(f,cfg,"entity_configuration_candidate","inferred",cfg.name);
      }
    }
    if(f.kind==="ef_table"&&f.target){
      const migrations=facts.filter(v=>v.repo_id===repo&&v.kind==="ef_migration_table"&&v.target===f.target).slice(0,5);
      for(const m of migrations)edge(f,m,"migration_table_candidate","inferred",f.target);
    }
    if(f.kind==="ef_context_registration"&&f.target){
      const context=resolveType(repo,f.target);
      edge(f,context,"registered_dbcontext_candidate",context?"inferred":"unresolved",f.target);
    }
    if(f.kind==="ef_configuration"&&f.target){
      const entity=resolveType(repo,f.target);
      edge(f,entity,"configures_entity_candidate",entity?"inferred":"unresolved",f.target);
      for(const table of facts.filter(v=>v.repo_id===repo&&v.kind==="ef_table"&&v.parent===f.name).slice(0,5))
        edge(f,table,"maps_table","verified_static",table.target);
      for(const prop of facts.filter(v=>v.repo_id===repo&&v.kind==="ef_property"&&v.parent===f.name).slice(0,55))
        edge(f,prop,"maps_entity_property","verified_static",prop.target);
    }
  }
  return count;
}
const PRIORITY={endpoint:0,controller:1,controller_method:2,cqrs_handler:3,cqrs_request:4,method:5,
  ef_context:6,ef_dbset:7,ef_configuration:8,ef_table:9,di_registration:10,
  constructor_dependency:11,mediator_send:12,class:13,record:14,interface:15,
  dto:16,service:17,sql_operation:18,ef_migration_table:19,ef_migration_column:20,method_parameter:21};
const ALIASES=[
 {labels:["tín chỉ","credits"],words:["credit","curriculum","course"]},
 {labels:["học phần","course subject"],words:["course","curriculum"]},
 {labels:["giáo trình","học liệu"],words:["reading","document","curriculum"]},
 {labels:["thiết bị hỗ trợ","điện thoại"],words:["device","phone"]},
];
export function findCsharpFacts(db,query,{repoIds=[],kinds=[],limit=12}={}){
  const lower=query.toLocaleLowerCase("vi"),words=[query];
  for(const group of ALIASES)if(group.labels.some(label=>lower.includes(label)))words.push(...group.words);
  const tokens=[...new Set(words.flatMap(x=>x.replace(/([a-z])([A-Z])/gu,"$1 $2")
    .split(/[\s._/\\-]+/u)).map(x=>x.toLowerCase()).filter(x=>x.length>=2))].slice(0,14);
  if(!tokens.length)return [];
  const repoWhere=repoIds.length?" AND f.repo_id IN ("+repoIds.map(()=>"?").join(",")+")":"";
  const kindWhere=kinds.length?" AND f.kind IN ("+kinds.map(()=>"?").join(",")+")":"";
  const sql="SELECT f.*,files.sha256 FROM csharp_facts f JOIN files ON files.file_id=f.file_id "+
    "WHERE ("+tokens.map(()=>"LOWER(f.name) LIKE ?").join(" OR ")+")"+repoWhere+kindWhere+" LIMIT 1400";
  let rows=db.prepare(sql).all(...tokens.map(t=>"%"+t.replace(/[%_\\]/gu,"")+"%"),...repoIds,...kinds);
  if(/^(GET|POST|PUT|PATCH|DELETE|OPTIONS)\s+\//iu.test(query))
    rows=rows.filter(f=>f.kind==="endpoint" && f.name.toLowerCase().startsWith(lower));
  else if(/^[A-Za-z_][A-Za-z0-9_]+$/u.test(query)&&/[a-z][A-Z]/u.test(query))
    rows=rows.filter(f=>f.name.toLowerCase().includes(lower));
  rows.sort((a,b)=>{
    const na=a.name.toLowerCase(),nb=b.name.toLowerCase();
    const score=x=>x===lower?0:x.includes(lower)?1:2;
    return score(na)-score(nb)||(PRIORITY[a.kind]??30)-(PRIORITY[b.kind]??30)||
      a.name.length-b.name.length;
  });
  return rows.slice(0,limit).map(row);
}
export function getCsharpFact(db,id){return row(db.prepare("SELECT f.*,files.sha256 FROM csharp_facts f JOIN files ON f.file_id=files.file_id WHERE f.id=?").get(id));}
export function traceCsharpGraph(db,starts,{maxDepth=5,maxNodes=85}={}){
  const queue=starts.map(id=>({id,depth:0})),visited=new Set(),nodes=[],edges=[];
  const get=db.prepare("SELECT to_fact,relation,status,target_label FROM csharp_edges WHERE from_fact=? ORDER BY id LIMIT 160");
  while(queue.length&&nodes.length<maxNodes){
    const {id,depth}=queue.shift();
    if(visited.has(id))continue;
    const fact=getCsharpFact(db,id);if(!fact)continue;
    visited.add(id);nodes.push(fact);
    if(depth>=maxDepth)continue;
    for(const e of get.all(id)) {
      if(edges.length>=maxNodes*4)break;
      edges.push({fromId:id,toId:e.to_fact,kind:e.relation,status:e.status,targetLabel:e.target_label});
      if(e.to_fact&&!visited.has(e.to_fact))queue.push({id:e.to_fact,depth:depth+1});
    }
  }
  return {nodes,edges,truncated:queue.length>0||edges.length>=maxNodes*4};
}
