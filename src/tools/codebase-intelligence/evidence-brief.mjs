import {ProjectRegistryError} from "./registry.mjs";
import {projectC4FromGraph} from "./graph-projector.mjs";

const DOCS_UNAVAILABLE=new Set(["DOC_SCOPE_MISSING","DOC_INDEX_MISSING","DOC_SCOPE_CHANGED"]);

function sourceCandidates(searchResults,notes,query,limit){
  const exact=searchResults.filter(x=>x.freshness==="verified_current_hash"&&
    x.sourceMatch==="verified_exact_basename");
  const normal=searchResults.filter(x=>x.freshness==="verified_current_hash"&&
    x.sourceMatch!=="verified_exact_basename");
  // Notes are navigation claims, not proof that a queried feature is implemented.
  const noteLinks=(notes??[]).filter(x=>x.evidenceType===
    "verified_source_path_cited_by_note_not_runtime_link").map(x=>({
      repoId:x.repoId,relativePath:x.relativePath,sha256:x.sha256,
      freshness:"verified_current_hash",evidenceType:x.evidenceType,
      confidence:x.confidence,citingNotes:x.citingNotes,
      sourceMatch:"note_cited_source_path_candidate",
    }));
  // On Vietnamese business questions, note vocabulary is often the only bridge
  // to English code identifiers. Exact file/symbol matches always win.
  const ordered=/[à-ỹđ]/iu.test(query)?
    [...exact,...noteLinks,...normal]:[...exact,...normal,...noteLinks];
  const unique=new Set();
  return ordered.filter(x=>{
    const k=x.repoId+":"+x.relativePath;
    if(unique.has(k))return false;
    unique.add(k);return true;
  }).slice(0,limit);
}

function summarizeGraph(graph){
  const files=new Map();
  for(const node of graph.nodes){
    const key=node.repoId+":"+node.relativePath;
    if(!files.has(key))files.set(key,{repoId:node.repoId,
      relativePath:node.relativePath,sha256:node.sha256,
      freshness:node.freshness});
  }
  return {
    rootEvidence:graph.rootEvidence,
    sourceFiles:[...files.values()].slice(0,20),
    nodeCount:graph.nodes.length,edgeCount:graph.edges.length,
    nodes:graph.nodes.slice(0,32).map(x=>({
      id:x.stableId,kind:x.kind,name:x.name,repoId:x.repoId,
      relativePath:x.relativePath,startLine:x.startLine,endLine:x.endLine,
      status:x.status,freshness:x.freshness,
    })),
    edges:graph.edges.slice(0,40).map(x=>({
      fromId:x.fromId,toId:x.toId,kind:x.kind,status:x.status,
      evidence:{repoId:x.evidence?.repoId,relativePath:x.evidence?.relativePath,
        startLine:x.evidence?.startLine},
    })),
    gaps:graph.gaps.slice(0,8),
    stale:graph.stale.slice(0,8),
    truncated:graph.truncated||graph.nodes.length>32||graph.edges.length>40,
    indexRevision:graph.indexRevision,
  };
}
function compactView(view,level){
  const common={mode:view.mode,nodeCount:view.nodes.length,
    edgeCount:view.edges.length,mermaid:view.mermaid,truncated:view.truncated};
  if(level==="C4")return {...common,unresolvedCount:view.unresolved.length,
    staleCount:view.stale.length};
  return {...common,nodes:view.nodes.slice(0,16).map(x=>({
    id:x.stableId,label:x.label,type:x.type,status:x.status,
    sourceEvidence:x.sourceEvidence?.slice(0,1),
  })),edges:view.edges.slice(0,25).map(x=>({
    fromId:x.fromId,toId:x.toId,kind:x.kind,status:x.status,
  }))};
}

