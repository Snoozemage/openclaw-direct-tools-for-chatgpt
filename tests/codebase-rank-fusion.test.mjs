import test from "node:test";
import assert from "node:assert/strict";
import {rankSourceAndNotes} from "../src/tools/codebase-intelligence/rank-fusion.mjs";

const source=(path,sourceMatch="lexical_source_candidate")=>({
  repoId:"training-ts",relativePath:path,sha256:"hash",freshness:"verified_current_hash",
  sourceMatch,
});
const note=path=>({
  repoId:"training-ts",relativePath:path,sha256:"hash",
  evidenceType:"verified_source_path_cited_by_note_not_runtime_link",
  citingNotes:["Manual/Feature.md"],
});
test("RRF promotes independently corroborated path while preserving exact basename",()=>{
  const sources=[source("src/exact.ts","verified_exact_basename"),
    source("src/common.ts"),source("src/only-source.ts")];
  const notes=[note("src/only-note.ts"),note("src/common.ts")];
  const result=rankSourceAndNotes({query:"thiết bị hỗ trợ",
    sourceResults:sources,noteReferences:notes,strategy:"rrf",limit:10});
  assert.equal(result[0].relativePath,"src/exact.ts");
  assert.equal(result[1].relativePath,"src/common.ts");
  assert.deepEqual(result[1].rankingEvidence,{method:"rrf",sourceRank:1,noteRank:2});
  assert.equal(result[1].noteEvidenceType,"verified_source_path_cited_by_note_not_runtime_link");
  assert.ok(result.find(x=>x.relativePath==="src/only-note.ts").sourceMatch==="note_cited_source_path_candidate");
});
test("RRF never includes stale sources or upgrades note claims to verified runtime facts",()=>{
  const result=rankSourceAndNotes({sourceResults:[{...source("src/stale.ts"),
    freshness:"stale_or_unavailable"}],noteReferences:[note("src/only-note.ts")],strategy:"rrf"});
  assert.deepEqual(result.map(x=>x.relativePath),["src/only-note.ts"]);
  assert.ok(result.every(x=>x.sourceMatch!=="verified_runtime_link"));
});
test("default note_first preserves existing Vietnamese navigation order",()=>{
  const r=rankSourceAndNotes({query:"đề cương chi tiết",
    sourceResults:[source("src/source.ts")],noteReferences:[note("src/note.ts")]});
  assert.deepEqual(r.map(x=>x.relativePath),["src/note.ts","src/source.ts"]);
});
test("duplicate note items count only once in RRF and never outrank exact",()=>{
  const r=rankSourceAndNotes({sourceResults:[source("src/x.ts","verified_exact_basename")],
    noteReferences:[note("src/y.ts"),note("src/y.ts"),note("src/z.ts")],
    strategy:"rrf"});
  assert.equal(r[0].relativePath,"src/x.ts");
  assert.equal(r.filter(x=>x.relativePath==="src/y.ts").length,1);
  assert.throws(()=>rankSourceAndNotes({strategy:"unknown"}),/Unsupported/);
});
