// Read-only RRF vs existing note-first on fixed source-file labels.
// Same docs/search output is reused for both algorithms to avoid a second index scan.
// No index mutation, source changes, or note writing.
import {handleCodebaseIntelligenceTool} from "../src/tools/codebase-intelligence/handler.mjs";
import {rankSourceAndNotes} from "../src/tools/codebase-intelligence/rank-fusion.mjs";

const cases=[
  {q:"giáo trình học phần",repo:"legacy-php",expect:"app/Http/Controllers/CourseBookController.php"},
  {q:"quản lý học phần",repo:"legacy-php",expect:"app/Models/CourseSubject.php"},
  {q:"thống kê giảng viên thỉnh giảng",repo:"legacy-php",expect:"app/Http/Controllers/TeachingStatisticController.php"},
  {q:"lịch giảng dạy",repo:"training-csharp",expect:"src/VaaTrainingManagement.API/Controllers/TeachingPlansController.cs"},
  {q:"nguồn dữ liệu Masterdata",repo:"training-csharp",expect:"src/VaaTrainingManagement.API/Controllers/MasterdataController.cs"},
  {q:"thiết bị hỗ trợ giảng dạy",repo:"training-ts",expect:"src/services/teaching-devices.service.ts"},
  {q:"đề cương chi tiết",repo:"training-ts",expect:"src/services/masterdata.service.ts"},
  {q:"phê duyệt phản hồi giờ giảng",repo:"legacy-php",expect:"app/Http/Controllers/TeachingConfirmationController.php"},
  // Additional diagnostic labels, NOT blind holdout: source paths were known
  // before the benchmark and may not be the only relevant results.
  {q:"xuất excel giáo trình",repo:"legacy-php",expect:"app/Exports/CourseBookExport.php"},
  {q:"chỉnh sửa đề cương chi tiết",repo:"training-ts",
    expect:"src/features/detailed-course-outline/components/outline-editor-dialog.tsx"},
  {q:"gọi API Masterdata",repo:"training-csharp",
    expect:"src/VaaTrainingManagement.Infrastructure/ExternalServices/MasterdataApiClient.cs"},
  {q:"trang thiết bị hỗ trợ giảng dạy",repo:"training-ts",
    expect:"src/app/(admin)/teaching-devices/page.tsx"},
];
const items=[];
for(const c of cases){
  const response=await handleCodebaseIntelligenceTool("openclaw_codebase_intelligence",{
    action:"docs",operation:"search",projectId:"vaa-training",query:c.q,limit:12});
  if(!response?.structuredContent?.ok){
    items.push({query:c.q,error:response?.structuredContent?.code??"unknown"});
    continue;
  }
  const found=response.structuredContent.result;
  const sourceResults=(found.sourceEvidence.results??[]).filter(x=>x.repoId===c.repo);
  const noteReferences=(found.noteBackedSourceReferences??[]).filter(x=>x.repoId===c.repo);
  const a=rankSourceAndNotes({sourceResults,noteReferences,query:c.q,strategy:"note_first",limit:5});
  const b=rankSourceAndNotes({sourceResults,noteReferences,query:c.q,strategy:"rrf",limit:5});
  items.push({query:c.q,repo:c.repo,noteFirstHit:a.some(x=>x.relativePath===c.expect),
    rrfHit:b.some(x=>x.relativePath===c.expect),
    first5Note:a.map(x=>x.relativePath),first5Rrf:b.map(x=>x.relativePath)});
}
const count=(arr,key)=>arr.filter(x=>x[key]).length;
console.log(JSON.stringify({method:"shared_search_A_B",total:items.length,
  original8:{noteFirst:count(items.slice(0,8),"noteFirstHit"),
    rrf:count(items.slice(0,8),"rrfHit")},
  diagnostic4:{noteFirst:count(items.slice(8),"noteFirstHit"),
    rrf:count(items.slice(8),"rrfHit")},
  cases:items,
  caveat:"Single labeled file per query; not independent semantic relevance judgments or a blind holdout."},null,2));
