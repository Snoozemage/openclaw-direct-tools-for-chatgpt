import path from "node:path";
import {ProjectRegistryError,validateProjectId} from "./registry.mjs";
import {loadDocsConfig,buildDocsIndex,readDocsIndex,searchDocs} from "./docs-index.mjs";
import {createDocsPublisher} from "./docs-publisher.mjs";

function fail(code,message){throw new ProjectRegistryError(code,message);}
export function createDocsAdapter({registry,engine}){
  const stateRoot=registry.stateRoot,indexRoot=path.join(stateRoot,"index");
  async function context(projectId){
    validateProjectId(projectId);
    const project=await registry.ensureProjectAllowed(projectId);
    const config=await loadDocsConfig({stateRoot,projectId});
    return {project,config};
  }
  async function index({projectId}={}){
    const {config}=await context(projectId);
    return await buildDocsIndex({stateRoot,indexRoot,projectId,config});
  }
  async function status({projectId}={}){
    const {config}=await context(projectId);
    let notes=null,revision=null,indexedAt=null;
    try{
      const data=await readDocsIndex({stateRoot,projectId,config});
      notes=data.notes.length;revision=data.sourceRevision;indexedAt=data.indexedAt;
    }catch(e){if(e?.code!=="DOC_INDEX_MISSING")throw e;}
    return {projectId,state:notes===null?"not_indexed":"indexed",
      readRoots:config.readRoots,writeScopeConfigured:config.generatedRoot!==null,
      generatedRoot:config.generatedRoot??null,notes,sourceRevision:revision,indexedAt,
      note:"All read roots are explicitly allowlisted; generated writes require selected destination and per-preview approval."};
  }
  async function search({projectId,query,limit=10}={}){
    const {config,project}=await context(projectId);
    const noteClaims=await searchDocs({stateRoot,indexRoot,projectId,project,config,query,limit});
    let sources;
    try{
      const raw=await engine.search({projectId,query,limit:Math.min(limit,12)});
      sources={mode:raw.mode,results:raw.results.map(s=>({
        ...s,evidenceType:"indexed_source_excerpt_not_document_claim",
      })),count:raw.count,ranking:raw.ranking};
    }catch(e){
      if(e instanceof ProjectRegistryError)throw e;
      sources={error:"SOURCE_SEARCH_UNAVAILABLE",results:[],count:0};
    }
    // Notes are a useful *navigation* layer for Vietnamese business terminology.
    // These candidates remain documentary citations even when the target file hash is
    // current: no source graph link or verified runtime relationship is created.
    const fromNotes=new Map();
    for(const note of noteClaims.results){
      if(note.freshness!=="verified_current_hash")continue;
      for(const ref of note.sourceReferences??[]){
        if(ref.sourceFreshness!=="verified_current_hash"||!ref.repoId||!ref.relativePath)continue;
        const key=ref.repoId+":"+ref.relativePath;
        const existing=fromNotes.get(key)??{
          repoId:ref.repoId,relativePath:ref.relativePath,sha256:ref.indexedSha256,
          evidenceType:"verified_source_path_cited_by_note_not_runtime_link",
          confidence:"documentary_claim_with_current_source_file_hash",
          maxNoteScore:0,citingNotes:[],
        };
        existing.maxNoteScore=Math.max(existing.maxNoteScore,note.score);
        if(!existing.citingNotes.includes(note.relativePath)&&existing.citingNotes.length<6)
          existing.citingNotes.push(note.relativePath);
        fromNotes.set(key,existing);
      }
    }
    const noteBackedSourceReferences=[...fromNotes.values()].sort((a,b)=>
      b.maxNoteScore-a.maxNoteScore||b.citingNotes.length-a.citingNotes.length||
      a.relativePath.localeCompare(b.relativePath)).slice(0,24);
    return {projectId,query,mode:"document_claims_and_source_evidence",
      noteClaims,sourceEvidence:sources,noteBackedSourceReferences,
      interpretation:"Obsidian note citations are documentary navigation with source-file SHA verification, never source AST facts, business equivalence or runtime relationships."};
  }
  const publisher=createDocsPublisher({
    registry,indexRoot,architecture:args=>engine.architecture(args),
    docsSearch:async({projectId,query,config,limit})=>{
      const project=await registry.ensureProjectAllowed(projectId);
      return searchDocs({stateRoot,indexRoot,projectId,project,config,query,limit});
    },
  });
  async function preview({projectId,query,level="C4"}={}){
    const {config}=await context(projectId);
    return await publisher.preview({projectId,query,level,config});
  }
  async function apply({projectId,previewId,approved=false}={}){
    if(approved!==true)fail("DOC_APPROVAL_REQUIRED","Apply requires explicit user approval of the exact preview.");
    const {config}=await context(projectId);
    return await publisher.apply({projectId,previewId,approved,config});
  }
  return {index,status,search,preview,apply};
}
