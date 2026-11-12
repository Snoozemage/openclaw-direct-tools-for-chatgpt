// Disposable, read-only PHP source coverage pilot. Does not touch the shared
// Codebase Intelligence index, registered projects or source repository.
// Example: node scripts/codebase-accuracy-probe.mjs "C:\path\to\repo" startThruster
import {mkdtemp,rm} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {performance} from "node:perf_hooks";
import {createProjectRegistry} from "../src/tools/codebase-intelligence/registry.mjs";
import {createIndexEngine} from "../src/tools/codebase-intelligence/engine.mjs";

const sourceRoot=process.argv[2];
const query=process.argv[3]||"startThruster";
if(!sourceRoot)throw Error("Usage: node scripts/codebase-accuracy-probe.mjs <php-git-repo> [query]");
const temp=await mkdtemp(path.join(os.tmpdir(),"codebase-accuracy-audit-"));
try{
  const registry=createProjectRegistry({stateRoot:temp});
  await registry.register({projectId:"coverage-pilot",repositories:[
    {id:"php-repo",root:path.resolve(sourceRoot),languages:["php"]},
  ]});
  const engine=createIndexEngine({registry});
  const start=performance.now();
  const job=await engine.index({projectId:"coverage-pilot",mode:"full"});
  if(!job.accepted)throw Error("Full index was not accepted");
  let status;
  for(let i=0;i<600;i++){
    status=await engine.status("coverage-pilot",job.job.jobId);
    if(["completed","failed","cancelled"].includes(status.job.state))break;
    await new Promise(resolve=>setTimeout(resolve,40));
  }
  if(status?.job?.state!=="completed")throw Error(JSON.stringify(status?.job?.error??"Index timed out"));
  const graph=await engine.evidenceGraph({
    projectId:"coverage-pilot",query,languages:["php"],
    maxDepth:6,maxNodes:110,limit:2,direction:"both",
  });
  const kinds={};
  for(const e of graph.edges)kinds[e.kind]=(kinds[e.kind]??0)+1;
  const sample=graph.nodes.filter(n=>
    n.name.includes("startThruster")||n.kind==="member_call").slice(0,10)
    .map(n=>({kind:n.kind,name:n.name,relativePath:n.relativePath,startLine:n.startLine}));
  console.log(JSON.stringify({
    query,elapsedMs:Math.round(performance.now()-start),
    index:{fileCount:status.index.fileCount,php:status.index.php},
    graph:{roots:graph.rootEvidence?.length??0,nodes:graph.nodes.length,
      edges:graph.edges.length,edgeKinds:kinds,gaps:graph.gaps.length,
      truncated:graph.truncated,staleCount:graph.staleCount??0,sample},
    interpretation:"Read-only isolated AST index and bounded graph; incomplete edges or no gaps do not prove full coverage.",
  },null,2));
}finally{
  await rm(temp,{recursive:true,force:true,maxRetries:6,retryDelay:180});
}
