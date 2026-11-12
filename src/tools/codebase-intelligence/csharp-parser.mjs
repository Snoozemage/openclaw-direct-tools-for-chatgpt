import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ProjectRegistryError } from "./registry.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "csharp-helper");
const dll = path.join(root, "bin", "Release", "net9.0", "CodebaseRoslyn.dll");
export const CSHARP_ADAPTER_VERSION = "roslyn-sdk9-csharp-v5-ef-dto-sql";
const KINDS = new Set(["interface","class","record","struct","controller","controller_method",
  "method","dto_property","cqrs_handler","cqrs_request","constructor_dependency","mediator_send",
  "ef_context","ef_dbset","ef_configuration","ef_table","di_registration","endpoint",
  "ef_context_registration","ef_property","di_factory","dto","dto_field","service","method_parameter",
  "sql_operation","ef_migration_table","ef_migration_column"]);
const STATES = new Set(["verified_static","inferred","unresolved"]);
const MAX_OUTPUT_BYTES = 7_000_000;
const MAX_BATCH = 28;

function reject(code, message) { throw new ProjectRegistryError(code,message); }

export async function assertRoslynReady() {
  try { await access(dll); }
  catch { reject("ROSLYN_UNAVAILABLE",
    "Compile standalone Roslyn helper with dotnet build -c Release in src/tools/codebase-intelligence/csharp-helper (SDK 9 required)."); }
}

/** Roslyn runs only the pinned helper DLL. Target repositories are never built or loaded. */
export async function extractCsharpBatch(files,{signal,timeoutMs=25000}={}) {
  if(!Array.isArray(files)||files.length<1||files.length>MAX_BATCH)reject("INVALID_ARGUMENTS","Invalid Roslyn batch size.");
  let total=0;
  for(const file of files) {
    if(typeof file.relativePath!=="string"||!file.relativePath.toLowerCase().endsWith(".cs")||
       file.relativePath.length>1024||file.relativePath.includes("\0")||
       file.relativePath.split(/[\\/]/u).includes("..")||
       typeof file.source!=="string"||Buffer.byteLength(file.source,"utf8")>2_100_000) {
      reject("INVALID_ARGUMENTS","Invalid Roslyn file path/content.");
    }
    total+=Buffer.byteLength(file.source,"utf8");
  }
  if(total>10_000_000)reject("INVALID_ARGUMENTS","Roslyn input batch exceeds source budget.");
  await assertRoslynReady();
  if(signal?.aborted)reject("INDEX_CANCELLED","Roslyn indexing cancelled.");
  const json=JSON.stringify({version:1,files:files.map(f=>({relativePath:f.relativePath,code:f.source}))});
  return new Promise((resolve,rejectPromise)=>{
    let p;
    try {
      p=spawn("dotnet",[dll],{cwd:root,shell:false,windowsHide:true,signal,
        stdio:["pipe","pipe","pipe"]});
    } catch {
      rejectPromise(new ProjectRegistryError("ROSLYN_UNAVAILABLE","Cannot spawn Roslyn helper."));
      return;
    }
    let out="",nbytes=0,finished=false,expired=false;
    const timer=setTimeout(()=>{expired=true;p.kill();},timeoutMs);
    p.stdout.on("data",buffer=>{
      nbytes+=buffer.length;
      if(nbytes>MAX_OUTPUT_BYTES){p.kill();return;}
      out+=buffer.toString("utf8");
    });
    p.stderr.on("data",()=>{});
    p.stdin.on("error",()=>{});
    p.on("error",err=>{
      if(finished)return;
      finished=true;clearTimeout(timer);
      rejectPromise(new ProjectRegistryError(err.name==="AbortError"?"INDEX_CANCELLED":"ROSLYN_UNAVAILABLE",
        "Roslyn helper could not start or was cancelled."));
    });
    p.on("close",code=>{
      if(finished)return;
      finished=true;clearTimeout(timer);
      if(signal?.aborted){rejectPromise(new ProjectRegistryError("INDEX_CANCELLED","Roslyn parse cancelled."));return;}
      if(code!==0||expired||nbytes>MAX_OUTPUT_BYTES){
        rejectPromise(new ProjectRegistryError("ROSLYN_FAILED","Roslyn helper timed out or exceeded output budget."));return;
      }
      try {
        const parsed=JSON.parse(out);
        if(!parsed.ok||!Array.isArray(parsed.files)||parsed.files.length!==files.length)throw Error("Bad Roslyn response");
        const result=[];
        for(let i=0;i<files.length;i++) {
          const item=parsed.files[i];
          if(item.relativePath!==files[i].relativePath||!Array.isArray(item.facts)||item.facts.length>2400||
             item.parseError!=null && typeof item.parseError!=="string")throw Error("Bad Roslyn item");
          const facts=item.facts.map(f=>{
            if(!f||!KINDS.has(f.kind)||typeof f.name!=="string"||f.name.length>600||
              !Number.isInteger(f.startLine)||!Number.isInteger(f.endLine)||f.startLine<1||
              f.endLine<f.startLine||!STATES.has(f.status)||typeof f.details!=="object"||
              f.details===null)throw Error("Bad Roslyn fact");
            return f;
          });
          result.push({relativePath:item.relativePath,facts,parseError:item.parseError??null});
        }
        resolve(result);
      }catch{
        rejectPromise(new ProjectRegistryError("ROSLYN_FAILED","Invalid or unbounded Roslyn helper result."));
      }
    });
    p.stdin.end(json);
  });
}
