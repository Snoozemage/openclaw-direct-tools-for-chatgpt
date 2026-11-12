import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import path from "node:path";
import {assertTypescriptReady,extractTypescriptFacts,nextRouteFromPath,normalizeHttpPath,readTypescriptAliases} from "../src/tools/codebase-intelligence/typescript-parser.mjs";

const fixtures=path.join(path.dirname(fileURLToPath(import.meta.url)),"fixtures","codebase-typescript");
async function parse(file){
  const source=await readFile(path.join(fixtures,file),"utf8");
  return extractTypescriptFacts({relativePath:file.replace(/\\/gu,"/"),source});
}
test("isolated pinned TypeScript 5.8.3 compiler parses TSX Next app route with groups",async()=>{
  await assertTypescriptReady();
  const p="src/app/(admin)/teaching-devices/page.tsx",x=await parse(p);
  assert.equal(x.parseError,null);
  assert.equal(nextRouteFromPath(p).route,"/teaching-devices");
  assert.equal(nextRouteFromPath("src/app/bff/auth/refresh/route.ts").type,"next_api_route");
  assert.ok(x.facts.some(f=>f.kind==="next_page"&&f.name==="/teaching-devices"));
  assert.ok(x.facts.some(f=>f.kind==="import"&&f.details.specifier.includes("teaching-devices-view")));
});
test("exports selected mock adapter as an actual binding, not merely an unused mock import",async()=>{
  const r=await parse("src/services/teaching-devices.service.ts");
  assert.equal(r.parseError,null);
  assert.ok(r.facts.some(f=>f.kind==="import"&&f.name==="mockTeachingDevicesService"&&!f.details.typeOnly));
  assert.ok(r.facts.some(f=>f.kind==="export_binding"&&f.name==="teachingDevicesService"&&f.target==="mockTeachingDevicesService"));
});
test("HTTP axios/fetch routes, env config, static URL normalization and dynamic URLs are distinct",async()=>{
  const f=await parse("src/services/courses.service.ts");
  assert.ok(f.facts.some(x=>x.kind==="http_request"&&x.name==="GET /api/coursesubjects/{}"&&
    x.details.normalizedPath==="/api/coursesubjects/{}"));
  assert.ok(f.facts.some(x=>x.kind==="http_request"&&x.details.dynamic===true));
  const api=await parse("src/services/api.ts");
  assert.ok(api.facts.some(x=>x.kind==="http_client"&&x.details.baseURLExpression==="envConfig.apiUrl"));
  const env=await parse("src/configs/env.config.ts");
  assert.ok(env.facts.some(x=>x.kind==="env_binding"&&x.name==="NEXT_PUBLIC_API_URL"));
  assert.equal(normalizeHttpPath("/api/course-subjects/{id:guid}?x=5"),"/api/course-subjects/{}");
  assert.equal(readTypescriptAliases(await readFile(path.join(fixtures,"tsconfig.json"),"utf8"))["@/"],"src/");
});
test("single-file TypeChecker records used import bindings but not shadowing locals",()=>{
  const code=[
    'import { client as service } from "./api";',
    'export function yes(){ return service.get("/x"); }',
    'export function no(service: any){ return service.get("/y"); }',
    'export function also(){ const other={get:()=>1}; return other.get(); }',
  ].join("\n");
  const result=extractTypescriptFacts({relativePath:"src/feature.ts",source:code});
  assert.equal(result.parseError,null);
  const uses=result.facts.filter(f=>f.kind==="import_usage");
  assert.equal(uses.length,1,JSON.stringify(uses));
  assert.equal(uses[0].target,"service");
  assert.equal(uses[0].details.binding,"single_file_typechecker_import_symbol");
  assert.equal(uses[0].details.externalImplementationVerified,false);
});
test("many repeated framework hook calls do not crowd out a later imported service",()=>{
  const source=[
    'import { useState, service } from "./api";',
    'export function draw(){',
    ...Array.from({length:65},()=>"  useState(0);"),
    '  service.load();',
    '}',
  ].join("\n");
  const result=extractTypescriptFacts({relativePath:"src/long.ts",source});
  const calls=result.facts.filter(x=>x.kind==="import_usage");
  assert.deepEqual(calls.map(x=>x.name).sort(),["service.load","useState"]);
  assert.equal(result.facts.find(x=>x.kind==="module").details.importUsageSampleTruncated,false);
});
test("syntax error is reported as no static facts, not as fabricated requests",async()=>{
  const r=extractTypescriptFacts({relativePath:"src/broken.ts",source:"export const service = ;"});
  assert.ok(r.parseError);
  assert.deepEqual(r.facts,[]);
});
