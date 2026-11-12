import test from "node:test";
import assert from "node:assert/strict";
import {createEvidenceBrief} from "../src/tools/codebase-intelligence/evidence-brief.mjs";
import {ProjectRegistryError} from "../src/tools/codebase-intelligence/registry.mjs";
import {projectC4FromGraph} from "../src/tools/codebase-intelligence/graph-projector.mjs";

const source=(p)=>({repoId:"term-asteroids",relativePath:p,
  language:"php",freshness:"verified_current_hash",sha256:"fixture-hash",
  startLine:1,endLine:2,snippet:"<?php\nclass Example {}"});
function graph(){
  const one={stableId:"s1",language:"php",kind:"method",name:"Spaceship@startThruster",
    repoId:"term-asteroids",relativePath:"src/Game/Spaceship.php",
    startLine:201,endLine:205,sha256:"fixture-hash",freshness:"verified_current_hash",
    status:"verified_static",provenance:{repoId:"term-asteroids",
      relativePath:"src/Game/Spaceship.php",startLine:201,sha256:"fixture-hash"}};
  const two={...one,stableId:"s2",name:"Mover@getMoveVectorSinceLastStep",
    relativePath:"src/Engine/Mover.php",provenance:{...one.provenance,
      relativePath:"src/Engine/Mover.php"}};
  return {nodes:[one,two],edges:[{fromId:"s1",toId:"s2",
    kind:"static_reference",status:"verified_static",
    evidence:{repoId:"term-asteroids",relativePath:"src/Game/Spaceship.php",startLine:205}}],
    gaps:[],stale:[],truncated:false,indexRevision:1,rootEvidence:[
      {stableId:"s1",freshness:"verified_current_hash"}]};
}
const c1={mode:"system_context_incomplete",nodes:[{label:"game"}],edges:[],
  missingEvidence:["actors not configured"],mermaid:"flowchart LR"};
const c2={mode:"logical_runtime_candidates_unverified",nodes:[{label:"PHP"}],edges:[],
  dataFlowBreaks:[],mermaid:"flowchart LR"};

test("P9 C3 treats PHP CLI module paths as source candidates, not deploy units",()=>{
  const result=projectC4FromGraph(graph(),{level:"C3",projectId:"term-asteroids"});
  assert.deepEqual(result.nodes.map(x=>x.label).sort(),["PHP module Engine","PHP module Game"]);
  assert.equal(result.edges.length,1);
  assert.equal(result.edges[0].status,"verified_static");
  assert.ok(result.nodes.every(x=>x.status==="logical_source_group_needs_review"));
});

test("P9 brief combines Obsidian navigation with evidence and all four C4 views",async()=>{
  const calls=[];
  const engine={
    search:async()=>{throw Error("search should be reused from docs");},
    evidenceGraph:async({query})=>{
      calls.push(query);
      return query==="thiết bị hỗ trợ"?{...graph(),nodes:[],edges:[],rootEvidence:[]}:graph();
    },
    architecture:async({level})=>level==="C1"?c1:c2,
  };
  const docs={search:async()=>({
    sourceEvidence:{results:[source("src/Game/Spaceship.php")]},
    noteClaims:{results:[{title:"Manual source note",relativePath:"Manual/note.md",
      freshness:"verified_current_hash",sha256:"notehash",
      documentType:"documentation_claim_not_source_fact"}]},
    noteBackedSourceReferences:[{repoId:"term-asteroids",relativePath:"src/Engine/Mover.php",
      sha256:"fixture-hash",evidenceType:"verified_source_path_cited_by_note_not_runtime_link",
      confidence:"documentary_claim_with_current_source_file_hash",citingNotes:["Manual/note.md"]}],
  })};
  const result=await createEvidenceBrief({engine,docs})({
    projectId:"term-asteroids",query:"thiết bị hỗ trợ",
  });
  assert.equal(result.docsStatus,"available");
  assert.deepEqual(calls,["thiết bị hỗ trợ","src/Engine/Mover.php"]);
  assert.equal(result.graphLocatorOrigin,"note_navigation_candidate");
  assert.equal(result.candidates[0].relativePath,"src/Engine/Mover.php");
  assert.equal(result.candidates[0].evidenceType,
    "verified_source_path_cited_by_note_not_runtime_link");
  assert.deepEqual(Object.keys(result.architecture),["C1","C2","C3","C4"]);
  assert.equal(result.architecture.C3.edges.length,1);
  assert.ok(result.evidenceGraph.sourceFiles.every(x=>x.sha256==="fixture-hash"));
  assert.equal(result.architecture.C2.verifiedRuntimeLinks.length,0);
});

test("P9 brief works without Obsidian and does not include stale source",async()=>{
  const engine={
    search:async()=>({results:[{...source("src/Game/Spaceship.php"),
      freshness:"stale_or_unavailable"},source("src/Engine/Mover.php")]}),
    evidenceGraph:async()=>graph(),
    architecture:async({level})=>level==="C1"?c1:c2,
  };
  const docs={search:async()=>{throw new ProjectRegistryError("DOC_SCOPE_MISSING","No scope");}};
  const result=await createEvidenceBrief({engine,docs})({
    projectId:"term-asteroids",query:"startThruster",
  });
  assert.equal(result.docsStatus,"doc_scope_missing");
  assert.equal(result.candidates.length,1);
  assert.equal(result.candidates[0].relativePath,"src/Engine/Mover.php");
  assert.equal(result.graphLocatorOrigin,"user_query");
  await assert.rejects(createEvidenceBrief({engine,docs})({
    projectId:"term-asteroids",query:" ".repeat(3),
  }),e=>e.code==="INVALID_ARGUMENTS");
});
