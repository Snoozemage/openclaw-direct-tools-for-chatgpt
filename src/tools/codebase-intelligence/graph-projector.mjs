/**
 * Phase 6: read-only unified evidence graph projector.
 * SQLite integer IDs are internal. Public graph IDs hash source identity and are
 * stable across full reindex of unchanged source, independent of row insertion order.
 * No edge is created from a business alias, search hit or file naming convention.
 */
import {createHash} from "node:crypto";

const SOURCES={
  php:{facts:"php_facts",edges:"php_edges",version:"php"},
  csharp:{facts:"csharp_facts",edges:"csharp_edges",version:"csharp"},
  typescript:{facts:"ts_facts",edges:"ts_edges",version:"typescript"},
};
const PRIORITY={
  next_page:0,next_api_route:0,route:0,endpoint:0,
  export_binding:1,controller:1,controller_method:1,method:2,
  module:3,http_request:3,service_call:3,model:4,ef_dbset:4,
  cqrs_handler:5,class:6,import:7,table_access:8,
};
const HINTS=[
  {test:/\btask\s*19\b|thiết bị hỗ trợ|teaching[\s-]*devices/iu,
   terms:["teaching-devices","allow_phone","course-books/phones"]},
  {test:/\btask\s*18\b|giáo trình|course[\s-]*books/iu,terms:["course-books","reading"]},
];
const ident=x=>String(x??"").normalize("NFKC").toLocaleLowerCase("vi").replace(/[^\p{L}\p{N}]+/gu,"");
const key=(lang,id)=>lang+":"+id;
const digest=x=>createHash("sha256").update(x).digest("hex").slice(0,24);
const bounded=(x,len=100)=>String(x??"").replace(/[\r\n\t]+/gu," ").slice(0,len);
const safeLabel=x=>bounded(x,76).replace(/["<>&|;{}\[\]\\]/gu," ").replace(/[\x00-\x1f]/gu," ").trim();
function fact(row,language,revision){
  let details={};try{details=JSON.parse(row.details??"{}");}catch{}
  const identity=[
    language,row.repo_id,row.relative_path,row.kind,row.name,row.parent??"",row.target??"",row.start_line
  ].join("\0");
  return {
    internalKey:key(language,row.id),
    stableId:"s_"+digest(identity),language,
    repoId:row.repo_id,relativePath:row.relative_path,
    kind:row.kind,name:row.name,parent:row.parent,target:row.target,
    startLine:row.start_line,endLine:row.end_line,sha256:row.sha256,
    status:row.status,details,
    indexRevision:revision,
    provenance:{repoId:row.repo_id,relativePath:row.relative_path,
      startLine:row.start_line,endLine:row.end_line,sha256:row.sha256,indexRevision:revision},
  };
}
function edge(row,lang,from,to,revision){
  return {
    stableId:"e_"+digest([from.stableId,to?.stableId??"",row.relation,row.status,row.target_label??""].join("\0")),
    fromId:from.stableId,toId:to?.stableId??null,
    kind:row.relation,status:row.status,targetLabel:bounded(row.target_label,120),
    indexRevision:revision,
    evidence:{...from.provenance,relation:row.relation},
  };
}
function quotedLike(x){return "%"+x.replace(/[!%_]/gu,c=>"!"+c)+"%";}
function readFact(db,lang,id,revision){
  const {facts}=SOURCES[lang];
  const r=db.prepare("SELECT f.*,fi.sha256 FROM "+facts+" f JOIN files fi ON fi.file_id=f.file_id WHERE f.id=?").get(id);
  return r?fact(r,lang,revision):null;
}
function hintTerms(query){
  const hints=HINTS.find(h=>h.test.test(query));
  return [...new Set([query,...(hints?.terms??[])])].slice(0,5);
}
/**
 * Bounded roots: exact matched symbol/path beats substring. Synonyms only widen
 * retrieval and NEVER create evidence links or verified mapping.
 */
export function selectEvidenceRoots(db,query,{repoIds=[],languages=["php","csharp","typescript"],limit=3,revision=0}={}){
  const needles=hintTerms(query).map(x=>({literal:x,flat:ident(x)}));
  const found=new Map();
  for(const lang of languages){
    const table=SOURCES[lang]?.facts;
    if(!table)continue;
    const where=repoIds.length?" AND f.repo_id IN ("+repoIds.map(()=>"?").join(",")+")":"";
    for(const needle of needles){
      if(!needle.literal.trim())continue;
      const sql="SELECT f.*,fi.sha256 FROM "+table+" f JOIN files fi ON fi.file_id=f.file_id "+
        "WHERE (LOWER(f.name) LIKE ? ESCAPE '!' OR LOWER(f.relative_path) LIKE ? ESCAPE '!')"+where+" LIMIT 280";
      const rows=db.prepare(sql).all(quotedLike(needle.literal.toLocaleLowerCase("vi")),
        quotedLike(needle.literal.toLocaleLowerCase("vi")),...repoIds);
      for(const r of rows){
        const current=fact(r,lang,revision);
        const k=current.internalKey;
        const n=ident(current.name),p=ident(current.relativePath);
        const exact=n===ident(query)?0:n===needle.flat?1:2;
        const score=exact*100+(PRIORITY[current.kind]??30)+
          (n.includes(needle.flat)?0:p.includes(needle.flat)?10:25)+
          (current.kind==="module"?5:0);
        const previous=found.get(k);
        if(!previous||previous.score>score)found.set(k,{fact:current,score});
      }
    }
  }
  return [...found.values()].sort((a,b)=>a.score-b.score||
    a.fact.relativePath.localeCompare(b.fact.relativePath)||a.fact.startLine-b.fact.startLine)
    .slice(0,limit).map(x=>x.fact);
}
export function traverseEvidence(db,roots,{direction="downstream",maxDepth=5,maxNodes=75,maxEdges=380,revision=0,focus=null}={}){
  const focusKey=typeof focus==="string"?ident(focus):"";
  const queue=roots.map(f=>({lang:f.language,id:Number(f.internalKey.split(":").at(-1)),depth:0,
    root:f.stableId,via:null,ancestors:[]}));
  const visited=new Set(),nodes=[],edges=[],gaps=[],parents=new Map(),depthByStable=new Map();
  const cache=new Map(),edgeSet=new Set();
  function read(lang,id){
    const k=key(lang,id);
    if(!cache.has(k))cache.set(k,readFact(db,lang,id,revision));
    return cache.get(k);
  }
  const statements={};
  for(const [lang,{edges:table}] of Object.entries(SOURCES)){
    statements[lang]={
      downstream:db.prepare("SELECT * FROM "+table+" WHERE from_fact=? ORDER BY id LIMIT 90"),
      upstream:db.prepare("SELECT * FROM "+table+" WHERE to_fact=? ORDER BY id LIMIT 90"),
    };
  }
  let truncated=false,cycleCount=0;
  while(queue.length){
    if(nodes.length>=maxNodes){truncated=true;break;}
    const cur=queue.shift(),k=key(cur.lang,cur.id),item=read(cur.lang,cur.id);
    if(!item)continue;
    if(visited.has(k))continue;
    visited.add(k);
    nodes.push(item);depthByStable.set(item.stableId,cur.depth);
    if(cur.via)parents.set(item.stableId,{fromId:cur.via.fromId,
      edgeId:cur.via.edgeId,rootId:cur.root});
    if(cur.depth>=maxDepth)continue;
    const dirs=direction==="both"?["downstream","upstream"]:[direction];
    for(const dir of dirs){
      let adjacent=statements[cur.lang][dir].all(cur.id);
      if(dir==="downstream"&&item.language==="typescript"&&item.kind==="module"&&focusKey.length>=5){
        const relevant=adjacent.filter(raw=>{
          const to=raw.to_fact==null?null:read(cur.lang,raw.to_fact);
          if(!to)return false;
          const spec=to.details?.specifier??"";
          return ident(to.name+" "+spec).includes(focusKey);
        });
        if(relevant.length)adjacent=relevant;
      }
      for(const raw of adjacent){
        if(edges.length>=maxEdges){truncated=true;break;}
        const from=read(cur.lang,raw.from_fact),to=raw.to_fact==null?null:read(cur.lang,raw.to_fact);
        if(!from)continue;
        const e=edge(raw,cur.lang,from,to,revision);
        if(edgeSet.has(e.stableId))continue;
        edgeSet.add(e.stableId);
        if(!to){
          // Preserve unresolved reference as an explicit GAP, never fabricate a node.
          if(gaps.length<80)gaps.push({fromId:from.stableId,
            kind:e.kind,status:"unresolved",targetLabel:e.targetLabel,evidence:e.evidence});
          continue;
        }
        edges.push(e);
        const other=dir==="downstream"?to:from;
        const otherId=dir==="downstream"?raw.to_fact:raw.from_fact;
        const otherKey=key(cur.lang,otherId);
        if(cur.ancestors.includes(otherKey)||otherKey===k)cycleCount++;
        else if(!visited.has(otherKey)&&!queue.some(x=>x.lang===cur.lang&&x.id===otherId))
          queue.push({lang:cur.lang,id:otherId,depth:cur.depth+1,root:cur.root,
            via:{fromId:item.stableId,edgeId:e.stableId},ancestors:[...cur.ancestors,k]});
      }
      if(truncated)break;
    }
    if(truncated)break;
  }
  return {nodes,edges,gaps,roots:roots.map(x=>x.stableId),
    parents:Object.fromEntries(parents),depthByStable:Object.fromEntries(depthByStable),
    direction,maxDepth,maxNodes,truncated:truncated||queue.length>0,cycleCount,
    indexRevision:revision};
}
export function redactStaleGraph(graph,checkedNodes){
  const verified=new Map(checkedNodes.filter(n=>n.freshness==="verified_current_hash").map(n=>[n.stableId,n]));
  const stale=checkedNodes.filter(n=>n.freshness!=="verified_current_hash")
    .map(n=>({stableId:n.stableId,repoId:n.repoId,relativePath:n.relativePath,reason:"source_hash_changed_or_unavailable"}));
  const edges=graph.edges.filter(x=>verified.has(x.fromId)&&verified.has(x.toId));
  const gaps=graph.gaps.filter(x=>verified.has(x.fromId));
  const roots=graph.roots.filter(x=>verified.has(x));
  const parents=Object.fromEntries(Object.entries(graph.parents)
    .filter(([id,p])=>verified.has(id)&&verified.has(p.fromId)));
  return {...graph,nodes:[...verified.values()],edges,gaps,roots,parents,
    stale,staleCount:stale.length,staleFilteredEdges:graph.edges.length-edges.length,
    sourceVerified:true,coverageIncomplete:graph.truncated||stale.length>0};
}
function diagram(nodes,edges,{title="Source evidence",maxChars=17500}={}){
  const index=new Map(nodes.map((n,i)=>[n.stableId,"n"+String(i).padStart(3,"0")]));
  const content=["flowchart LR","%% Read-only evidence projection; NOT a runtime/deployment topology."];
  for(const [i,n] of nodes.entries()){
    const label=safeLabel((n.kind? n.kind+" · ":"")+n.name||n.repoId);
    content.push("  n"+String(i).padStart(3,"0")+'["'+label+'"]');
  }
  for(const e of edges){
    const a=index.get(e.fromId),b=index.get(e.toId);
    if(!a||!b)continue;
    const rel=safeLabel(e.kind)+(e.status==="verified_static"?" · static":" · candidate");
    content.push("  "+a+(e.status==="verified_static"?" -->":" -.->")+'|'+rel+'| '+b);
  }
  const output=content.join("\n");
  return output.length<=maxChars?output:content.filter((v,i)=>i<=nodes.length+1).join("\n")+
    "\n%% Edges omitted from Mermaid due to output budget; inspect graph.edges.";
}
function groupFor(node){
  const p=node.relativePath.replace(/\\/gu,"/");
  if(node.language==="typescript"){
    const page=node.kind==="next_page"||node.kind==="next_api_route";
    if(page)return {key:"route:"+node.repoId+":"+node.name,title:"Next route "+node.name,type:"next_route_source"};
    const match=p.match(/(?:^|\/)features\/([^/]+)/u);
    if(match)return {key:node.repoId+":feature:"+match[1],title:"Feature "+match[1],type:"feature_source_candidate"};
    const service=p.match(/(?:^|\/)services\/([^/]+)/u);
    if(service)return {key:node.repoId+":service:"+service[1],title:"Service "+service[1],type:"service_adapter_source"};
    const mod=p.match(/(?:^|\/)app\/(?:\([^)]*\)\/)*([^/]+)/u);
    if(mod)return {key:node.repoId+":app:"+mod[1],title:"App area "+mod[1],type:"app_area_candidate"};
  }
  if(node.language==="csharp"){
    const api=p.match(/Controllers\/([^/]+Controller)\.cs$/u);
    if(api)return {key:node.repoId+":controller:"+api[1],title:"API "+api[1],type:"api_controller_source"};
    const feature=p.match(/Features\/([^/]+)/u);
    if(feature)return {key:node.repoId+":application:"+feature[1],title:"Application "+feature[1],type:"application_feature_candidate"};
    if(/Infrastructure\/Persistence\//u.test(p))return {key:node.repoId+":ef",title:"EF persistence",type:"persistence_source_candidate"};
  }
  if(node.language==="php"){
    const routes=p.match(/(?:^|\/)routes\/([^/]+)/u);
    if(routes)return {key:node.repoId+":routes:"+routes[1],title:"Legacy routes "+routes[1],type:"route_source"};
    const ctrl=p.match(/(?:^|\/)Controllers\/([^/]+)\.php$/u);
    if(ctrl)return {key:node.repoId+":controller:"+ctrl[1],title:"Legacy controller "+ctrl[1],type:"controller_source"};
    if(/(?:^|\/)Models?\//u.test(p))return {key:node.repoId+":models",title:"Legacy models",type:"model_source_candidate"};
    // Non-Laravel PHP applications commonly organize code under src/<module>.
    // This is a source-path component candidate, never proof of a runtime boundary.
    const module=p.match(/^src\/([^/]+)\/(?:([^/]+)\/)?[^/]+\.php$/u);
    if(module){
      const area=module[1];
      const subarea=module[2]??"";
      const name=area+(subarea?" / "+subarea:"");
      return {key:node.repoId+":php-module:"+name,
        title:"PHP module "+name,type:"php_namespace_module_candidate"};
    }
    const services=p.match(/^(?:app|src)\/(Services|Middleware|Console)\/([^/]+)\.php$/u);
    if(services)return {key:node.repoId+":php-area:"+services[1],
      title:"PHP "+services[1],type:"php_source_area_candidate"};
  }
  return {key:node.repoId+":file:"+p,title:"File "+p.split("/").at(-1),type:"unclassified_source"};
}
export function projectC4FromGraph(graph,{level="C4",maxNodes=65,projectId=""}={}){
  if(!["C3","C4"].includes(level))throw new TypeError("Graph projection level must be C3 or C4.");
  if(level==="C4"){
    const nodes=graph.nodes.slice(0,maxNodes).map(n=>({
      stableId:n.stableId,label:bounded(n.name,125),type:n.kind,language:n.language,
      repoId:n.repoId,status:n.status,source:n.provenance,
    }));
    const allowed=new Set(nodes.map(n=>n.stableId));
    const edges=graph.edges.filter(e=>allowed.has(e.fromId)&&allowed.has(e.toId));
    return {projectId,level,mode:"static_code_view",nodes,edges,
      mermaid:diagram(nodes.map(n=>({...n,name:n.label,kind:n.type})),edges),
      truncated:graph.truncated||nodes.length<graph.nodes.length,
      unresolved:graph.gaps,stale:graph.stale??[],
      legend:{solid:"verified_static source reference; NOT runtime call",
        dashed:"inferred/static candidate; NOT verified runtime",missing:"unresolved omitted arrow"},
      interpretation:"C4 Code view: source symbols and static references only. Full runtime data flow is not implied."};
  }
  const groups=new Map(),byNode=new Map();
  for(const n of graph.nodes){
    const g=groupFor(n);
    if(!groups.has(g.key))groups.set(g.key,{stableId:"c_"+digest(g.key),label:g.title,
      type:g.type,repoId:n.repoId,sourceEvidence:[],status:"logical_source_group_needs_review"});
    const dest=groups.get(g.key);
    byNode.set(n.stableId,dest.stableId);
    if(dest.sourceEvidence.length<5)dest.sourceEvidence.push(n.provenance);
  }
  const aggregate=new Map();
  for(const e of graph.edges){
    const fromId=byNode.get(e.fromId),toId=byNode.get(e.toId);
    if(!fromId||!toId||fromId===toId)continue;
    const k=fromId+"\0"+toId+"\0"+e.kind;
    if(!aggregate.has(k))aggregate.set(k,{...e,fromId,toId,
      stableId:"a_"+digest(k),evidence:[e.evidence],status:e.status});
    else{
      const a=aggregate.get(k);
      if(a.evidence.length<5)a.evidence.push(e.evidence);
      if(a.status!=="inferred"&&e.status!=="verified_static")a.status=e.status;
    }
  }
  const nodes=[...groups.values()].slice(0,maxNodes),valid=new Set(nodes.map(n=>n.stableId));
  const edges=[...aggregate.values()].filter(e=>valid.has(e.fromId)&&valid.has(e.toId));
  return {projectId,level,mode:"logical_component_candidates",nodes,edges,
    mermaid:diagram(nodes.map(n=>({...n,name:n.label,kind:n.type})),edges),
    truncated:graph.truncated||groups.size>maxNodes,
    unresolved:graph.gaps,stale:graph.stale??[],
    legend:{solid:"static dependency/reference",dashed:"inferred or ambiguous",
      boundary:"Group is a heuristic source boundary; manual C3 component review required"},
    interpretation:"C3 component groups are heuristics over indexed feature/service sources, not verified runtime component boundaries."};
}
export function projectC1(project,revision,{curated=null}={}){
  const system={stableId:"sys_"+digest(project.id??project.projectId),
    label:bounded(project.name||project.projectId||"Registered system",120),
    kind:"registered_project_scope",type:"registered_project_scope",
    status:"curated_project_label_only",
    evidence:{origin:"project_registry",indexRevision:revision}};
  const nodes=[system],idToStable=new Map([["system",system.stableId]]);
  for(const actor of curated?.actors??[]){
    const n={stableId:"actor_"+digest(actor.id),label:actor.label,name:actor.label,
      kind:"manually_curated_actor",type:"actor",status:"curated_unverified",
      evidence:{origin:"local_curated_context",indexRevision:revision}};
    nodes.push(n);idToStable.set(actor.id,n.stableId);
  }
  for(const ext of curated?.externalSystems??[]){
    // A code reference to Masterdata/etc is NOT proof of deployed external integration.
    const n={stableId:"ext_"+digest(ext.id),label:ext.label,name:ext.label,
      kind:"source_referenced_external_candidate",type:"external_system_candidate",
      status:"curated_source_reference_not_runtime",evidence:ext.evidence};
    nodes.push(n);idToStable.set(ext.id,n.stableId);
  }
  const edges=[];
  for(const rel of curated?.relationships??[]){
    const fromId=idToStable.get(rel.from),toId=idToStable.get(rel.to);
    if(!fromId||!toId)continue;
    edges.push({stableId:"relation_"+digest(fromId+"\0"+toId+"\0"+rel.label),
      fromId,toId,kind:"curated_relation_candidate",status:"inferred",
      targetLabel:rel.label,evidence:rel.evidence});
  }
  const incomplete=curated?.status!=="curated_source_references";
  const missingEvidence=[
    "Registered source repositories and a source reference do not verify system/deployment boundaries.",
    "No actors or external system relationships are invented when curated, source-backed metadata is absent.",
    ...(curated?.status==="not_configured"||!curated?[
      "Optional contexts/<projectId>.json has not been configured; no actors/external systems are asserted."]:[]),
    ...(curated?.errors??[]),
  ];
  return {level:"C1",mode:incomplete?"system_context_incomplete":"curated_system_context_candidate",
    nodes,edges,mermaid:diagram(nodes.map(n=>({...n,name:n.label})),edges),
    contextStatus:curated?.status??"not_configured",missingEvidence,
    legend:{system:"Project registry is a curated system label.",
      actor:"Actor is manually curated, not verified from source.",
      external:"External candidate requires current source-line evidence; runtime remains unverified.",
      dashed:"Curated relationship, not evidence of runtime communication."},
    interpretation:"C1 is curated, not inferred from file names. Runtime actors/systems/connections remain unverified unless separately validated."};
}
export function projectC2(project,db,revision,{contracts=[]}={}){
  const snaps=new Map(db.prepare("SELECT repo_id,branch,head_sha FROM repo_snapshots").all()
    .map(x=>[x.repo_id,x]));
  const files=db.prepare("SELECT relative_path,file_id,sha256 FROM files WHERE repo_id=? ORDER BY relative_path");
  const chunks=db.prepare("SELECT body,start_line FROM chunks WHERE file_id=? ORDER BY start_line LIMIT 12");
  const nodes=[],missingEvidence=[
    "No deployment manifest, reverse-proxy config or running-process evidence was verified.",
    "No database container is inferred solely from EF migrations, connection class names or SQL references.",
    "HTTP method/path candidates do not confirm a deployed FE→BE connection.",
  ];
  function nodeFor(repo,manifest=null,kind="source_repository"){
    const pathName=manifest?.relative_path??"";
    const stem=["nextjs_package","laravel_composer"].includes(kind)?repo.id:
      pathName.split("/").at(-1)?.replace(/\.(?:csproj|json)$/u,"")??repo.id;
    const runtime=kind==="aspnet_web_project"?"ASP.NET API project":
      kind==="nextjs_package"?"Next.js application source":
      kind==="laravel_composer"?"Laravel application source":"Unclassified repository source";
    const entry={
      stableId:"container_"+digest(repo.id+"\0"+pathName),
      repoId:repo.id,manifestPath:pathName||null,
      name:manifest?stem:repo.id,label:bounded(stem+" · "+runtime,120),
      kind,type:"logical_container_candidate",
      status:"deployment_unverified",
      source:{origin:manifest?"indexed_project_manifest":"registered_repository",
        repoId:repo.id,relativePath:pathName||null,sha256:manifest?.sha256??null,
        freshness:"not_checked_against_worktree",
        snapshot:snaps.get(repo.id)??null,indexRevision:revision},
      languages:repo.languages,
    };
    nodes.push(entry);
  }
  for(const repo of project.repositories){
    const manifests=files.all(repo.id);
    const config=manifest=>chunks.all(manifest.file_id)
      .map(c=>c.body).join("\n").slice(0,20000);
    if(repo.languages.includes("csharp")){
      // Only actual ASP.NET SDK project manifests are runtime app candidates.
      // Application, Domain, Infrastructure and UnitTests class libraries are NOT C2 containers.
      const web=manifests.filter(f=>f.relative_path.endsWith(".csproj")&&
        !/(?:^|\/)tests?\//iu.test(f.relative_path)&&
        /<Project\s+Sdk=["']Microsoft\.NET\.Sdk\.Web["']/iu.test(config(f)));
      if(web.length)for(const m of web.slice(0,7))nodeFor(repo,m,"aspnet_web_project");
      else nodeFor(repo);
    }else if(repo.languages.includes("typescript")){
      const app=manifests.filter(f=>f.relative_path==="package.json"&&
        /["']next["']\s*:/iu.test(config(f)));
      if(app.length)nodeFor(repo,app[0],"nextjs_package");
      else nodeFor(repo);
    }else if(repo.languages.includes("php")){
      const app=manifests.filter(f=>f.relative_path==="composer.json"&&
        /laravel\/framework/iu.test(config(f)));
      if(app.length)nodeFor(repo,app[0],"laravel_composer");
      else nodeFor(repo);
    }else nodeFor(repo);
  }
  function choose(repoId,codePath=""){
    const candidates=nodes.filter(n=>n.repoId===repoId);
    if(candidates.length===1)return candidates[0];
    const hit=candidates.filter(n=>n.manifestPath&&codePath.startsWith(
      n.manifestPath.replace(/\/[^/]+$/u,"")+"/"));
    return hit.length===1?hit[0]:null;
  }
  const edges=[],ambiguousTargets=[];
  const emitted=new Map();
  for(const c of contracts.slice(0,30)){
    const from=choose(c.frontend.repoId,c.frontend.relativePath);
    const to=choose(c.backend.repoId,c.backend.relativePath);
    if(!from||!to){
      ambiguousTargets.push({frontend:c.frontend.relativePath,backend:c.backend.relativePath,
        reason:"multiple_runtime_candidates_or_missing_manifest"});
      continue;
    }
    const k=[from.stableId,to.stableId,c.frontend.httpMethod,c.frontend.normalizedPath].join("\0");
    const proof=[{repoId:c.frontend.repoId,relativePath:c.frontend.relativePath,startLine:c.frontend.line},
      {repoId:c.backend.repoId,relativePath:c.backend.relativePath,startLine:c.backend.line}];
    if(emitted.has(k)){
      const e=emitted.get(k);
      e.candidateEndpointCount++;
      if(e.evidence.length<8)e.evidence.push(...proof);
      continue;
    }
    const edge={
      stableId:"contract_"+digest(k),fromId:from.stableId,toId:to.stableId,
      kind:"static_http_contract_candidate",status:"inferred",
      targetLabel:c.frontend.httpMethod+" "+c.frontend.normalizedPath,
      candidateEndpointCount:1,evidence:proof,
    };
    emitted.set(k,edge);edges.push(edge);
  }
  return {level:"C2",mode:"logical_runtime_candidates_unverified",
    nodes,edges,mermaid:diagram(nodes,edges),ambiguousTargets,
    missingEvidence,legend:{node:"Indexed framework manifest → LOGICAL C2 container candidate",
      dashed:"HTTP method/path candidate only; NOT a verified runtime connection",
      excluded:"Class libraries and database migrations are not separate runtime containers"},
    interpretation:"C2 candidates use web project manifests (ASP.NET Web SDK, Next package, Laravel composer) where indexed; they are not deployment verification."};
}
export function indexedTestCandidates(db,query,{repoIds=[],limit=12}={}){
  const terms=hintTerms(query).map(ident).filter(x=>x.length>=4);
  if(!terms.length)return [];
  const clauses=repoIds.length?" WHERE repo_id IN ("+repoIds.map(()=>"?").join(",")+")":"";
  const rows=db.prepare("SELECT repo_id,relative_path,sha256 FROM files"+clauses+
    " ORDER BY repo_id,relative_path LIMIT 6000").all(...repoIds);
  const testPath=/(?:^|\/)(?:tests?|__tests__)\/|(?:\.test|\.spec)\.(?:php|cs|ts|tsx)$|\.UnitTests\.csproj$|\.IntegrationTests\.csproj$/iu;
  return rows.filter(f=>testPath.test(f.relative_path)&&terms.some(term=>
      ident(f.relative_path).includes(term))).slice(0,limit).map(f=>({
    repoId:f.repo_id,relativePath:f.relative_path,sha256:f.sha256,
    status:"test_file_name_candidate_only",matchedBy:"indexed_test_filename_not_proven_coverage",
  }));
}
export function classifyImpact(graph){
  const roots=new Set(graph.roots),facts=new Map(graph.nodes.map(n=>[n.stableId,n]));
  const rootFiles=new Set([...roots].map(id=>facts.get(id)).filter(Boolean)
    .map(n=>n.repoId+":"+n.relativePath));
  const adjacency=new Map();
  for(const e of graph.edges){
    const from=graph.direction==="upstream"?e.toId:e.fromId;
    const to=graph.direction==="upstream"?e.fromId:e.toId;
    if(!adjacency.has(from))adjacency.set(from,[]);
    adjacency.get(from).push({...e,traversalFrom:from,traversalTo:to});
    if(graph.direction==="both"){
      if(!adjacency.has(to))adjacency.set(to,[]);
      adjacency.get(to).push({...e,traversalFrom:to,traversalTo:from});
    }
  }
  const queue=[...roots].map(id=>({id,depth:0,potential:false,path:[]})),best=new Map();
  while(queue.length){
    const curr=queue.shift();
    if(curr.depth>graph.maxDepth)continue;
    const prev=best.get(curr.id);
    if(prev&&prev.depth<=curr.depth&&(!prev.potential||curr.potential))continue;
    best.set(curr.id,curr);
    for(const e of adjacency.get(curr.id)??[]){
      if(curr.path.some(x=>x.edgeId===e.stableId))continue;
      if(curr.depth+1>graph.maxDepth)continue;
      queue.push({id:e.traversalTo,depth:curr.depth+1,
        potential:curr.potential||e.status!=="verified_static",
        path:[...curr.path,{edgeId:e.stableId,kind:e.kind,status:e.status,
          source:e.evidence,fromId:e.traversalFrom,toId:e.traversalTo}].slice(0,graph.maxDepth)});
    }
  }
  const direct=[],indirect=[],potential=[];
  const dedupFiles=new Map();
  for(const [id,state] of best){
    if(roots.has(id))continue;
    const node=facts.get(id);if(!node)continue;
    const filename=node.repoId+":"+node.relativePath;
    // Intra-file symbols are context of the changed file, not a separate affected file.
    if(rootFiles.has(filename))continue;
    const crossFileHops=state.path.filter(step=>{
      const a=facts.get(step.fromId),b=facts.get(step.toId);
      return a&&b&&(a.repoId!==b.repoId||a.relativePath!==b.relativePath);
    }).length;
    const directImpact=crossFileHops<=1;
    const entry={stableId:id,repoId:node.repoId,relativePath:node.relativePath,
      line:node.startLine,kind:node.kind,name:node.name,depth:state.depth,crossFileHops,
      status:state.potential?"potential_inferred":directImpact?"direct_static_dependency":"indirect_static_dependency",
      reason:state.path.map(p=>p.kind+" ("+p.status+")").join(" → "),
      evidencePath:state.path,source:node.provenance};
    const group=entry.status==="potential_inferred"?potential:directImpact?direct:indirect;
    group.push(entry);
    if(!dedupFiles.has(filename)||dedupFiles.get(filename).depth>entry.depth)dedupFiles.set(filename,entry);
  }
  const order=(a,b)=>a.depth-b.depth||a.relativePath.localeCompare(b.relativePath);
  direct.sort(order);indirect.sort(order);potential.sort(order);
  return {rootIds:[...roots],direction:graph.direction,direct,indirect,potential,
    impactedFiles:[...dedupFiles.values()].sort(order),
    gaps:graph.gaps,stale:graph.stale??[],truncated:graph.truncated,
    limitations:["Impact is a bounded static dependency projection, not proof that tests fail or runtime behavior changes.",
      "Import edges signify module dependency, not runtime call execution.",
      "Potential impacts include inferred edges; absence from the graph does not prove no impact."]};
}
