import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { assertRoslynReady, extractCsharpBatch } from "../src/tools/codebase-intelligence/csharp-parser.mjs";
const fixture=path.join(path.dirname(fileURLToPath(import.meta.url)),"fixtures","codebase-csharp");
async function samples() {
  const files=[];
  async function walk(dir,prefix=""){
    for(const ent of await readdir(dir,{withFileTypes:true})){
      const rel=prefix?prefix+"/"+ent.name:ent.name;
      if(ent.isDirectory())await walk(path.join(dir,ent.name),rel);
      else if(ent.name.endsWith(".cs"))files.push({relativePath:rel,
        source:await readFile(path.join(dir,ent.name),"utf8")});
    }
  }
  await walk(fixture);
  return files;
}
const flat=results=>results.flatMap(f=>f.facts);
test("pinned Roslyn helper is built separately and parses all fixture source", async()=>{
  await assertRoslynReady();
  const result=await extractCsharpBatch(await samples());
  assert.equal(result.length,10);
  assert.ok(result.every(x=>x.parseError===null));
  assert.ok(flat(result).length>=20);
});
test("C# attribute endpoints, DTOs, CQRS, DI and EF DbContext/config facts have source evidence",async()=>{
  const facts=flat(await extractCsharpBatch(await samples()));
  const match=(kind,check)=>facts.filter(f=>f.kind===kind&&check(f));
  assert.ok(match("endpoint",f=>f.name==="GET /api/CourseSubjects/{id}" && f.target?.endsWith("CourseSubjectsController@GetById")).length);
  assert.ok(match("endpoint",f=>f.name==="POST /api/CourseSubjects/batch-update").length);
  assert.ok(match("cqrs_handler",f=>f.target==="GetCourseSubjectQuery").length);
  assert.ok(match("mediator_send",f=>f.target==="GetCourseSubjectQuery").length);
  assert.ok(match("mediator_send",f=>f.target==="BatchUpdateDevicesCommand").length);
  assert.ok(match("di_registration",f=>f.details?.service==="ICourseSubjectRepository"&&f.details?.implementation==="CourseSubjectRepository").length);
  assert.ok(match("ef_dbset",f=>f.target==="CourseSubject").length);
  assert.ok(match("ef_table",f=>f.target==="course_subjects").length);
  assert.ok(match("constructor_dependency",f=>f.target==="ICourseSubjectRepository").length);
  assert.ok(match("dto",f=>f.name.endsWith("BatchUpdateDevicesDto")).length);
  assert.ok(match("dto_field",f=>f.name.endsWith("BatchUpdateDevicesDto.Credit")).length);
  assert.ok(match("method_parameter",f=>f.target==="BatchUpdateDevicesDto").length);
  assert.ok(match("ef_migration_table",f=>f.target==="course_subjects").length);
  assert.ok(match("ef_migration_column",f=>f.target==="course_subjects"&&f.details?.column==="credit").length);
  assert.ok(match("sql_operation",f=>f.target==="course_subjects"&&f.details?.method==="ExecuteSqlRaw").length);
  assert.ok(match("class",f=>f.name==="Sample.Infrastructure.SampleDbContext"&&f.details?.semanticResolved===true).length);
});
test("Roslyn handles UTF-8 BOM and non-ASCII Unicode source from Windows bridge",async()=>{
  const source="\uFEFFnamespace Sample.ỨngDụng; public class GiảngViên { public string Tên => \"Học phần\"; }";
  const res=await extractCsharpBatch([{relativePath:"src/Unicode.cs",source}]);
  assert.equal(res[0].parseError,null);
  assert.ok(res[0].facts.some(f=>f.name==="Sample.ỨngDụng.GiảngViên"));
});
test("malformed C# produces explicit syntax error, not fabricated endpoint",async()=>{
  const bad=await extractCsharpBatch([{relativePath:"src/BrokenController.cs",source:"[HttpGet] public class {"}]);
  assert.ok(bad[0].parseError);
  assert.deepEqual(bad[0].facts,[]);
});
