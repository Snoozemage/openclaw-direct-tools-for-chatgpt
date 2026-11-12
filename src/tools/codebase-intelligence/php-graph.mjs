/**
 * PHP AST facts and evidence-only links.
 * The graph describes static source relationships, not runtime data flows.
 */
export function readPhpAdapterVersion(db) {
  try { return db.prepare("SELECT value FROM php_meta WHERE key='adapter_version'").get()?.value ?? null; }
  catch (e) { if (/no such table/iu.test(e?.message??"")) return null; throw e; }
}
export function savePhpAdapterVersion(db, version) {
  db.prepare("INSERT OR REPLACE INTO php_meta(key,value) VALUES('adapter_version',?)").run(version);
}
export function deletePhpFileFacts(db, fileId) {
  db.prepare("DELETE FROM php_parse_errors WHERE file_id=?").run(fileId);
  db.prepare("DELETE FROM php_facts WHERE file_id=?").run(fileId);
}
export function insertPhpFileFacts(db, file, facts, parseError=null) {
  const fileId=file.repoId+":"+file.relativePath;
  deletePhpFileFacts(db,fileId);
  if(parseError) {
    db.prepare("INSERT INTO php_parse_errors(file_id,code,updated_at) VALUES(?,?,?)")
      .run(fileId,parseError.slice(0,80),new Date().toISOString());
    return;
  }
  const add=db.prepare("INSERT INTO php_facts "+
    "(file_id,repo_id,relative_path,kind,name,parent,target,start_line,end_line,status,details) "+
    "VALUES(?,?,?,?,?,?,?,?,?,?,?)");
  for(const f of facts) {
    const details=JSON.stringify(f.details??{});
    add.run(fileId,file.repoId,file.relativePath,f.kind,f.name.slice(0,600),
      f.parent?.slice(0,600)??null,f.target?.slice(0,600)??null,
      f.startLine,f.endLine,f.status,details.slice(0,4800));
  }
}
export function getPhpCounts(db) {
  try {
    return {
      facts:db.prepare("SELECT count(*) AS n FROM php_facts").get().n,
      edges:db.prepare("SELECT count(*) AS n FROM php_edges").get().n,
      parseErrors:db.prepare("SELECT count(*) AS n FROM php_parse_errors").get().n,
      filesWithFacts:db.prepare("SELECT count(DISTINCT file_id) AS n FROM php_facts").get().n,
    };
  } catch(e) {
    if(/no such table/iu.test(e?.message??"")) return {facts:0,edges:0,parseErrors:0,filesWithFacts:0};
    throw e;
  }
}
const PRIORITY={route:0,model:1,class:2,method:3,model_table:4,
  eloquent_relation:5,migration_table:6,table_access:7,table_operation:7,model_field:8,
  migration_column:9,static_call:10,blade_route_reference:11,view_file:12,view_render:13,trait:14,interface:15};

