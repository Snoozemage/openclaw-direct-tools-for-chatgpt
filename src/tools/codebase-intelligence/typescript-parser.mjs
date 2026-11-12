import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { access } from "node:fs/promises";
import { ProjectRegistryError } from "./registry.mjs";

const helperRoot=path.join(path.dirname(fileURLToPath(import.meta.url)),"typescript-helper");
const requireTs=createRequire(path.join(helperRoot,"package.json"));
export const TYPESCRIPT_ADAPTER_VERSION="ts-ast-v4-local-typechecker-import-use:typescript-5.8.3";
const MAX_FACTS=850;
let compiler;
function fail(code,message){throw new ProjectRegistryError(code,message);}
function tsInstance(){
  if(!compiler){
    try{compiler=requireTs("typescript");}
    catch{fail("TYPESCRIPT_UNAVAILABLE","Install pinned TypeScript 5.8.3 in typescript-helper with npm ci --ignore-scripts.");}
    if(compiler.version!=="5.8.3")fail("TYPESCRIPT_UNAVAILABLE","TypeScript version must match pinned 5.8.3.");
  }
  return compiler;
}
export async function assertTypescriptReady(){
  await access(path.join(helperRoot,"node_modules","typescript","lib","typescript.js")).catch(()=>
    fail("TYPESCRIPT_UNAVAILABLE","Run npm ci --ignore-scripts inside typescript-helper."));
  tsInstance();
}
export function readTypescriptAliases(configText){
  if(typeof configText!=="string"||configText.length>250_000)return {};
  const ts=tsInstance();
  const parsed=ts.parseConfigFileTextToJson("tsconfig.json",configText);
  if(parsed.error||!parsed.config||typeof parsed.config.compilerOptions?.paths!=="object")return {};
  const paths=parsed.config.compilerOptions.paths;
  const allowed={};
  for(const [alias,values] of Object.entries(paths)){
    if(alias.length>100||!Array.isArray(values)||values.length!==1||typeof values[0]!=="string")continue;
    if(!alias.endsWith("/*")||!values[0].endsWith("/*"))continue;
    const target=values[0].slice(0,-2).replace(/^\.\//u,"");
    if(!target||target.startsWith("/")||target.includes("..")||target.includes(":"))continue;
    allowed[alias.slice(0,-1)]=target+"/";
  }
  return allowed;
}
export function nextRouteFromPath(relativePath){
  const p=relativePath.replace(/\\/gu,"/");
  if(!/^(?:src\/)?app\//u.test(p))return null;
  const parts=p.replace(/^src\//u,"").split("/");
  const leaf=parts.at(-1);
  if(!["page.tsx","page.ts","route.ts","route.tsx"].includes(leaf))return null;
  const segments=parts.slice(1,-1).filter(x=>!(/^\(.*\)$/u.test(x))&&!x.startsWith("@"));
  if(segments.some(x=>/^\(\.|\.\)|^_/u.test(x)))return null;
  const route="/"+segments.join("/");
  return {route:route||"/",type:leaf.startsWith("route.")?"next_api_route":"next_page"};
}
function staticValue(ts,expr,strings=new Map(),depth=0){
  if(!expr||depth>3)return null;
  if(ts.isStringLiteral(expr)||ts.isNoSubstitutionTemplateLiteral(expr))return expr.text;
  if(ts.isIdentifier(expr))return strings.get(expr.text)??null;
  if(ts.isParenthesizedExpression(expr)||ts.isAsExpression(expr)||ts.isNonNullExpression(expr))
    return staticValue(ts,expr.expression,strings,depth+1);
  if(ts.isTemplateExpression(expr)){
    let value=expr.head.text;
    for(const span of expr.templateSpans){
      const bound=staticValue(ts,span.expression,strings,depth+1);
      value+=(bound??"{}")+span.literal.text;
    }
    return value;
  }
  if(ts.isBinaryExpression(expr)&&expr.operatorToken.kind===ts.SyntaxKind.PlusToken){
    const a=staticValue(ts,expr.left,strings,depth+1),b=staticValue(ts,expr.right,strings,depth+1);
    if(a!==null&&b!==null)return a+b;
  }
  return null;
}
function readEnv(ts,expr){
  if(!expr)return null;
  if(ts.isPropertyAccessExpression(expr)&&ts.isPropertyAccessExpression(expr.expression)&&
    expr.expression.expression.getText()==="process"&&expr.expression.name.text==="env")
    return expr.name.text;
  return null;
}
function safeBaseURL(value){
  if(typeof value!=="string")return null;
  if(value.startsWith("/"))return value.split(/[?#]/u)[0].slice(0,200);
  if(/^https?:\/\//iu.test(value)){
    try{const uri=new URL(value);return (uri.origin+uri.pathname).slice(0,200);}catch{return null;}
  }
  return null;
}
export function normalizeHttpPath(value){
  if(typeof value!=="string"||!value.trim())return null;
  let v=value.trim();
  if(/^https?:\/\//iu.test(v)){try{v=new URL(v).pathname;}catch{return null;}}
  if(!v.startsWith("/"))return null;
  return v.split("?")[0].replace(/\/+/gu,"/").replace(/\/$/u,"")
    .replace(/\{[^{}]+\}/gu,"{}").toLowerCase()||"/";
}
export function extractTypescriptFacts({relativePath,source}={}){
  if(typeof relativePath!=="string"||!/\.(?:tsx?|mts|cts)$/iu.test(relativePath)||
     typeof source!=="string"||Buffer.byteLength(source,"utf8")>2_100_000)
    fail("INVALID_ARGUMENTS","Invalid bounded TS/TSX input.");
  const ts=tsInstance();
  const file=ts.createSourceFile(relativePath,source,ts.ScriptTarget.Latest,true,
    relativePath.endsWith(".tsx")?ts.ScriptKind.TSX:ts.ScriptKind.TS);
  const errors=(file.parseDiagnostics??[]).filter(x=>x.category===ts.DiagnosticCategory.Error);
  if(errors.length)return {facts:[],parseError:"TS_SYNTAX_ERROR:"+errors[0].code};
  const facts=[];
  const loc=n=>{
    const start=file.getLineAndCharacterOfPosition(n.getStart(file)).line+1;
    return [start,Math.max(start,file.getLineAndCharacterOfPosition(n.getEnd()).line+1)];
  };
  function add(kind,name,node,{parent=null,target=null,status="verified_static",details={}}={}){
    if(facts.length>=MAX_FACTS||!name)return;
    const [startLine,endLine]=loc(node);
    facts.push({kind,name:String(name).slice(0,600),parent,target,startLine,endLine,status,details});
  }
  // Single-file, in-memory type checking: prove that a call's receiver
  // resolves to its import binding rather than a shadowing local variable.
  // This does NOT resolve the imported symbol's implementation across files.
  const hasImports=file.statements.some(ts.isImportDeclaration);
  const checkerEligible=source.length<=100_000&&hasImports;
  let checkerCallBudgetHit=false;
  if(checkerEligible){
    const options={noLib:true,noResolve:true,skipLibCheck:true,
      module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022};
    const host={
      getSourceFile:name=>name===relativePath?file:undefined,
      getDefaultLibFileName:()=>"",
      writeFile:()=>{},getCurrentDirectory:()=>"/",
      getDirectories:()=>[],fileExists:name=>name===relativePath,
      readFile:name=>name===relativePath?source:undefined,
      useCaseSensitiveFileNames:()=>true,getCanonicalFileName:name=>name,
      getNewLine:()=>"\n",
    };
    const checker=ts.createProgram([relativePath],options,host).getTypeChecker();
    let count=0;
    const seenUsage=new Set();
    const track=node=>{
      if(count>=48){checkerCallBudgetHit=true;return;}
      if(ts.isCallExpression(node)){
        const expression=node.expression;
        const receiver=ts.isIdentifier(expression)?expression:
          ts.isPropertyAccessExpression(expression)&&ts.isIdentifier(expression.expression)?
            expression.expression:null;
        if(receiver){
          const symbol=checker.getSymbolAtLocation(receiver);
          const declaration=symbol?.declarations?.find(d=>
            ts.isImportSpecifier(d)||ts.isImportClause(d)||ts.isNamespaceImport(d));
          if(declaration){
            const target=receiver.text;
            const operation=ts.isPropertyAccessExpression(expression)?expression.name.text:null;
            const usageKey=target+"\0"+(operation??"");
            if(!seenUsage.has(usageKey)){
              seenUsage.add(usageKey);
              add("import_usage",target+(operation?"."+operation:""),node,{
              parent:relativePath,target,status:"verified_static",
              details:{binding:"single_file_typechecker_import_symbol",
                local:target,operation,externalImplementationVerified:false},
              });
              count++;
            }
          }
        }
      }
      ts.forEachChild(node,track);
    };
    track(file);
  }
  add("module",relativePath,file,{details:{
    singleFileTypeChecker:checkerEligible?"ran":hasImports?"skipped_source_size_budget":"not_needed",
    crossFileSemanticResolution:"unverified",
    importUsageSampleTruncated:checkerCallBudgetHit,
  }});
  const route=nextRouteFromPath(relativePath);
  if(route)add(route.type,route.route,file,{parent:relativePath,
    details:{appRouter:true,route:route.route,sourceFile:relativePath}});
  const constants=new Map();
  for(const s of file.statements)if(ts.isVariableStatement(s)){
    for(const d of s.declarationList.declarations){
      if(!ts.isIdentifier(d.name))continue;
      const value=staticValue(ts,d.initializer,constants);
      if(value!==null&&value.length<500)constants.set(d.name.text,value);
    }
  }
  function exported(n){
    return !!(ts.canHaveModifiers(n)&&ts.getModifiers(n)?.some(m=>m.kind===ts.SyntaxKind.ExportKeyword));
  }
  for(const s of file.statements){
    if(ts.isImportDeclaration(s)&&ts.isStringLiteral(s.moduleSpecifier)){
      const spec=s.moduleSpecifier.text,clause=s.importClause,ty=!!clause?.isTypeOnly;
      const imp=(local,imported,node,typeOnly=ty)=>add("import",local,node,{
        parent:relativePath,target:spec,
        details:{specifier:spec,local,imported,typeOnly}});
      if(!clause)imp(spec,"*",s,false);
      if(clause?.name)imp(clause.name.text,"default",s);
      if(clause?.namedBindings){
        const b=clause.namedBindings;
        if(ts.isNamespaceImport(b))imp(b.name.text,"*",s);
        if(ts.isNamedImports(b))for(const e of b.elements)
          imp(e.name.text,e.propertyName?.text??e.name.text,e,ty||e.isTypeOnly);
      }
    }else if(ts.isExportDeclaration(s)){
      const spec=s.moduleSpecifier&&ts.isStringLiteral(s.moduleSpecifier)?s.moduleSpecifier.text:null;
      if(s.exportClause&&ts.isNamedExports(s.exportClause))for(const e of s.exportClause.elements){
        add("reexport",e.name.text,e,{parent:relativePath,target:spec,
          details:{specifier:spec,local:e.propertyName?.text??e.name.text,
            exported:e.name.text,typeOnly:s.isTypeOnly}});
      }else if(spec)add("reexport","*",s,{parent:relativePath,target:spec,
        details:{specifier:spec,local:"*",exported:"*",typeOnly:s.isTypeOnly}});
    }else if(ts.isVariableStatement(s)){
      for(const d of s.declarationList.declarations){
        if(!ts.isIdentifier(d.name))continue;
        const name=d.name.text;
        add("symbol",name,d,{parent:relativePath,
          details:{declaration:"variable",exported:exported(s)}});
        if(exported(s)){
          const ref=d.initializer&&ts.isIdentifier(d.initializer)?d.initializer.text:null;
          add("export_binding",name,d,{parent:relativePath,target:ref,
            status:ref?"verified_static":"unresolved",
            details:{exported:name,referenced:ref,initializerKind:d.initializer?ts.SyntaxKind[d.initializer.kind]:null}});
        }
        if(d.initializer&&ts.isCallExpression(d.initializer)&&ts.isPropertyAccessExpression(d.initializer.expression)&&
           d.initializer.expression.name.text==="create"&&d.initializer.expression.expression.getText(file)==="axios"){
          const options=d.initializer.arguments[0];
          const base=options&&ts.isObjectLiteralExpression(options)?
            options.properties.find(p=>ts.isPropertyAssignment(p)&&p.name.getText(file)==="baseURL"):null;
          const expr=base?.initializer,value=staticValue(ts,expr,constants),env=readEnv(ts,expr);
          add("http_client",name,d,{parent:relativePath,
            details:{client:name,library:"axios",baseURLLiteral:safeBaseURL(value),
              baseURLExpression:expr&&(ts.isIdentifier(expr)||ts.isPropertyAccessExpression(expr))?
                expr.getText(file).slice(0,140):null,
              envKey:env,baseURLStatus:safeBaseURL(value)?"static_literal":
                env||expr?.getText(file)==="envConfig.apiUrl"?"environment_reference":"unresolved"}});
        }
      }
    }else if(ts.isFunctionDeclaration(s)||ts.isClassDeclaration(s)||
      ts.isInterfaceDeclaration(s)||ts.isTypeAliasDeclaration(s)||ts.isEnumDeclaration(s)){
      add("symbol",s.name?.text??"default",s,{parent:relativePath,
        details:{declaration:ts.SyntaxKind[s.kind],exported:exported(s)}});
    }
  }
  function visit(n){
    if(ts.isPropertyAssignment(n)&&n.name.getText(file)==="apiUrl"){
      const env=readEnv(ts,n.initializer);
      if(env)add("env_binding",env,n,{parent:relativePath,
        details:{key:"apiUrl",environment:env,source:"process.env"}});
    }
    if(ts.isCallExpression(n)){
      const expr=n.expression,args=n.arguments;
      if(ts.isIdentifier(expr)&&expr.text==="fetch"){
        const url=staticValue(ts,args[0],constants);
        let method="GET";
        if(args[1]&&ts.isObjectLiteralExpression(args[1])){
          const prop=args[1].properties.find(p=>ts.isPropertyAssignment(p)&&p.name.getText(file)==="method");
          if(prop?.initializer)method=staticValue(ts,prop.initializer,constants)?.toUpperCase()??"UNKNOWN";
        }
        const normalizedPath=normalizeHttpPath(url);
        const dynamic=url===null||ts.isTemplateExpression(args[0]);
        add("http_request",method+" "+(normalizedPath??"<dynamic>"),n,{parent:relativePath,target:normalizedPath,
          status:normalizedPath?(dynamic?"inferred":"verified_static"):"unresolved",
          details:{library:"fetch",client:"fetch",httpMethod:method,
            normalizedPath,dynamic,interpolated:ts.isTemplateExpression(args[0])}});
      }
      if(ts.isPropertyAccessExpression(expr)){
        const op=expr.name.text,obj=expr.expression.getText(file);
        const isHttp=["get","post","put","patch","delete","head","options"].includes(op.toLowerCase());
        const clientLike=/Service$|Api$|Client$|^axiosInstance$|^axios$|^http$/u.test(obj);
        if(isHttp&&clientLike){
          const method=op.toUpperCase(),url=staticValue(ts,args[0],constants);
          const normalizedPath=normalizeHttpPath(url);
          const dynamic=url===null||ts.isTemplateExpression(args[0]);
          add("http_request",method+" "+(normalizedPath??"<dynamic>"),n,{
            parent:relativePath,target:normalizedPath,
            status:normalizedPath?(dynamic?"inferred":"verified_static"):"unresolved",
            details:{library:"axios_or_http_client",client:obj,httpMethod:method,
              normalizedPath,dynamic,interpolated:ts.isTemplateExpression(args[0])}});
        }else if(clientLike&&!["create","use","interceptors","all","request"].includes(op)){
          add("service_call",obj+"."+op,n,{parent:relativePath,target:obj,
            details:{receiver:obj,method:op}});
        }
      }
    }
    ts.forEachChild(n,visit);
  }
  visit(file);
  return {facts,parseError:null};
}
