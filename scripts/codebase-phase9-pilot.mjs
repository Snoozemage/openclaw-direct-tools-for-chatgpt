// Local read-only benchmark. Does not reload the bridge, modify source repos,
// update indexes or write Obsidian notes. Run: node scripts/codebase-phase9-pilot.mjs
import {performance} from "node:perf_hooks";
import {handleCodebaseIntelligenceTool} from "../src/tools/codebase-intelligence/handler.mjs";

const invoke=async args=>{
  const start=performance.now();
  const r=await handleCodebaseIntelligenceTool("openclaw_codebase_intelligence",args);
  if(!r?.structuredContent?.ok)
    throw Error(args.action+" "+args.projectId+": "+(r?.structuredContent?.code??"unknown"));
  return {ms:performance.now()-start,result:r.structuredContent};
};

const cases=[
  {projectId:"term-asteroids",query:"startThruster",expected:"src/Game/Spaceship.php"},
  {projectId:"term-asteroids",query:"Spaceship",expected:"src/Game/Spaceship.php"},
  {projectId:"vaa-training",query:"giáo trình học phần",repoIds:["legacy-php"],
    expected:"app/Http/Controllers/CourseBookController.php"},
  {projectId:"vaa-training",query:"quản lý học phần",repoIds:["legacy-php"],
    expected:"app/Models/CourseSubject.php"},
  {projectId:"vaa-training",query:"thống kê giảng viên thỉnh giảng",repoIds:["legacy-php"],
    expected:"app/Http/Controllers/TeachingStatisticController.php"},
  {projectId:"vaa-training",query:"lịch giảng dạy",repoIds:["training-csharp"],
    expected:"src/VaaTrainingManagement.API/Controllers/TeachingPlansController.cs"},
  {projectId:"vaa-training",query:"nguồn dữ liệu Masterdata",repoIds:["training-csharp"],
    expected:"src/VaaTrainingManagement.API/Controllers/MasterdataController.cs"},
  {projectId:"vaa-training",query:"thiết bị hỗ trợ giảng dạy",repoIds:["training-ts"],
    expected:"src/services/teaching-devices.service.ts"},
  {projectId:"vaa-training",query:"đề cương chi tiết",repoIds:["training-ts"],
    expected:"src/services/masterdata.service.ts"},
  {projectId:"vaa-training",query:"phê duyệt phản hồi giờ giảng",repoIds:["legacy-php"],
    expected:"app/Http/Controllers/TeachingConfirmationController.php"},
];

const output=[];
for(const item of cases){
  const args={projectId:item.projectId,query:item.query,
    repoIds:item.repoIds??[],limit:8};
  try{
    const sample=await invoke({action:"brief",...args});
    const b=sample.result.brief;
    const responseBytes=JSON.stringify(b).length;
    const paths=b.candidates.slice(0,5).map(x=>x.relativePath);
    output.push({project:item.projectId,query:item.query,
      timeMs:Math.round(sample.ms),responseBytes,hitAt5:paths.includes(item.expected),
      candidateCount:b.candidates.length,docsStatus:b.docsStatus,
      c3Groups:b.architecture.C3.nodeCount,c3Edges:b.architecture.C3.edgeCount,
      c4Nodes:b.architecture.C4.nodeCount,c4Edges:b.architecture.C4.edgeCount,
      firstFive:paths,graphLocatorOrigin:b.graphLocatorOrigin});
  }catch(e){
    output.push({project:item.projectId,query:item.query,error:String(e)});
  }
}
// Compare equivalent read-only workflows on two representative cases. This is
// local handler timing only, not an LLM-completion benchmark.
const workflowComparisons=[];
for(const item of [cases[1],cases[7]]){
  const common={projectId:item.projectId,query:item.query,repoIds:item.repoIds??[]};
  const baseline=[
    {action:"search",...common},
    ...(item.projectId==="vaa-training"?[
      {action:"docs",operation:"search",projectId:item.projectId,query:item.query},
    ]:[]),
    ...["C1","C2","C3","C4"].map(level=>({action:"architecture",level,...common,
      direction:"both",maxNodes:55})),
  ];
  const before=performance.now();
  let baselineBytes=0;
  for(const args of baseline){
    const response=await invoke(args);
    baselineBytes+=JSON.stringify(response.result).length;
  }
  const baselineMs=performance.now()-before;
  const after=await invoke({action:"brief",...common,maxNodes:55});
  workflowComparisons.push({query:item.query,baselineCalls:baseline.length,
    briefCalls:1,baselineBytes,briefBytes:JSON.stringify(after.result.brief).length,
    baselineMs:Math.round(baselineMs),briefMs:Math.round(after.ms),
    localSpeedRatio:Number((baselineMs/after.ms).toFixed(2))});
}
console.log(JSON.stringify({mode:"local_read_only_phase9_pilot",cases:output,
  workflowComparisons,
  note:"Local single-run timings and fixed-file recall labels; no controlled end-to-end LLM speed or semantic precision claim."},null,2));
