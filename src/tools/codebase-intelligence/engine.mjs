import { randomUUID } from "node:crypto";
import {selectEvidenceRoots,traverseEvidence,redactStaleGraph,projectC4FromGraph,
  projectC1,projectC2,classifyImpact,indexedTestCandidates} from "./graph-projector.mjs";
import {loadCuratedContext} from "./curated-context.mjs";
import path from "node:path";
import { ProjectRegistryError, validateProjectId } from "./registry.mjs";
import { scanProject, snapshotRepositories, readSafeFile, makeChunks, INDEX_LIMITS } from "./scanner.mjs";
import {
  openWritableIndex, openExistingIndex, readExistingHashes, removeFile,
  insertFile, currentRevision, databaseCounts, recordRevision, searchIndex, writeRepoSnapshots, readRepoSnapshots,
} from "./store.mjs";
import { extractPhpFacts, assertPhpParserReady, PHP_ADAPTER_VERSION } from "./php-parser.mjs";
import { extractBladeFacts } from "./php-blade.mjs";
import { extractTypescriptFacts,assertTypescriptReady,TYPESCRIPT_ADAPTER_VERSION,normalizeHttpPath } from "./typescript-parser.mjs";
import {readTsAdapterVersion,saveTsAdapterVersion,insertTsFacts,rebuildTsEdges,getTsCounts,
  findTsFacts,traceTsGraph,findActiveMockBindings,findTsHttpRequests} from "./typescript-graph.mjs";
import { assertRoslynReady, extractCsharpBatch, CSHARP_ADAPTER_VERSION } from "./csharp-parser.mjs";
import { readCsharpAdapterVersion, saveCsharpAdapterVersion, insertCsharpFacts,
  rebuildCsharpEdges, getCsharpCounts, findCsharpFacts, traceCsharpGraph } from "./csharp-graph.mjs";
import { readPhpAdapterVersion, savePhpAdapterVersion, insertPhpFileFacts,
  rebuildPhpEdges, getPhpCounts, findPhpFacts, tracePhpGraph, getPhpErrors } from "./php-graph.mjs";

const MAX_RESULTS = 30;
const MAX_JOBS = 30;
const MAX_QUERY_LENGTH = 240;
const VALID_MODE = new Set(["full", "incremental", "cancel"]);

function reject(code, message) {
  throw new ProjectRegistryError(code, message);
}

function tokenize(query) {
  if (typeof query !== "string" || !query.trim() || query.length > MAX_QUERY_LENGTH) {
    reject("INVALID_ARGUMENTS", "query must be a non-empty search string up to 240 characters.");
  }
  const words = query.normalize("NFKC").match(/[\p{L}\p{N}]+/gu)?.slice(0, 8) ?? [];
  if (!words.length) reject("INVALID_ARGUMENTS", "Search query must contain words or numbers.");
  return words.map((item) => item.toLowerCase());
}

