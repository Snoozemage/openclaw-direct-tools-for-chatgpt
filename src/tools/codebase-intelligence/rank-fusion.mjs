/**
 * Two-source retrieval fusion. The two input lists are navigation rankings,
 * not evidence that a source file implements a requested business operation.
 * Exact verified basename hits remain authoritative over note path hints.
 */
const key=x=>x.repoId+"\0"+x.relativePath;
const valid=x=>x?.freshness==="verified_current_hash"&&
  typeof x.repoId==="string"&&typeof x.relativePath==="string";
const noteLink=x=>({
  repoId:x.repoId,relativePath:x.relativePath,sha256:x.sha256,
  freshness:"verified_current_hash",
  evidenceType:"verified_source_path_cited_by_note_not_runtime_link",
  confidence:x.confidence,citingNotes:x.citingNotes,
  sourceMatch:"note_cited_source_path_candidate",
});
export function rankSourceAndNotes({sourceResults=[],noteReferences=[],query="",limit=8,strategy="note_first"}={}){
  if(!["note_first","rrf"].includes(strategy))throw Error("Unsupported ranking strategy");
  const sources=sourceResults.filter(valid);
  const notes=noteReferences.filter(x=>
    x?.evidenceType==="verified_source_path_cited_by_note_not_runtime_link"
    &&typeof x.repoId==="string"&&typeof x.relativePath==="string").map(noteLink);
  const exact=sources.filter(x=>x.sourceMatch==="verified_exact_basename");
  const normal=sources.filter(x=>x.sourceMatch!=="verified_exact_basename");
  const vietnamese=/[à-ỹđ]/iu.test(query);
  let ordered;
  if(strategy==="note_first"){
    ordered=vietnamese?[...exact,...notes,...normal]:[...exact,...normal,...notes];
  }else{
    const ranks=new Map();
    const add=(items,origin)=>{
      for(let i=0;i<items.length;i++){
        const x=items[i],k=key(x);
        const previous=ranks.get(k)??{source:null,note:null,score:0};
        // Reciprocal Rank Fusion with the standard k=60; duplicates in a
        // single ranking must not inflate the score.
        if(previous[origin]===null){
          previous[origin]={item:x,rank:i+1};
          previous.score+=1/(60+i+1);
        }
        ranks.set(k,previous);
      }
    };
    add(normal,"source");
    add(notes,"note");
    const fusion=[...ranks.values()].sort((a,b)=>
      b.score-a.score||
      (vietnamese?
        Number(!!b.note)-Number(!!a.note):
        Number(!!b.source)-Number(!!a.source))||
      (a.source?.rank??a.note?.rank??Infinity)-
        (b.source?.rank??b.note?.rank??Infinity));
    ordered=[...exact,...fusion.map(v=>{
      const item=v.source?.item??v.note?.item;
      return {...item,
        ...(v.note?{citingNotes:v.note.item.citingNotes,
          noteEvidenceType:v.note.item.evidenceType}:{}),
        rankingEvidence:{method:"rrf",sourceRank:v.source?.rank??null,
          noteRank:v.note?.rank??null},
      };
    })];
  }
  const unique=new Set();
  return ordered.filter(x=>{
    const k=key(x);
    if(unique.has(k))return false;
    unique.add(k);return true;
  }).slice(0,limit);
}