export function createEvidenceBrief({engine,docs}){
  return async function brief({projectId,query,repoIds=[],languages=[],
    limit=8,maxDepth=5,maxNodes=55}={}){
    if(typeof query!=="string"||!query.trim()||query.length>240)
      throw new ProjectRegistryError("INVALID_ARGUMENTS","Brief needs a nonempty query (max 240 characters).");
    if(!Number.isInteger(limit)||limit<1||limit>20)
      throw new ProjectRegistryError("INVALID_ARGUMENTS","Brief limit must be 1–20.");

    let docsStatus="not_configured",docsResults=null,search;
    try{
      const found=await docs.search({projectId,query,limit:Math.min(limit,12)});
      docsResults=found;
      search=found.sourceEvidence;
      docsStatus="available";
    }catch(error){
      if(!DOCS_UNAVAILABLE.has(error?.code))throw error;
      docsStatus=error.code.toLowerCase();
      search=await engine.search({projectId,query,limit,repoIds,languages});
    }
    // Docs/search may scan every repo. Re-run with explicit filters to avoid
    // surfacing source paths beyond a caller's requested repository/language.
    if(repoIds.length||languages.length)
      search=await engine.search({projectId,query,limit,repoIds,languages});
    const filteredNoteLinks=(docsResults?.noteBackedSourceReferences??[]).filter(x=>
      (!repoIds.length||repoIds.includes(x.repoId))&&
      (!languages.length||languages.some(lang=>{
        const p=x.relativePath.toLowerCase();
        return lang==="php"?p.endsWith(".php"):lang==="csharp"?p.endsWith(".cs"):
          lang==="typescript"?/\.(?:ts|tsx)$/u.test(p):
          lang==="sql"?p.endsWith(".sql"):lang==="config"?/\.(?:json|ya?ml)$/u.test(p):false;
      })));
    const candidates=sourceCandidates(search.results??[],filteredNoteLinks,query,limit);
    const options={projectId,repoIds,languages,maxDepth,maxNodes,limit:1};
    let graph=await engine.evidenceGraph({...options,query,direction:"both"});
    let graphLocator=query,graphLocatorOrigin="user_query";
    // A source-cited Obsidian path may help locate AST facts, but it must
    // remain a *candidate* until the caller reviews evidence.
    if(!graph.nodes.length&&candidates.length){
      graphLocator=candidates[0].relativePath;
      graphLocatorOrigin=candidates[0].sourceMatch==="note_cited_source_path_candidate"?
        "note_navigation_candidate":"verified_source_path_lookup";
      graph=await engine.evidenceGraph({...options,query:graphLocator,direction:"both"});
    }
    const [c1,c2]=await Promise.all([
      engine.architecture({projectId,level:"C1",repoIds,languages,maxNodes}),
      engine.architecture({projectId,level:"C2",query,repoIds,languages,limit,maxNodes}),
    ]);
    const c3=projectC4FromGraph(graph,{level:"C3",maxNodes,projectId});
    const c4=projectC4FromGraph(graph,{level:"C4",maxNodes,projectId});
    return {
      projectId,query,indexRevision:graph.indexRevision,
      mode:"source_evidence_brief_not_runtime_proof",
      graphLocator,graphLocatorOrigin,docsStatus,
      candidates,
      sourceExcerpts:(search.results??[]).filter(x=>x.freshness==="verified_current_hash")
        .slice(0,limit).map(x=>({repoId:x.repoId,relativePath:x.relativePath,
          startLine:x.startLine,endLine:x.endLine,sha256:x.sha256,snippet:x.snippet,
          astMatch:x.astMatch??null})),
      relatedNotes:(docsResults?.noteClaims?.results??[])
        .filter(x=>x.freshness==="verified_current_hash").slice(0,5)
        .map(x=>({title:x.title,relativePath:x.relativePath,
          documentType:x.documentType,sha256:x.sha256})),
      evidenceGraph:summarizeGraph(graph),
      architecture:{
        C1:{mode:c1.mode,nodes:c1.nodes,edges:c1.edges,missingEvidence:c1.missingEvidence,mermaid:c1.mermaid},
        C2:{mode:c2.mode,nodes:c2.nodes,edges:c2.edges,
          dataFlowBreaks:c2.dataFlowBreaks,verifiedRuntimeLinks:[],mermaid:c2.mermaid},
        C3:compactView(c3,"C3"),
        C4:compactView(c4,"C4"),
      },
      limitations:[
        "Documentary note paths are navigation candidates, not source call links.",
        "Static references do not prove runtime communication or deployment.",
        "C1 actors and C2 runtime topology remain incomplete without external verification.",
        "Missing PHP dynamic receiver edges do not mean no call occurs.",
      ],
    };
  };
}