export function rebuildPhpEdges(db) {
  db.prepare("DELETE FROM php_edges").run();
  const facts=db.prepare("SELECT id,repo_id,file_id,kind,name,parent,target,status,details FROM php_facts").all();
  const bySymbol=new Map(),byTable=new Map(),byRouteName=new Map();
  const push=(map,key,value)=>map.set(key,[...(map.get(key)??[]),value]);
  for(const f of facts) {
    if(["class","method","model","interface","view_file"].includes(f.kind)) {
      push(bySymbol,f.repo_id+"\0"+f.kind+"\0"+f.name,f);
    }
    if(f.kind==="migration_table" && f.target)push(byTable,f.repo_id+"\0"+f.target,f);
    if(f.kind==="route") {
      let metadata={};try {metadata=JSON.parse(f.details);} catch {}
      if(metadata.routeName)push(byRouteName,f.repo_id+"\0"+metadata.routeName,f);
    }
  }
  const select=(repo,kind,name)=>bySymbol.get(repo+"\0"+kind+"\0"+name)??[];
  const one=(repo,kind,name)=>{const values=select(repo,kind,name);return values.length===1?values[0]:null;};
  const seen=new Set();
  const add=db.prepare("INSERT INTO php_edges(from_fact,to_fact,relation,status,target_label) VALUES(?,?,?,?,?)");
  let count=0;
  function edge(from,to,relation,status,label=null) {
    if(count>=55_000)return;
    const key=from.id+"\0"+(to?.id??0)+"\0"+relation+"\0"+(label??"");
    if(seen.has(key))return;
    seen.add(key);
    add.run(from.id,to?.id??null,relation,status,label);
    count++;
  }
  for(const f of facts) {
    const repo=f.repo_id;
    if(f.kind==="blade_route_reference" && f.parent) {
      const template=one(repo,"view_file",f.parent);
      if(template)edge(template,f,"contains_named_route_reference","verified_static",f.name);
    }
    if(f.kind==="blade_route_reference" && f.target) {
      const candidates=byRouteName.get(repo+"\0"+f.target)??[];
      const route=candidates.length===1?candidates[0]:null;
      edge(f,route,"named_route_reference",route?"inferred":"unresolved",f.target);
    }
    if(f.kind==="view_render" && f.target) {
      const template=one(repo,"view_file",f.target);
      edge(f,template,"candidate_view_path",template?"inferred":"unresolved",f.target);
    }
    if(f.kind==="route" && f.target) {
      const method=one(repo,"method",f.target);
      edge(f,method,"route_handler",!method?"unresolved":
        f.status==="verified_static"?"verified_static":"inferred",f.target);
    }
    if(["static_call","table_access","table_operation","view_render","eloquent_relation"].includes(f.kind) && f.parent) {
      const method=one(repo,"method",f.parent);
      if(method)edge(method,f,"contains_source_reference","verified_static",f.name);
    }
    if(f.kind==="static_call" && f.target) {
      const className=f.target.split("@")[0];
      const model=one(repo,"model",className);
      if(model)edge(f,model,"references_model_class","inferred",className);
      else {
        const method=one(repo,"method",f.target);
        if(method)edge(f,method,"references_static_method","inferred",f.target);
      }
    }
    if(f.kind==="eloquent_relation" && f.target) {
      const model=one(repo,"model",f.target);
      edge(f,model,"eloquent_relation_target",model && f.status==="verified_static"?"verified_static":"unresolved",f.target);
    }
    if(f.kind==="model_field" && f.parent) {
      const model=one(repo,"model",f.parent);
      if(model)edge(model,f,"declares_fillable","verified_static",f.name);
    }
    if(f.kind==="model_table" && f.parent) {
      const model=one(repo,"model",f.parent);
      if(model)edge(model,f,"declares_table","verified_static",f.target);
    }
    if(["model_table","table_access","table_operation"].includes(f.kind) && f.target) {
      for(const table of (byTable.get(repo+"\0"+f.target)??[]).slice(0,4)) {
        edge(f,table,"possible_schema_reference","inferred",f.target);
      }
    }
    if(f.kind==="migration_column" && f.parent) {
      for(const m of byTable.get(repo+"\0"+f.parent)??[]) {
        if(m.file_id===f.file_id)edge(m,f,"declares_column","verified_static",f.name);
      }
    }
  }
  return count;
}

