import test from "node:test";
import assert from "node:assert/strict";
import {rankUnmappedSourcePaths} from "../src/tools/codebase-intelligence/source-path-discovery.mjs";

const files=[
  {repoId:"fe",language:"typescript",relativePath:"src/features/ke-hoach-giang-day/main-view-page.tsx"},
  {repoId:"fe",language:"typescript",relativePath:"src/features/ke-hoach-giang-day/mocks/ke-hoach.mock.ts"},
  {repoId:"fe",language:"typescript",relativePath:"src/app/(admin)/lich-giang-day/page.tsx"},
  {repoId:"be",language:"csharp",relativePath:"src/Features/TeachingSchedules/Queries/GetMyWeeklyScheduleQuery.cs"},
  {repoId:"fe",language:"typescript",relativePath:"src/features/plo-assessment-runs/main-view-page.tsx"},
  {repoId:"legacy",language:"php",relativePath:"resources/views/hoc_ky/index.blade.php"},
];

test("P1 generic Vietnamese business path discovery needs no curated task alias",()=>{
  const found=rankUnmappedSourcePaths("Quản lý kế hoạch học kỳ",files);
  assert.equal(found[0].relativePath,"src/features/ke-hoach-giang-day/main-view-page.tsx");
  assert.equal(found[0].matchedTerms,"ke hoach");
  assert.equal(found[0].coverage,0.5);
  assert.ok(found.some(x=>x.relativePath==="src/features/ke-hoach-giang-day/mocks/ke-hoach.mock.ts"));
  assert.ok(!found.some(x=>x.relativePath.includes("plo-assessment")));
});

test("P1 path discovery uses consecutive meaningful words and prioritizes routes",()=>{
  const result=rankUnmappedSourcePaths("lịch giảng dạy theo tuần",files);
  assert.equal(result[0].relativePath,"src/app/(admin)/lich-giang-day/page.tsx");
  assert.equal(result[0].matchedTerms,"lich giang day");
  assert.equal(result[0].coverage,0.75);
});

test("P1 main routes and feature views rank ahead of detail routes and component files",()=>{
  const related=[
    "src/features/ke-hoach-giang-day/components/list-table-column.tsx",
    "src/features/ke-hoach-giang-day/list-view-page.tsx",
    "src/features/ke-hoach-giang-day/detail-view-page.tsx",
    "src/app/(admin)/ke-hoach-giang-day/[id]/page.tsx",
    "src/app/(admin)/ke-hoach-giang-day/page.tsx",
  ].map(relativePath=>({repoId:"fe",language:"typescript",relativePath}));
  const found=rankUnmappedSourcePaths("quản lý kế hoạch học kỳ",related);
  assert.deepEqual(found.map(x=>x.relativePath),[
    "src/app/(admin)/ke-hoach-giang-day/page.tsx",
    "src/app/(admin)/ke-hoach-giang-day/[id]/page.tsx",
    "src/features/ke-hoach-giang-day/list-view-page.tsx",
    "src/features/ke-hoach-giang-day/detail-view-page.tsx",
    "src/features/ke-hoach-giang-day/components/list-table-column.tsx",
  ]);
});

test("P1 unrelated PLO assessment source is not mistaken for conduct evaluation",()=>{
  assert.deepEqual(rankUnmappedSourcePaths("đánh giá rèn luyện sinh viên",files),[]);
  assert.deepEqual(rankUnmappedSourcePaths("unmatched",files),[]);
});

test("P1 generic path discovery respects language, repo filters and bounds",()=>{
  const scoped=rankUnmappedSourcePaths("quản lý kế hoạch học kỳ",files,
    {repoIds:["be"],languages:["csharp"]});
  assert.deepEqual(scoped,[]);
  const onlyFe=rankUnmappedSourcePaths("kế hoạch giảng dạy",files,
    {repoIds:["fe"],languages:["typescript"],limit:1});
  assert.equal(onlyFe.length,1);
  assert.equal(onlyFe[0].relativePath,"src/features/ke-hoach-giang-day/main-view-page.tsx");
});

test("P1 English PascalCase paths require phrase evidence, not partial word coincidence",()=>{
  const candidates=[{repoId:"be",language:"csharp",
    relativePath:"src/Features/TeachingSchedules/TeachingScheduleController.cs"}];
  const found=rankUnmappedSourcePaths("Teaching Schedule",candidates);
  assert.equal(found[0].matchedTerms,"teaching schedule");
  assert.deepEqual(rankUnmappedSourcePaths("assessment calendar",candidates),[]);
});