function queryExpression(terms, separator = " AND ") {
  return terms.map((term) => '"' + term.replace(/"/gu, "") + '"').join(separator);
}

function isCancelled(error, job) {
  return job.controller.signal.aborted || error?.code === "INDEX_CANCELLED" || error?.name === "AbortError";
}

function exposeJob(job) {
  if (!job) return null;
  return {
    jobId: job.jobId, projectId: job.projectId, mode: job.mode, state: job.state,
    progress: { ...job.progress }, startedAt: job.startedAt, finishedAt: job.finishedAt ?? null,
    ...(job.revision == null ? {} : { revision: job.revision }),
    ...(job.error ? { error: job.error } : {}),
  };
}

export function createIndexEngine({ registry, indexRoot = path.join(registry?.stateRoot ?? "", "index"),
  limits = INDEX_LIMITS, beforeCommit } = {}) {
  if (!registry?.ensureProjectAllowed || typeof indexRoot !== "string" || !path.isAbsolute(indexRoot)) {
    throw new TypeError("An allowlist-aware registry and absolute local indexRoot are required.");
  }

  const active = new Map();
  const jobs = new Map();

  async function parsePhpFile(file,safe,signal) {
    if (file.relativePath.toLowerCase().endsWith(".blade.php")) {
      return {facts:extractBladeFacts(safe.text,file.relativePath),parseError:null};
    }
    return extractPhpFacts({relativePath:file.relativePath,source:safe.rawText,signal});
  }

  function retain(job) {
    jobs.set(job.jobId, job);
    while (jobs.size > MAX_JOBS) {
      const oldest = jobs.keys().next().value;
      if (jobs.get(oldest)?.state === "running" || jobs.get(oldest)?.state === "queued") break;
      jobs.delete(oldest);
    }
  }

  async function run(job) {
    let db;
    let transaction = false;
    try {
      job.state = "running";
      const project = await registry.ensureProjectAllowed(job.projectId);
      const inventory = await scanProject(project, {
        limits,
        signal: job.controller.signal,
        onProgress: (progress) => { job.progress = { ...job.progress, ...progress }; },
      });
      job.progress = { phase: "hashing", examined: inventory.examined, totalFiles: inventory.files.length,
        accepted: inventory.files.length, skipped: inventory.skipped, processed: 0 };
      if (job.controller.signal.aborted) reject("INDEX_CANCELLED", "Indexing was cancelled.");

      db = await openWritableIndex(indexRoot, job.projectId);
      db.exec("BEGIN IMMEDIATE");
      transaction = true;
      const old = readExistingHashes(db);
      const phpEnabled = project.repositories.some((repo) => repo.languages.includes("php"));
      if (phpEnabled) await assertPhpParserReady();
      const phpReparseAll = phpEnabled && readPhpAdapterVersion(db) !== PHP_ADAPTER_VERSION;
      let phpParsed = 0, phpFailed = 0;
      const csharpEnabled = project.repositories.some(repo => repo.languages.includes("csharp"));
      if(csharpEnabled) await assertRoslynReady();
      const csharpReparseAll=csharpEnabled && readCsharpAdapterVersion(db)!==CSHARP_ADAPTER_VERSION;
      const csharpBatch=[];
      let batchBytes=0, csharpParsed=0, csharpFailed=0;
      const typescriptEnabled=project.repositories.some(repo=>repo.languages.includes("typescript"));
      if(typescriptEnabled)await assertTypescriptReady();
      const typescriptReparseAll=typescriptEnabled&&readTsAdapterVersion(db)!==TYPESCRIPT_ADAPTER_VERSION;
      let typescriptParsed=0,typescriptFailed=0;
      function parseTsFile(file,safe){
        const result=extractTypescriptFacts({relativePath:file.relativePath,source:safe.rawText});
        insertTsFacts(db,file,result.facts,result.parseError);
        typescriptParsed++;
        if(result.parseError)typescriptFailed++;
      }
      async function flushCsharp() {
        if(!csharpBatch.length)return;
        job.progress.phase="roslyn_parsing";
        const parsed=await extractCsharpBatch(csharpBatch.map(x=>({relativePath:x.file.relativePath,source:x.source})),
          {signal:job.controller.signal,timeoutMs:35000});
        for(let i=0;i<parsed.length;i++) {
          insertCsharpFacts(db,csharpBatch[i].file,parsed[i].facts,parsed[i].parseError);
          csharpParsed++;
          if(parsed[i].parseError)csharpFailed++;
        }
        csharpBatch.length=0;
        batchBytes=0;
      }
      async function queueCsharp(file,source) {
        const bytes=Buffer.byteLength(source,"utf8");
        if(csharpBatch.length>=15 || batchBytes+bytes>8_000_000)await flushCsharp();
        csharpBatch.push({file,source});batchBytes+=bytes;
      }
      if (job.mode === "full") {
        db.exec("DELETE FROM chunks");
        db.exec("DELETE FROM files");
      }
      let changed = 0, removed = 0, unchanged = 0;
      const found = new Set();
      const started = Date.now();
      for (const file of inventory.files) {
        if (job.controller.signal.aborted) reject("INDEX_CANCELLED", "Indexing was cancelled.");
        if (Date.now() - started > limits.maxJobMs) reject("INDEX_TIMEOUT", "Indexing exceeded the time budget.");
        const id = file.repoId + ":" + file.relativePath;
        found.add(id);
        const isPhp = file.language === "php";
        const rawPhp = isPhp && !file.relativePath.toLowerCase().endsWith(".blade.php");
        const isCsharp=file.language==="csharp";
        const isTypescript=file.language==="typescript";
        const safe = await readSafeFile(file, {
          signal: job.controller.signal, maxFileBytes: limits.maxFileBytes,
          includeRaw: rawPhp || isCsharp || isTypescript,
        });
        if (safe === null) {
          if (old.has(id)) { removeFile(db, id); removed++; }
          job.progress.skipped++;
          job.progress.processed++;
          continue;
        }
        if (job.mode !== "full" && old.get(id) === safe.hash) {
          unchanged++;
          if(isCsharp && csharpReparseAll)await queueCsharp(file,safe.rawText);
          if(isTypescript && typescriptReparseAll)parseTsFile(file,safe);
          if (isPhp && phpReparseAll) {
            const result = await parsePhpFile(file,safe,job.controller.signal);
            insertPhpFileFacts(db, file, result.facts, result.parseError);
            phpParsed++;
            if (result.parseError) phpFailed++;
          }
          job.progress.processed++;
          if (job.progress.processed % 25 === 0) await new Promise((resolve) => setImmediate(resolve));
          continue;
        }
        if (old.has(id) && job.mode !== "full") removeFile(db, id);
        const chunks = makeChunks(safe.text, limits.maxChunkChars);
        insertFile(db, file, safe.hash, chunks);
        if(isCsharp)await queueCsharp(file,safe.rawText);
        if(isTypescript)parseTsFile(file,safe);
        if (isPhp) {
          const result = await parsePhpFile(file,safe,job.controller.signal);
          insertPhpFileFacts(db, file, result.facts, result.parseError);
          phpParsed++;
          if (result.parseError) phpFailed++;
        }
        changed++;
        job.progress.processed++;
        job.progress.phase = "updating_index";
        job.progress.changed = changed;
        if (job.progress.processed % 25 === 0) {
          await new Promise((resolve) => setImmediate(resolve));
        }
      }
      await flushCsharp();
      if (job.mode !== "full") {
        for (const oldId of old.keys()) {
          if (!found.has(oldId)) { removeFile(db, oldId); removed++; }
        }
      } else removed = [...old.keys()].filter((key) => !found.has(key)).length;

      if (phpEnabled) {
        job.progress.phase = "resolving_php";
        rebuildPhpEdges(db);
        savePhpAdapterVersion(db, PHP_ADAPTER_VERSION);
      }
      if(csharpEnabled){
        job.progress.phase="resolving_csharp";
        rebuildCsharpEdges(db);
        saveCsharpAdapterVersion(db,CSHARP_ADAPTER_VERSION);
      }
      if(typescriptEnabled){
        job.progress.phase="resolving_typescript";
        rebuildTsEdges(db);
        saveTsAdapterVersion(db,TYPESCRIPT_ADAPTER_VERSION);
      }
      const totals = databaseCounts(db);
      const phpStats = getPhpCounts(db);
      const csharpStats=getCsharpCounts(db);
      const tsStats=getTsCounts(db);
      if (totals.chunkCount > limits.maxChunks || totals.sourceBytes > limits.maxSourceBytes) {
        reject("INDEX_LIMIT_EXCEEDED", "The resulting local index exceeds configured limits.");
      }
      if (job.controller.signal.aborted) reject("INDEX_CANCELLED", "Indexing was cancelled.");
      // Revalidate registered Git roots before publishing an index revision.
      const stillAllowed = await registry.ensureProjectAllowed(job.projectId);
      if (JSON.stringify(stillAllowed.repositories) !== JSON.stringify(project.repositories)) {
        reject("INDEX_SOURCE_CHANGED", "Registered repository paths changed during indexing.");
      }
      const latestSnapshots = await snapshotRepositories(project, job.controller.signal);
      if (JSON.stringify(latestSnapshots) !== JSON.stringify(inventory.repoSnapshots)) {
        reject("INDEX_SOURCE_CHANGED", "Repository branch/HEAD changed during indexing; the previous revision is preserved.");
      }
      if (beforeCommit) await beforeCommit({ db, job, totals });
      if (job.controller.signal.aborted) reject("INDEX_CANCELLED", "Indexing was cancelled.");

      const stats = { ...totals, changed, removed, unchanged };
      writeRepoSnapshots(db, inventory.repoSnapshots);
      job.revision = recordRevision(db, stats, job.mode);
      db.exec("COMMIT");
      transaction = false;
      job.state = "completed";
      job.progress = { ...job.progress, phase: "complete", ...stats,
        phpParsed, phpFailed, phpFacts: phpStats.facts, phpEdges: phpStats.edges,
        csharpParsed,csharpFailed,csharpFacts:csharpStats.facts,csharpEdges:csharpStats.edges,
        typescriptParsed,typescriptFailed,typescriptFacts:tsStats.facts,typescriptEdges:tsStats.edges };
    } catch (error) {
      if (transaction && db) {
        try { db.exec("ROLLBACK"); } catch {}
      }
      job.state = isCancelled(error, job) ? "cancelled" : "failed";
      job.error = {
        code: job.state === "cancelled" ? "INDEX_CANCELLED"
          : error instanceof ProjectRegistryError ? error.code : "INDEX_FAILED",
        message: job.state === "cancelled" ? "Indexing cancelled; last committed revision preserved."
          : error instanceof ProjectRegistryError ? error.message : "Index failed; last committed revision preserved.",
      };
    } finally {
      if (db) db.close();
      job.finishedAt = new Date().toISOString();
      active.delete(job.projectId);
      retain(job);
    }
  }

  async function index({ projectId, mode = "incremental", jobId } = {}) {
    validateProjectId(projectId);
    if (!VALID_MODE.has(mode)) reject("INVALID_ARGUMENTS", "mode must be full, incremental, or cancel.");
    if (mode === "cancel") {
      const job = active.get(projectId);
      if (!job || (jobId !== undefined && job.jobId !== jobId)) {
        reject("JOB_NOT_FOUND", "No matching active indexing job was found.");
      }
      job.controller.abort();
      return { accepted: true, job: exposeJob(job), message: "Cancellation requested." };
    }
    // Guard permission before creating a queued job, not only inside the worker.
    await registry.ensureProjectAllowed(projectId);
    const existing = active.get(projectId);
    if (existing) return { accepted: false, job: exposeJob(existing), message: "A project index is already active." };
    const job = {
      jobId: randomUUID(), projectId, mode, controller: new AbortController(),
      state: "queued", progress: { phase: "queued", processed: 0 }, startedAt: new Date().toISOString(),
    };
    active.set(projectId, job);
    retain(job);
    void run(job);
    return { accepted: true, job: exposeJob(job) };
  }

  async function status(projectId, jobId, {checkWorktree=false}={}) {
    validateProjectId(projectId);
    if(typeof checkWorktree!=="boolean")reject("INVALID_ARGUMENTS","checkWorktree must be boolean.");
    const projectStatus = await registry.status(projectId);
    let revision = null;
    let repoSnapshots = [];
    let php = null;
    let csharp=null;
    let typescript=null;
    let db;
    try {
      db = await openExistingIndex(indexRoot, projectId);
      if (db) {
        revision = currentRevision(db);
        if (revision) {
          repoSnapshots = readRepoSnapshots(db);
          php = { ...getPhpCounts(db), adapterVersion: readPhpAdapterVersion(db) };
          csharp={...getCsharpCounts(db),adapterVersion:readCsharpAdapterVersion(db)};
          typescript={...getTsCounts(db),adapterVersion:readTsAdapterVersion(db)};
        }
      }
    } finally { db?.close(); }
    let gitSnapshotDrift=null;
    if(checkWorktree&&revision){
      const project=await registry.ensureProjectAllowed(projectId);
      const actual=await snapshotRepositories(project);
      const oldById=new Map(repoSnapshots.map(x=>[x.repoId,x]));
      gitSnapshotDrift=actual.map(now=>{
        const prior=oldById.get(now.repoId);
        const reasons=[];
        if(!prior||now.branch!==prior.branch)reasons.push("branch_changed");
        if(!prior||now.head!==prior.head)reasons.push("head_changed");
        return {repoId:now.repoId,branch:now.branch,head:now.head,
          indexedBranch:prior?.branch??null,indexedHead:prior?.head??null,
          drift:reasons.length>0,reasons};
      });
    }
    const activeJob = active.get(projectId);
    const requested = jobId ? jobs.get(jobId) : null;
    if (jobId && (!requested || requested.projectId !== projectId)) {
      reject("JOB_NOT_FOUND", "Unknown job ID for the requested project.");
    }
    return {
      ...projectStatus,
      index: revision ? {
        state: projectStatus.repositoriesUnavailable.length ? "scope_unavailable" : "ready",
        revision: revision.revision, indexedAt: revision.indexed_at, mode: revision.mode,
        fileCount: revision.file_count, chunkCount: revision.chunk_count, sourceBytes: revision.source_bytes,
        changed: revision.changed, removed: revision.removed, unchanged: revision.unchanged,
        freshness: "not_checked_against_worktree", repoSnapshots, php,csharp,typescript,
        ...(checkWorktree?{gitSnapshotDrift,
          snapshotRefreshRecommended:gitSnapshotDrift.some(x=>x.drift),
          snapshotCheckLimitations:"Git branch/HEAD checked only. Uncommitted content edits need incremental reindex; source snippets and AST claims are separately hash-verified."}:{}),
      } : projectStatus.index,
      job: exposeJob(requested ?? activeJob ?? [...jobs.values()].reverse().find((item) => item.projectId === projectId)),
    };
  }

  async function search({ projectId, query, limit = 10, repoIds = [], languages = [] } = {}) {
    validateProjectId(projectId);
    const project = await registry.ensureProjectAllowed(projectId);
    const terms = tokenize(query);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_RESULTS ||
        !Array.isArray(repoIds) || repoIds.length > 12 || new Set(repoIds).size !== repoIds.length ||
        !Array.isArray(languages) || languages.length > 4 || new Set(languages).size !== languages.length) {
      reject("INVALID_ARGUMENTS", "Invalid search limit, repositories, or languages filters.");
    }
    if (repoIds.some((id) => !project.repositories.some((r) => r.id === id))
        || languages.some((lang) => !["php", "csharp", "typescript", "sql", "config"].includes(lang))) {
      reject("INVALID_ARGUMENTS", "Unknown search repository or language.");
    }
    let db;
    try {
      db = await openExistingIndex(indexRoot, projectId);
      if (!db || !currentRevision(db)) reject("INDEX_MISSING", "Run action=index before searching this project.");
      const revision = currentRevision(db);
      let matches = searchIndex(db, queryExpression(terms), repoIds, languages, Math.min(160, limit * 6));
      let matchMode = "all_terms";
      if (!matches.length && terms.length > 1) {
        matches = searchIndex(db, queryExpression(terms, " OR "), repoIds, languages, Math.min(160, limit * 6));
        matchMode = "any_term_fallback";
      }
      const roots = new Map(project.repositories.map((repo) => [repo.id, repo.root]));
      const tsRerank=readTsAdapterVersion(db)===TYPESCRIPT_ADAPTER_VERSION &&
        (!languages.length||languages.includes("typescript"));
      const tsRepoIds=project.repositories.filter(r=>r.languages.includes("typescript")&&
        (!repoIds.length||repoIds.includes(r.id))).map(r=>r.id);
      const tsEvidence=new Map();
      if(tsRerank&&tsRepoIds.length){
        for(const f of findTsFacts(db,query,{repoIds:tsRepoIds,limit:80,
          kinds:["next_page","next_api_route","symbol","export_binding","service_call","http_request"]})){
          const key=f.repoId+":"+f.relativePath;
          if(!tsEvidence.has(key))tsEvidence.set(key,f);
        }
      }
      // A very broad OR fallback on a 4+ word query can return unrelated files
      // for one shared word (e.g. "unsourced deployed Masterdata zz994").
      // Require at least two query tokens in the same indexed path/chunk.
      if(matchMode==="any_term_fallback"&&terms.length>=3){
        matches=matches.filter(m=>{
          const haystack=(m.relativePath+" "+m.body).normalize("NFKC").toLocaleLowerCase("vi");
          return terms.filter(t=>haystack.includes(t)).length>=2;
        });
        matchMode="any_term_fallback_min_two";
      }
      const unique = new Set();
      const results = [];
      let stale = 0;
      for (const match of matches) {
        if (unique.has(match.repoId + ":" + match.relativePath)) continue;
        unique.add(match.repoId + ":" + match.relativePath);
        const root = roots.get(match.repoId);
        const absolutePath = path.join(root, match.relativePath);
        let verified = false;
        try {
          const found = await readSafeFile({
            repoId: match.repoId, root, relativePath: match.relativePath, absolutePath: await import("node:fs/promises").then((m) => m.realpath(absolutePath)),
          });
          verified = found?.hash === match.sha256;
        } catch {}
        if (!verified) stale++;
        const bodyLines = match.body.split("\n");
        const lineOffset = bodyLines.findIndex((line) => terms.some((term) => line.toLocaleLowerCase().includes(term)));
        const relativeLine = Math.max(0, lineOffset);
        const snippet = verified ? bodyLines.slice(Math.max(0, relativeLine - 1), relativeLine + 2)
          .map((line) => line.slice(0, 220)).join("\n").slice(0, 550) : null;
        results.push({
          repoId: match.repoId, relativePath: match.relativePath, language: match.language,
          startLine: match.startLine + relativeLine, endLine: Math.min(match.endLine, match.startLine + relativeLine + 2),
          sha256: match.sha256, score: Number(match.score.toFixed(4)),
          freshness: verified ? "verified_current_hash" : "stale_or_unavailable",
          snippet,
          ...(verified&&tsEvidence.get(match.repoId+":"+match.relativePath)?.sha256===match.sha256?{
            astMatch:{kind:tsEvidence.get(match.repoId+":"+match.relativePath).kind,
              name:tsEvidence.get(match.repoId+":"+match.relativePath).name,
              line:tsEvidence.get(match.repoId+":"+match.relativePath).startLine}}:{}),
        });
        if (results.length >= (tsRerank?Math.min(160,limit*5):limit)) break;
      }
      if(tsRerank&&tsEvidence.size){
        const priority={next_page:0,next_api_route:1,export_binding:2,http_request:3,symbol:4,service_call:5};
        results.sort((a,b)=>{
          const rank=x=>x.astMatch?priority[x.astMatch.kind]??10:20;
          return rank(a)-rank(b)||a.score-b.score;
        });
      }
      // Exact basename is stronger source evidence than a vague lexical mention.
      // Files are read and SHA-verified before promotion; never infer semantic
      // business equivalence from aliases or from a coincidental substring.
      const exactSourceFileMatches=[];
      const symbolQuery=/^[A-Za-z][A-Za-z0-9_.-]{2,100}$/u.test(query.trim())?
        query.trim().toLowerCase():null;
      if(symbolQuery){
        const direct=db.prepare("SELECT repo_id AS repoId,relative_path AS relativePath,language,sha256 FROM files "+
          "WHERE LOWER(relative_path) LIKE ? ORDER BY relative_path LIMIT 150");
        const rows=direct.all("%"+symbolQuery+"%").filter(f=>
          (!repoIds.length||repoIds.includes(f.repoId))&&
          (!languages.length||languages.includes(f.language)));
        for(const file of rows){
          const base=path.basename(file.relativePath).toLowerCase();
          const stem=base.replace(/\.(?:blade\.php|php|cs|ts|tsx|sql|json)$/iu,"");
          const matched=base===symbolQuery||stem===symbolQuery||
            stem===symbolQuery+".service"||stem===symbolQuery+".controller";
          if(!matched)continue;
          const root=roots.get(file.repoId);
          let safe=null;
          try{
            const absolute=path.join(root,file.relativePath);
            const resolved=await import("node:fs/promises").then(fs=>fs.realpath(absolute));
            safe=await readSafeFile({root,relativePath:file.relativePath,absolutePath:resolved});
          }catch{}
          if(safe?.hash!==file.sha256)continue;
          exactSourceFileMatches.push({repoId:file.repoId,relativePath:file.relativePath,
            language:file.language,startLine:1,endLine:Math.min(3,safe.text.split("\n").length),
            sha256:file.sha256,score:-100,freshness:"verified_current_hash",
            snippet:safe.text.split("\n").slice(0,3).join("\n").slice(0,400),
            sourceMatch:"verified_exact_basename",
          });
          if(exactSourceFileMatches.length>=limit)break;
        }
      }
      const ranked=[...exactSourceFileMatches,...results].filter((r,i,a)=>
        a.findIndex(x=>x.repoId===r.repoId&&x.relativePath===r.relativePath)===i).slice(0,limit);
      return {
        projectId, query, indexRevision: revision.revision, indexedAt: revision.indexed_at,
        repoSnapshots: readRepoSnapshots(db),
        mode: "lexical_fts5", matchMode,
        ranking:exactSourceFileMatches.length?"verified_exact_basename_then_ast_fts":
          tsRerank&&tsEvidence.size?"ts_ast_evidence_then_fts":"fts5",
        results:ranked, count: ranked.length,
        staleResults: ranked.filter(x=>x.freshness==="stale_or_unavailable").length,
        truncated: matches.length >= Math.min(160, limit * 6) && results.length >= limit,
        note: "Lexical FTS5; PHP, C# and TS/Next AST search/trace are separate. HTTP contract matches remain candidates when runtime base URL or adapter selection is not proved; C4 is later."
      };
    } finally { db?.close(); }
  }

  async function validatePhpQuery({projectId,query,repoIds=[],limit=10,maxDepth=5}={}) {
    validateProjectId(projectId);
    const project=await registry.ensureProjectAllowed(projectId);
    tokenize(query);
    if (!Array.isArray(repoIds)||repoIds.length>12||repoIds.some(r=>
      !project.repositories.some(repo=>repo.id===r && repo.languages.includes("php"))) ||
      !Number.isInteger(limit)||limit<1||limit>30 ||
      !Number.isInteger(maxDepth)||maxDepth<1||maxDepth>7) {
      reject("INVALID_ARGUMENTS","Invalid PHP trace/search scope, limit or depth.");
    }
    return project;
  }

  async function verifyPhpFacts(project,facts) {
    const rootByRepo=new Map(project.repositories.map(r=>[r.id,r.root]));
    const hashes=new Map();
    const results=[];
    for(const fact of facts) {
      const key=fact.repoId+":"+fact.relativePath;
      if (!hashes.has(key)) {
        let hash=null;
        try {
          const root=rootByRepo.get(fact.repoId);
          if (root) {
            const p=path.join(root,fact.relativePath);
            const resolved=await import("node:fs/promises").then(fs=>fs.realpath(p));
            const read=await readSafeFile({root,relativePath:fact.relativePath,absolutePath:resolved});
            hash=read?.hash ?? null;
          }
        } catch {}
        hashes.set(key,hash);
      }
      const current=hashes.get(key)===fact.sha256;
      results.push({
        ...fact,
        freshness:current?"verified_current_hash":"stale_or_unavailable",
        // No stale AST claims or details are returned as if they describe current source.
        ...(current?{}:{details:null,status:"stale_or_unavailable"}),
      });
    }
    return results;
  }

  async function phpSearch({projectId,query,repoIds=[],limit=10,kinds=[]}={}) {
    const project=await validatePhpQuery({projectId,query,repoIds,limit});
    if (!Array.isArray(kinds) || kinds.length>12 ||
      kinds.some(k=>typeof k!=="string" || k.length>40)) {
      reject("INVALID_ARGUMENTS","Invalid PHP fact kinds filter.");
    }
    let db;
    try {
      db=await openExistingIndex(indexRoot,projectId);
      if(!db||!currentRevision(db))reject("INDEX_MISSING","Run index before PHP AST lookup.");
      if(readPhpAdapterVersion(db)!==PHP_ADAPTER_VERSION) {
        reject("PHP_INDEX_MISSING","Run incremental index to populate PHP AST facts for this adapter version.");
      }
      const facts=await verifyPhpFacts(project,findPhpFacts(db,query,{repoIds,kinds,limit}));
      return {
        projectId,query,mode:"php_ast",indexRevision:currentRevision(db).revision,
        results:facts,count:facts.length,parseErrors:getPhpCounts(db).parseErrors,
        interpretation:"Static PHP AST facts; aliases are retrieval hints, not proof of data-grain or cross-system equivalence.",
      };
    } finally { db?.close(); }
  }

  async function trace({projectId,query,repoIds=[],maxDepth=5,limit=3,language="php",direction="downstream",maxNodes=75,languages=[]}={}) {
    if(language==="all")return evidenceGraph({projectId,query,repoIds,languages,direction,maxDepth,maxNodes,limit});
    if(direction!=="downstream"||languages.length||maxNodes!==75)
      reject("INVALID_ARGUMENTS","Directed graph options require trace(language=all); language-specific traces remain downstream.");
    if(language==="csharp")return csharpTrace({projectId,query,repoIds,maxDepth,limit});
    if(language==="typescript")return typescriptTrace({projectId,query,repoIds,maxDepth,limit});
    if(language!=="php")reject("INVALID_ARGUMENTS","Trace language must be php, csharp or typescript.");
    const project=await validatePhpQuery({projectId,query,repoIds,limit,maxDepth});
    let db;
    try {
      db=await openExistingIndex(indexRoot,projectId);
      if(!db||!currentRevision(db))reject("INDEX_MISSING","Run index before PHP tracing.");
      if(readPhpAdapterVersion(db)!==PHP_ADAPTER_VERSION)reject("PHP_INDEX_MISSING","Run incremental index for PHP AST first.");
      const candidates=findPhpFacts(db,query,{repoIds,
        kinds:["blade_route_reference","route","method","model","class","migration_table","table_access"],limit});
      const graph=tracePhpGraph(db,candidates.map(f=>f.id),{maxDepth,maxNodes:70});
      const nodes=await verifyPhpFacts(project,graph.nodes);
      // Hide links depending on stale source; they might no longer be true.
      const valid=new Set(nodes.filter(n=>n.freshness==="verified_current_hash").map(n=>n.id));
      const edges=graph.edges.filter(e=>valid.has(e.fromId) && (e.toId===null||valid.has(e.toId)));
      return {
        projectId,query,mode:"php_static_evidence_trace",
        indexRevision:currentRevision(db).revision,roots:candidates.map(f=>f.id),
        nodes,edges,truncated:graph.truncated,parseErrors:getPhpCounts(db).parseErrors,
        limitations:[
          "Only static PHP relationships; dynamic routes, Laravel magic methods and runtime DI can be unresolved.",
          "A model field and migration table do not establish per-course versus per-cohort credit grain.",
          "PHP legacy nodes are not linked to C# or TypeScript before Phase 4/5.",
        ],
      };
    } finally { db?.close(); }
  }

  async function validateCsharpQuery({projectId,query,repoIds=[],limit=10,maxDepth=5}={}){
    validateProjectId(projectId);
    const project=await registry.ensureProjectAllowed(projectId);
    tokenize(query);
    if(!Array.isArray(repoIds)||repoIds.length>12||new Set(repoIds).size!==repoIds.length||
      repoIds.some(id=>!project.repositories.some(repo=>repo.id===id&&repo.languages.includes("csharp")))||
      !Number.isInteger(limit)||limit<1||limit>30||!Number.isInteger(maxDepth)||
      maxDepth<1||maxDepth>7)reject("INVALID_ARGUMENTS","Invalid C# query scope, limit or trace depth.");
    return project;
  }

  async function csharpSearch({projectId,query,repoIds=[],limit=10,kinds=[]}={}){
    const project=await validateCsharpQuery({projectId,query,repoIds,limit});
    if(!Array.isArray(kinds)||kinds.length>12||kinds.some(k=>typeof k!=="string"||k.length>40))
      reject("INVALID_ARGUMENTS","Invalid C# fact kinds.");
    let db;
    try{
      db=await openExistingIndex(indexRoot,projectId);
      if(!db||!currentRevision(db))reject("INDEX_MISSING","Run index before C# analysis.");
      if(readCsharpAdapterVersion(db)!==CSHARP_ADAPTER_VERSION)
        reject("CSHARP_INDEX_MISSING","Run incremental index to populate Roslyn C# facts.");
      const facts=await verifyPhpFacts(project,findCsharpFacts(db,query,{repoIds,kinds,limit}));
      return {projectId,query,mode:"csharp_roslyn_ast",indexRevision:currentRevision(db).revision,
        results:facts,count:facts.length,parseErrors:getCsharpCounts(db).parseErrors,
        interpretation:"Static Roslyn syntax and locally declared symbols; dependency/handler mappings remain candidates when external dependencies are not semantically bound."};
    }finally{db?.close();}
  }

  async function csharpTrace({projectId,query,repoIds=[],maxDepth=5,limit=3}={}){
    const project=await validateCsharpQuery({projectId,query,repoIds,limit,maxDepth});
    let db;
    try{
      db=await openExistingIndex(indexRoot,projectId);
      if(!db||!currentRevision(db))reject("INDEX_MISSING","Run index before C# tracing.");
      if(readCsharpAdapterVersion(db)!==CSHARP_ADAPTER_VERSION)
        reject("CSHARP_INDEX_MISSING","Run incremental index before C# trace.");
      const candidates=findCsharpFacts(db,query,{repoIds,
        kinds:["endpoint","controller","controller_method","cqrs_handler","cqrs_request","ef_context",
          "ef_dbset","ef_configuration","ef_table","di_registration","class"],limit});
      const graph=traceCsharpGraph(db,candidates.map(x=>x.id),{maxDepth,maxNodes:85});
      const nodes=await verifyPhpFacts(project,graph.nodes);
      const valid=new Set(nodes.filter(n=>n.freshness==="verified_current_hash").map(n=>n.id));
      const edges=graph.edges.filter(e=>valid.has(e.fromId)&&(e.toId===null||valid.has(e.toId)));
      return {projectId,query,mode:"csharp_static_evidence_trace",
        indexRevision:currentRevision(db).revision,roots:candidates.map(f=>f.id),
        nodes,edges,truncated:graph.truncated,parseErrors:getCsharpCounts(db).parseErrors,
        limitations:[
          "Roslyn syntax and same-batch declared symbol checks do not form a fully referenced VAA solution compilation.",
          "MediatR handler binding, constructor injection, and EF mappings can be candidates; no runtime DI validation.",
          "Current C# repo branch may lack feature endpoints found in another branch.",
          "Legacy PHP to C# equivalence is not verified by common naming; compare only suggests candidates.",
        ]};
    }finally{db?.close();}
  }

  async function compare({projectId,query,limit=8}={}){
    validateProjectId(projectId);
    const project=await registry.ensureProjectAllowed(projectId);
    tokenize(query);
    if(!Number.isInteger(limit)||limit<1||limit>20)reject("INVALID_ARGUMENTS","Compare result limit must be 1–20.");
    const phpIds=project.repositories.filter(r=>r.languages.includes("php")).map(r=>r.id);
    const csIds=project.repositories.filter(r=>r.languages.includes("csharp")).map(r=>r.id);
    let db;
    try{
      db=await openExistingIndex(indexRoot,projectId);
      if(!db||!currentRevision(db))reject("INDEX_MISSING","Index registered repositories before comparing.");
      if(readPhpAdapterVersion(db)!==PHP_ADAPTER_VERSION||
        readCsharpAdapterVersion(db)!==CSHARP_ADAPTER_VERSION)
        reject("AST_INDEX_MISSING","Run incremental index for both PHP and C# adapters.");
      // Domain-specific anchor terms prevent broad labels such as "teaching" or
      // "course" from flooding the comparison with unrelated endpoint candidates.
      const domainProfiles=[
        {test:/thiết bị|điện thoại|teaching devices|phone|device/iu,
          php:["phone","allow_phone"],csharp:["device","coursesubjectphone","coursephone"]},
        {test:/giáo trình|học liệu|course books|course-books/iu,
          php:["course-books","CourseBook"],csharp:["reading","coursebook","course-book"]},
        {test:/tín chỉ|credit/iu,
          php:["credit"],csharp:["credit"]},
      ];
      const profile=domainProfiles.find(p=>p.test.test(query));
      const phpKinds=["route","class","model","method","table_access","model_field"];
      const csKinds=["endpoint","controller","controller_method","cqrs_handler","class",
        "ef_dbset","dto","dto_field","ef_property","ef_migration_column"];
      function anchored(kind,ids,kinds,terms) {
        const found=new Map();
        for(const term of terms) {
          const matches=(kind==="php"?findPhpFacts(db,term,{repoIds:ids,kinds,limit:45}):
            findCsharpFacts(db,term,{repoIds:ids,kinds,limit:45}));
          for(const fact of matches) {
            if(fact.name.toLocaleLowerCase().includes(term.toLocaleLowerCase()))
              found.set(fact.id,fact);
          }
        }
        return [...found.values()].sort((a,b)=>{
          const rank=x=>["route","endpoint"].includes(x.kind)?0:
            ["model","controller","cqrs_handler"].includes(x.kind)?1:2;
          return rank(a)-rank(b)||a.name.length-b.name.length;
        }).slice(0,limit);
      }
      const php=await verifyPhpFacts(project,profile?
        anchored("php",phpIds,phpKinds,profile.php):
        findPhpFacts(db,query,{repoIds:phpIds,limit,kinds:phpKinds}));
      const cs=await verifyPhpFacts(project,profile?
        anchored("csharp",csIds,csKinds,profile.csharp):
        findCsharpFacts(db,query,{repoIds:csIds,limit,kinds:csKinds}));
      const exactRouteCandidates=[];
      for(const a of php.filter(x=>x.kind==="route"&&x.freshness==="verified_current_hash")){
        for(const b of cs.filter(x=>x.kind==="endpoint"&&x.freshness==="verified_current_hash")){
          if(a.name.toLowerCase()===b.name.toLowerCase()){
            exactRouteCandidates.push({phpFactId:a.id,csharpFactId:b.id,methodAndPath:a.name,
              status:"contract_candidate",reason:"Exact verb and route path in source; no proof of equivalent behavior."});
          }
        }
      }
      return {projectId,query,indexRevision:currentRevision(db).revision,
        phpCandidates:php,csharpCandidates:cs,exactRouteCandidates,
        verifiedCrossRepositoryLinks:[],mappingStatus:"not_verified",
        interpretation:"Aliases and route matches are discovery candidates only. No runtime equivalence, migration completeness, credit grain, or Masterdata lineage is asserted."};
    }finally{db?.close();}
  }


  async function validateTypescriptQuery({projectId,query,repoIds=[],limit=10,maxDepth=7}={}){
    validateProjectId(projectId);
    const project=await registry.ensureProjectAllowed(projectId);
    tokenize(query);
    if(!Array.isArray(repoIds)||repoIds.length>12||new Set(repoIds).size!==repoIds.length||
      repoIds.some(id=>!project.repositories.some(repo=>repo.id===id&&repo.languages.includes("typescript")))||
      !Number.isInteger(limit)||limit<1||limit>30||!Number.isInteger(maxDepth)||
      maxDepth<1||maxDepth>9)
      reject("INVALID_ARGUMENTS","Invalid TypeScript search scope, limit or depth.");
    return project;
  }

  async function typescriptSearch({projectId,query,repoIds=[],limit=10,kinds=[]}={}){
    const project=await validateTypescriptQuery({projectId,query,repoIds,limit});
    if(!Array.isArray(kinds)||kinds.length>12||kinds.some(x=>typeof x!=="string"||x.length>40))
      reject("INVALID_ARGUMENTS","Invalid TS AST fact kinds.");
    let db;
    try{
      db=await openExistingIndex(indexRoot,projectId);
      if(!db||!currentRevision(db))reject("INDEX_MISSING","Index the project before TS search.");
      if(readTsAdapterVersion(db)!==TYPESCRIPT_ADAPTER_VERSION)
        reject("TYPESCRIPT_INDEX_MISSING","Run incremental index to enable TypeScript AST.");
      const results=await verifyPhpFacts(project,findTsFacts(db,query,{repoIds,kinds,limit}));
      return {projectId,query,mode:"typescript_ast",indexRevision:currentRevision(db).revision,
        results,count:results.length,parseErrors:getTsCounts(db).parseErrors,
        interpretation:"Static TypeScript/TSX syntax; Next routes and imports have source evidence, not proof of runtime execution."};
    }finally{db?.close();}
  }

  async function typescriptTrace({projectId,query,repoIds=[],limit=3,maxDepth=7}={}){
    const project=await validateTypescriptQuery({projectId,query,repoIds,limit,maxDepth});
    let db;
    try{
      db=await openExistingIndex(indexRoot,projectId);
      if(!db||!currentRevision(db))reject("INDEX_MISSING","Index the project first.");
      if(readTsAdapterVersion(db)!==TYPESCRIPT_ADAPTER_VERSION)
        reject("TYPESCRIPT_INDEX_MISSING","Run incremental index for TS AST.");
      const searched=findTsFacts(db,query,{repoIds,limit:Math.min(30,limit*8),
        kinds:["next_page","next_api_route","export_binding","http_request","service_call","symbol","http_client","module"]});
      // For exact Next routes and named symbols, never launch unrelated partial-match roots.
      const exact=searched.filter(x=>x.name.toLocaleLowerCase("vi")===query.toLocaleLowerCase("vi"));
      const roots=(exact.length?exact:searched).slice(0,limit);
      const graph=traceTsGraph(db,roots.map(x=>x.id),{maxDepth,maxNodes:160,focus:query});
      const nodes=await verifyPhpFacts(project,graph.nodes);
      const valid=new Set(nodes.filter(x=>x.freshness==="verified_current_hash").map(x=>x.id));
      const edges=graph.edges.filter(e=>valid.has(e.fromId)&&(e.toId===null||valid.has(e.toId)));
      const activeMockEdges=edges.filter(e=>e.kind==="active_mock_binding");
      return {projectId,query,indexRevision:currentRevision(db).revision,
        mode:"typescript_static_dependency_trace",roots:roots.map(x=>x.id),
        nodes,edges,truncated:graph.truncated,activeMockEdges,
        limitations:[
          "A static import is not proof a route is reached at runtime; type-only imports are distinct.",
          "The @/ alias is resolved only when the target exists in the indexed source; compatibility with tsconfig is a candidate.",
          "A mock export binding is local static evidence of selected mock adapter, not a backend HTTP call.",
          "Relative HTTP paths and runtime environment base URLs do not establish deployed FE-to-BE linkage.",
        ]};
    }finally{db?.close();}
  }

  async function matchFrontendBackend({projectId,query,limit=10}={}){
    validateProjectId(projectId);
    const project=await registry.ensureProjectAllowed(projectId);
    tokenize(query);
    if(!Number.isInteger(limit)||limit<1||limit>30)
      reject("INVALID_ARGUMENTS","Match limit must be 1–30.");
    const frontendIds=project.repositories.filter(r=>r.languages.includes("typescript")).map(r=>r.id);
    const backendIds=project.repositories.filter(r=>r.languages.includes("csharp")).map(r=>r.id);
    let db;
    try{
      db=await openExistingIndex(indexRoot,projectId);
      if(!db||!currentRevision(db))reject("INDEX_MISSING","Index project before FE-to-BE matching.");
      if(readTsAdapterVersion(db)!==TYPESCRIPT_ADAPTER_VERSION||
         readCsharpAdapterVersion(db)!==CSHARP_ADAPTER_VERSION)
        reject("AST_INDEX_MISSING","Run incremental index for TS and C# AST first.");
      // Only syntactically present HTTP calls in the registered FE are candidates.
      const requests=await verifyPhpFacts(project,findTsHttpRequests(db,frontendIds,8000));
      const mockBindings=await verifyPhpFacts(project,findActiveMockBindings(db,frontendIds,150));
      const normalized=q=>q.toLocaleLowerCase("vi").replace(/[^\p{L}\p{N}]+/gu,"");
      const queryKey=normalized(query);
      const queryKeys=[queryKey];
      if(queryKey.endsWith("classes"))queryKeys.push(queryKey.slice(0,-7)+"class");
      // Apply complete anchors to each field independently: joining name+path first could
      // manufacture a false match over the string boundary (e.g. teaching-plan + src).
      const related=x=>queryKeys.some(k=>normalized(x.name).includes(k)||
        normalized(x.relativePath).includes(k));
      const matchingRequests=requests.filter(x=>x.freshness==="verified_current_hash"&&related(x));
      const activeAdapters=mockBindings.filter(x=>x.freshness==="verified_current_hash"&&related(x)).slice(0,limit);
      const backend=db.prepare("SELECT f.*,fi.sha256 FROM csharp_facts f JOIN files fi ON fi.file_id=f.file_id WHERE f.kind='endpoint' "+
        "AND f.repo_id IN ("+backendIds.map(()=>"?").join(",")+") LIMIT 2500").all(...backendIds);
      const endpoints=backend.map(x=>({id:x.id,repoId:x.repo_id,relativePath:x.relative_path,
        name:x.name,startLine:x.start_line,sha256:x.sha256,status:x.status}));
      const candidates=[];
      const unresolved=[];
      const requestsToInspect=matchingRequests.slice(0,250);
      for(const req of requestsToInspect){
        const method=req.details?.httpMethod,reqPath=req.details?.normalizedPath;
        if(!reqPath||!method||method==="UNKNOWN"){
          unresolved.push({repoId:req.repoId,relativePath:req.relativePath,
            line:req.startLine,reason:"dynamic_http_url_or_method"});continue;
        }
        const same=[];
        for(const endpoint of endpoints){
          const split=endpoint.name.match(/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\/.*)$/u);
          if(!split||split[1]!==method)continue;
          const backendPath=normalizeHttpPath(split[2]);
          const exact=backendPath===reqPath;
          // /api is a framework convention, NOT proof that the environment base URL carries /api.
          const possible=backendPath?.startsWith("/api/")&&backendPath.slice(4)===reqPath;
          if(exact||possible)same.push({endpoint,comparison:exact?"exact_method_path":"possible_api_prefix",
            status:exact?"static_contract_candidate":"inferred_prefix_candidate"});
        }
        for(const match of same.slice(0,10))candidates.push({
          frontend:{id:req.id,repoId:req.repoId,relativePath:req.relativePath,line:req.startLine,
            httpMethod:method,normalizedPath:reqPath,client:req.details.client,
            freshness:req.freshness},
          backend:{id:match.endpoint.id,repoId:match.endpoint.repoId,
            relativePath:match.endpoint.relativePath,line:match.endpoint.startLine,
            endpoint:match.endpoint.name},
          comparison:match.comparison,status:match.status,
          baseURLStatus:"not_proven_at_runtime",adapterStatus:"http_call_in_source_not_proven_active",
        });
      }
      const matches=candidates.slice(0,limit);
      const validBackend=new Set((await verifyPhpFacts(project,endpoints.filter(e=>
        matches.some(c=>c.backend.id===e.id)))).filter(e=>e.freshness==="verified_current_hash").map(e=>e.id));
      return {
        projectId,query,indexRevision:currentRevision(db).revision,
        mode:"frontend_http_contract_candidates",activeMockAdapters:activeAdapters,
        httpRequestCandidates:matchingRequests.length,matchedContracts:matches.filter(x=>validBackend.has(x.backend.id)),
        unresolvedRequests:unresolved.slice(0,limit),verifiedRuntimeLinks:[],
        adapterInterpretation:activeAdapters.length?
          "Source explicitly selects mock adapter; do not claim this service sends HTTP.":"No active mock binding established for this query.",
        limitations:[
          "Only syntactically visible HTTP calls (including unused services) are counted, not live browser traffic.",
          "Method+route equality is contract evidence only; API base URL, deployment and authorization remain unverified.",
          "A /api prefix match is inferred; never claim the FE actually uses the C# backend on that basis.",
          "No matching request is not proof the feature does not exist or has no dynamic HTTP wrapper.",
        ],
      };
    }finally{db?.close();}
  }

  function graphOptions({project,query,repoIds=[],languages=[],limit=3,
    maxDepth=5,maxNodes=65,direction="downstream"}){
    if(query!==undefined&&query!==null)tokenize(query);
    if(!Array.isArray(repoIds)||repoIds.length>12||new Set(repoIds).size!==repoIds.length||
       repoIds.some(x=>typeof x!=="string"||!project.repositories.some(r=>r.id===x)))
      reject("INVALID_ARGUMENTS","Graph repoIds must belong to the registered allowlist.");
    if(!Array.isArray(languages)||new Set(languages).size!==languages.length||
      languages.length>3||languages.some(x=>!["php","csharp","typescript"].includes(x)))
      reject("INVALID_ARGUMENTS","Graph languages must be php, csharp or typescript.");
    if(!Number.isInteger(limit)||limit<1||limit>30||
       !Number.isInteger(maxDepth)||maxDepth<1||maxDepth>8||
       !Number.isInteger(maxNodes)||maxNodes<8||maxNodes>120||
       !["upstream","downstream","both"].includes(direction))
      reject("INVALID_ARGUMENTS","Graph limits/direction are invalid.");
    return {repoIds,languages:languages.length?languages:["php","csharp","typescript"],
      limit,maxDepth,maxNodes,direction};
  }

  async function evidenceGraph({projectId,query,repoIds=[],languages=[],direction="downstream",
    limit=3,maxDepth=5,maxNodes=65}={}){
    validateProjectId(projectId);
    const project=await registry.ensureProjectAllowed(projectId);
    const options=graphOptions({project,query,repoIds,languages,direction,limit,maxDepth,maxNodes});
    if(!query?.trim())reject("INVALID_ARGUMENTS","Graph trace and impact require a bounded source locator or business query.");
    let db;
    try{
      db=await openExistingIndex(indexRoot,projectId);
      if(!db||!currentRevision(db))reject("INDEX_MISSING","Index the registered project before graph projection.");
      const versionMissing=options.languages.filter(lang=>{
        const active=project.repositories.some(repo=>repo.languages.includes(lang)&&
          (!repoIds.length||repoIds.includes(repo.id)));
        if(!active)return false;
        const actual=lang==="php"?readPhpAdapterVersion(db):
          lang==="csharp"?readCsharpAdapterVersion(db):readTsAdapterVersion(db);
        const expected=lang==="php"?PHP_ADAPTER_VERSION:
          lang==="csharp"?CSHARP_ADAPTER_VERSION:TYPESCRIPT_ADAPTER_VERSION;
        return actual!==expected;
      });
      if(versionMissing.length)reject("AST_INDEX_MISSING","Run incremental index before graph analysis for: "+versionMissing.join(", ")+".");
      const revision=currentRevision(db).revision;
      const roots=selectEvidenceRoots(db,query,{...options,revision});
      const raw=traverseEvidence(db,roots,{...options,revision,maxEdges:maxNodes*5,focus:query});
      const checked=await verifyPhpFacts(project,raw.nodes);
      const graph=redactStaleGraph(raw,checked);
      return {projectId,query,indexRevision:revision,mode:"unified_static_evidence_graph",
        ...graph,rootEvidence:roots.map(r=>({stableId:r.stableId,kind:r.kind,
          name:r.name,repoId:r.repoId,relativePath:r.relativePath,startLine:r.startLine,
          freshness:graph.roots.includes(r.stableId)?"verified_current_hash":"stale_or_unavailable"})),
        limitations:["Every edge comes from language-specific indexed evidence, not a business-label heuristic.",
          "The graph has no invented cross-repository runtime edges; contract candidates are a separate comparison.",
          "The graph is bounded and source hashes are rechecked; absent links may mean incomplete parsing."],
      };
    }finally{db?.close();}
  }

  async function impact({projectId,query,repoIds=[],languages=[],
    direction="upstream",maxDepth=5,maxNodes=65,limit=3}={}){
    const graph=await evidenceGraph({projectId,query,repoIds,languages,direction,maxDepth,maxNodes,limit});
    const result=classifyImpact(graph);
    let existingTestCandidates=[];
    let db;
    try{
      db=await openExistingIndex(indexRoot,projectId);
      if(db){
        const candidates=indexedTestCandidates(db,query,{repoIds,limit:12});
        const project=await registry.ensureProjectAllowed(projectId);
        const fresh=await verifyPhpFacts(project,candidates);
        existingTestCandidates=fresh.filter(x=>x.freshness==="verified_current_hash");
      }
    }finally{db?.close();}
    return {projectId,query,indexRevision:graph.indexRevision,mode:"bounded_static_impact",
      ...result,roots:graph.rootEvidence,sourceFilesChecked:graph.nodes.length,
      staleFilteredEdges:graph.staleFilteredEdges,
      existingTestCandidates,testCoverage:"not_verified_source_filename_matches_only"};
  }

  async function architecture({projectId,level="C2",query,repoIds=[],languages=[],
    direction="downstream",maxDepth=5,maxNodes=65,limit=3}={}){
    validateProjectId(projectId);
    const project=await registry.ensureProjectAllowed(projectId);
    const options=graphOptions({project,query,repoIds,languages,direction,limit,maxDepth,maxNodes});
    if(!["C1","C2","C3","C4"].includes(level))
      reject("INVALID_ARGUMENTS","Architecture level must be C1, C2, C3 or C4.");
    let db;
    try{
      db=await openExistingIndex(indexRoot,projectId);
      if(!db||!currentRevision(db))reject("INDEX_MISSING","Index the project before generating architecture views.");
      const revision=currentRevision(db).revision;
      if(level==="C1"){
        const curated=await loadCuratedContext({stateRoot:registry.stateRoot,projectId,project,db});
        return {projectId,indexRevision:revision,...projectC1(project,revision,{curated}),
          repoSnapshots:readRepoSnapshots(db)};
      }
      if(level==="C2"){
        let contracts=[];
        let activeMockAdapters=[];
        let unresolvedRequests=[];
        let httpRequestCandidates=0;
        if(query?.trim()){
          if(!project.repositories.some(r=>r.languages.includes("typescript"))||
             !project.repositories.some(r=>r.languages.includes("csharp"))) {
            // No inference that unregistered systems are integrated.
          }else{
            const matched=await matchFrontendBackend({projectId,query,limit:Math.min(10,limit*3)});
            contracts=matched.matchedContracts;
            unresolvedRequests=matched.unresolvedRequests;
            httpRequestCandidates=matched.httpRequestCandidates;
            activeMockAdapters=matched.activeMockAdapters.map(m=>({
              repoId:m.repoId,relativePath:m.relativePath,name:m.name,sourceLine:m.startLine,
              mockModule:m.mockModule}));
          }
        }
        const view=projectC2({...project,repositories:project.repositories.filter(r=>
          !repoIds.length||repoIds.includes(r.id))},db,revision,{contracts});
        const dataFlowBreaks=[
          ...activeMockAdapters.map(m=>({kind:"selected_mock_adapter",at:m.relativePath,
            line:m.sourceLine,target:m.mockModule,
            reason:"FE source exports a mock adapter; no backend HTTP invocation is established."})),
          ...unresolvedRequests.map(r=>({kind:"dynamic_http_request",at:r.relativePath,
            line:r.line,reason:"Request URL/method could not be resolved statically."})),
        ];
        return {projectId,indexRevision:revision,query:query??null,
          ...view,activeMockAdapters,httpRequestCandidates,dataFlowBreaks,
          verifiedRuntimeLinks:[],dataFlowStatus:"runtime_unverified"};
      }
    }finally{db?.close();}
    if(!query?.trim())reject("INVALID_ARGUMENTS","C3/C4 require a feature, route or symbol locator to prevent giant diagrams.");
    const graph=await evidenceGraph({projectId,query,repoIds,languages,direction,maxDepth,maxNodes,limit});
    const view=projectC4FromGraph(graph,{level,maxNodes,projectId});
    return {projectId,indexRevision:graph.indexRevision,query,roots:graph.rootEvidence,
      ...view,sourceFilesChecked:graph.nodes.length,staleFilteredEdges:graph.staleFilteredEdges,
      confidence:"source_static_only",mermaidFormat:"flowchart LR (C4-level conceptual projection, not deployment chart)"};
  }

  return { index,status,search,phpSearch,csharpSearch,typescriptSearch,
    trace,compare,matchFrontendBackend,evidenceGraph,impact,architecture };
}