function rowAsFact(row) {
  if(!row)return null;
  let details={};
  try{details=JSON.parse(row.details);}catch{}
  return {id:row.id,repoId:row.repo_id,relativePath:row.relative_path,
    kind:row.kind,name:row.name,parent:row.parent,target:row.target,
    status:row.status,startLine:row.start_line,endLine:row.end_line,sha256:row.sha256,details};
}
// Retrieval-only bilingual aliases. Never evidence of business equivalence.
const ALIASES=[
  {labels:["giáo trình","học liệu","tài liệu học phần","course books"],terms:["CourseBook","course-books"]},
  {labels:["thiết bị hỗ trợ","điện thoại","teaching devices"],terms:["phone","CourseBook","allow_phone"]},
  {labels:["học phần","khóa học","course subject"],terms:["CourseSubject","course-subjects"]},
  {labels:["tín chỉ","credits","số tín chỉ"],terms:["credit","CourseSubject"]},
];
function expandQuery(query) {
  const lower=query.toLocaleLowerCase("vi");
  const terms=[query];
  for(const a of ALIASES)if(a.labels.some(label=>lower.includes(label)))terms.push(...a.terms);
  return [...new Set(terms)].slice(0,8);
}
export function findPhpFacts(db,query,{repoIds=[],kinds=[],limit=25}={}) {
  const terms=expandQuery(query).flatMap(word=>word.replace(/([a-z])([A-Z])/gu,"$1 $2")
      .split(/[\s_\-\/.]+/u)).filter(word=>word.length>1).slice(0,12);
  if(!terms.length)return [];
  const repoWhere=repoIds.length?" AND f.repo_id IN ("+repoIds.map(()=>"?").join(",")+")":"";
  const kindWhere=kinds.length?" AND f.kind IN ("+kinds.map(()=>"?").join(",")+")":"";
  const sql="SELECT f.*, files.sha256 FROM php_facts f JOIN files ON files.file_id=f.file_id "+
    "WHERE ("+terms.map(()=>"lower(f.name) LIKE ?").join(" OR ")+")"+repoWhere+kindWhere+" LIMIT 1200";
  const params=[...terms.map(t=>"%"+t.toLowerCase().replace(/[%_\\]/gu,"")+"%"),...repoIds,...kinds];
  let rows=db.prepare(sql).all(...params);
  const lower=query.toLowerCase();
  // An explicit HTTP route locator must not fall back to unrelated controllers
  // that merely contain common tokens such as GET or admin.
  if (/^(?:GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\s+\//iu.test(query)) {
    rows=rows.filter(f=>f.kind==="route" && f.name.toLowerCase().startsWith(lower));
  }
  rows.sort((a,b)=>{
    const x=a.name.toLowerCase(),y=b.name.toLowerCase();
    const ex=(x===lower?1:0)-(y===lower?1:0);if(ex)return -ex;
    const inc=(x.includes(lower)?1:0)-(y.includes(lower)?1:0);if(inc)return -inc;
    const xTail=x.split(/[\\@]/u).at(-1),yTail=y.split(/[\\@]/u).at(-1);
    if ((xTail===lower)!==(yTail===lower))return xTail===lower?-1:1;
    return (PRIORITY[a.kind]??15)-(PRIORITY[b.kind]??15)||a.name.length-b.name.length;
  });
  return rows.slice(0,limit).map(rowAsFact);
}
export function getPhpFact(db,id) {
  return rowAsFact(db.prepare("SELECT f.*, files.sha256 FROM php_facts f "+
    "JOIN files ON files.file_id=f.file_id WHERE f.id=?").get(id));
}
export function tracePhpGraph(db,startIds,{maxDepth=5,maxNodes=70}={}) {
  const visited=new Set(),queue=startIds.map(id=>({id,depth:0})),nodes=[],edges=[];
  const byFrom=db.prepare("SELECT to_fact,relation,status,target_label FROM php_edges WHERE from_fact=? ORDER BY id LIMIT 80");
  while(queue.length && nodes.length<maxNodes) {
    const {id,depth}=queue.shift();
    if(visited.has(id))continue;
    const f=getPhpFact(db,id);
    if(!f)continue;
    visited.add(id);nodes.push(f);
    if(depth>=maxDepth)continue;
    for(const e of byFrom.all(id)) {
      if(edges.length>=maxNodes*3)break;
      edges.push({fromId:id,toId:e.to_fact,kind:e.relation,status:e.status,targetLabel:e.target_label});
      if(e.to_fact && !visited.has(e.to_fact))queue.push({id:e.to_fact,depth:depth+1});
    }
  }
  return {nodes,edges,truncated:queue.length>0||edges.length>=maxNodes*3};
}
export function getPhpErrors(db,limit=20) {
  return db.prepare("SELECT e.file_id,e.code,f.relative_path AS relativePath FROM php_parse_errors e "+
    "JOIN files f ON f.file_id=e.file_id ORDER BY e.file_id LIMIT ?").all(limit);
}
