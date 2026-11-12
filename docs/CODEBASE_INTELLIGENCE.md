# Codebase Intelligence - Phase 8 release candidate (PHP/Laravel + C#/.NET + TS/Next.js + C4 + Obsidian)

The bridge exposes **one** MCP tool: `openclaw_codebase_intelligence`.

**Implemented:** project registry, safe on-demand source inventory, incremental SQLite FTS5, plus **PHP/Laravel static AST facts and evidence-only PHP tracing** (route groups, controllers/methods, Eloquent models/relations, migration tables/columns, query-builder operations, Blade named-route references and template candidates). The PHP helper uses independently pinned `nikic/php-parser` v5.7.0 and does not execute analyzed code.

**Phase 4 implemented:** a standalone Roslyn syntax/partial-semantic extractor for C# controllers and HTTP attributes, DTOs, MediatR request/handler references, dependency injection, EF Core DbContext/DbSet/config, migrations and literal SQL operations. A C# graph supports `csharp/find`, `trace` (language=csharp); `compare` returns legacy PHP ↔ C# candidates **without claiming the systems are functionally equivalent**.

**Phase 5 implemented:** isolated TypeScript Compiler 5.8.3 static AST for TS/TSX and Next App Router pages/API routes, imports, re-exports, export bindings, service calls, axios/fetch and environment-backed API client definitions. The TypeScript graph connects configured `@/*` aliases and local relative imports, detects actual selected mock adapters, and exposes `typescript/find`, `trace(language=typescript)`, and `match` for **FE↔BE HTTP contract candidates**. FTS5 search is reranked by source-backed TS route/symbol hits.

**Phase 6 implemented:** unified **read-only** evidence graph from existing PHP/C#/TS SQLite facts and edges; stable public graph IDs independent of SQLite row IDs, revision+SHA provenance, cycle/depth/node budgets, upstream/downstream/both traversal, `impact` direct/indirect/potential dependency classification with indexed test-filename candidates, and `architecture` C1–C4 **Mermaid** projections. C1 optionally loads curated context JSON from OpenClaw state with source-line verification; C2 recognizes ASP.NET Web project, Next.js and Laravel **source-based logical runtime candidates** without inventing deployment units or database servers; C3 is a bounded feature/service grouping requiring review; C4 shows source symbols with status-coded arrows. Selected mocks and dynamic URL gaps remain explicit.

**Phase 7 implemented:** explicitly allowlisted Obsidian Markdown indexing (YAML fields, headings, wikilinks, hashes, source-path references), bounded combined `docs/search` with a visible distinction between document claims and source AST/search, stale note/source detection, `docs/preview` with Mermaid Markdown and unified diff, and `docs/apply` requiring approval, a short-lived preview, source/note/index revision checks and an explicit Generated-only destination. Manual notes and manually edited generated notes are never eligible for automatic overwrite. The VAA pilot is configured **read-only**, so an actual Obsidian Generated write still needs the user to choose its destination and explicitly approve a preview.

**Phase 8 hardening:** explicit `status(checkWorktree=true)` compares Git branch/HEAD with the indexed snapshot (dirty uncommitted source needs incremental indexing); exact filename matches are SHA-verified before they outrank vague lexical FTS hits; long OR-fallback queries must match at least two terms to limit false-positive single-keyword matches. Obsidian `docs/search` exposes `noteBackedSourceReferences` as documentary navigation with current source hashes, **not** verified runtime links. Added real VAA top-5 recall benchmark, full/incremental performance measurements, fixture fault injection, extended MCP contract/smoke checks and rollout documentation. **Live connector reload and user-approved Generated writes are not part of this phase**.

**Not yet implemented:** verified FE→BE→Masterdata *runtime* data-flow, complete MSBuild/TypeScript semantic resolution, automatic impact test execution, independently verified production topology, semantic embeddings or automatic background/scheduled synchronization. P7 docs/index is on-demand; approval is required for apply. All graphs distinguish verified static source, inferred and unresolved relationships.

## Setup and data locations

The following files live outside the Git repository:

```text
%OPENCLAW_STATE_DIR%/codebase-intelligence/
  projects.json
  index/
    <projectId>.sqlite
  contexts/
    <projectId>.json   # optional manually curated C1 metadata; never auto-created
  docs-scope.json      # explicit Obsidian read roots and optional Generated-only write scope
  docs-index/
    <projectId>.json  # on-demand indexed metadata only, outside Obsidian
  docs-previews/
    <projectId>/<previewId>.json  # 12-minute pending review snapshots
  docs-published/
    <projectId>/<generated-name>.json  # owned note publishing hashes
```

`OPENCLAW_STATE_DIR` is the OpenClaw runtime state directory (commonly `%LOCALAPPDATA%/OpenClawBeta/state` on the tested Windows setup). The index persists between bridge restarts, but **in-memory job progress does not**. An interrupted SQLite transaction rolls back to the last committed revision.

Register repositories using absolute Git-root paths. Each access validates the registered paths; `status` reports missing or inaccessible repositories.

Registration (example names/roots, substitute your paths):

```json
{
  "action": "project", "operation": "register",
  "projectId": "vaa-training", "name": "VAA Training",
  "repositories": [
    {"id": "legacy-php", "root": "C:/Repo/VAA/legacy-php", "languages": ["php", "sql"]},
    {"id": "training-csharp", "root": "C:/Repo/VAA/training-backend", "languages": ["csharp", "sql"]},
    {"id": "training-ts", "root": "C:/Repo/VAA/training-frontend", "languages": ["typescript"]}
  ]
}
```

## Standalone PHP parser setup

PHP AST indexing requires PHP CLI and Composer on the local machine. The parser is pinned in `src/tools/codebase-intelligence/php-helper/composer.lock`. Install it once from that helper directory (not from any VAA repository):

```powershell
cd src\tools\codebase-intelligence\php-helper
composer install --no-dev --no-plugins --no-scripts --prefer-dist --no-interaction
```

The `vendor/` folder is ignored by Git; the committed Composer manifest and lock file make the dependency reproducible. The extractor parses code supplied via stdin and **never includes or executes the scanned project source**. If missing, indexing reports `PARSER_UNAVAILABLE` rather than switching silently to regex/guessing. Do not run Composer scripts or plugins from scanned repositories.

## Standalone Roslyn C# helper setup

Requires the installed **.NET SDK 9**. The local helper references Microsoft.CodeAnalysis assemblies bundled inside that SDK; **no NuGet packages, project restore or VAA build are needed**. Build it once from its own directory (or after changing the helper):

```powershell
cd src\tools\codebase-intelligence\csharp-helper
dotnet build CodebaseRoslyn.csproj -c Release --ignore-failed-sources
```

`bin/` and `obj/` are ignored by Git. The bridge invokes only `CodebaseRoslyn.dll` from its local helper, feeding indexed source over UTF-8 stdin. It **does not execute C# from the scanned repositories** and does not load or build their solution. If the helper DLL is absent, indexing fails with `ROSLYN_UNAVAILABLE` rather than falling back to regex.

A `CSharpCompilation` is created for a bounded source batch and exposes Roslyn `SemanticModel.GetDeclaredSymbol` for locally declared symbols. It is **not a full reference-resolved compilation of the VAA solution**. Unresolved MediatR, DI and EF relationships remain candidates.

## Standalone TypeScript/Next.js parser setup

TypeScript 5.8.3 is pinned in `src/tools/codebase-intelligence/typescript-helper/package-lock.json`. Install from the helper directory (**not from the VAA frontend**):

```powershell
cd src\tools\codebase-intelligence\typescript-helper
npm ci --ignore-scripts --no-audit --no-fund
```

`node_modules/` is ignored by Git. Only the TypeScript Compiler API (`createSourceFile` and static AST visitors) reads indexed `.ts`/`.tsx` text; the scanned project scripts are never executed or imported. `tsconfig.json` is parsed statically to discover verified `@/*` path mappings. Missing/mismatched compiler reports `TYPESCRIPT_UNAVAILABLE`, not fallback regex. The stored AST excludes HTTP query strings and credentials from normalized request paths; literal URL origins are sanitized.

## MCP actions

All examples invoke the same tool name `openclaw_codebase_intelligence`.

| Action | Arguments | Behavior |
| --- | --- | --- |
| `project` | `operation: register/list/show`, project fields | Manage registered Git repositories |
| `index` | `projectId`, `mode: full/incremental` | Queue local index job, return job ID immediately |
| `index` | `projectId`, `mode: cancel`, optional `jobId` | Request cancellation of active project job |
| `status` | `projectId`, optional `jobId` | Last committed revision and in-memory job progress/state |
| `search` | `projectId`, `query`, optional `limit`, `repoIds`, `languages` | Lexical FTS5 results, with TS route/symbol AST reranking when applicable, current file hash and bounded snippet |
| `php` | `operation: find`, `projectId`, `query`, optional `repoIds`, `kinds`, `limit` | PHP AST facts with source line, hash, fact type and status |
| `csharp` | `operation: find`, `projectId`, `query`, optional `repoIds`, `kinds`, `limit` | C# Roslyn syntax/declared-symbol facts with path, line, hash and confidence |
| `typescript` | `operation: find`, `projectId`, `query`, optional `repoIds`, `kinds`, `limit` | Source-backed TS/TSX symbols, Next routes, imports, HTTP calls, env config and mock export bindings |
| `trace` | `projectId`, `query`, optional `language=php|csharp|typescript|all`, `repoIds`, `maxDepth`, `limit`; `direction`, `maxNodes`, `languages` for `all` | Existing language-scoped static trace OR unified directed source graph with stable IDs, SHA provenance, gaps, cycles and caps |
| `impact` | `projectId`, `query`, optional `direction=upstream|downstream|both`, `maxDepth`, `maxNodes`, `limit`, `repoIds`, `languages` | Direct/indirect static dependencies and potential inferred impacts with source paths and real indexed test filename candidates |
| `architecture` | `projectId`, `level=C1|C2|C3|C4`, optional `query` (required C3/C4), `format=mermaid`, `maxDepth`, `maxNodes`, `limit`, `repoIds` | Bounded C4-level Mermaid flowchart plus structured nodes/edges, source evidence and explicit missing/deployment data |
| `docs` | `operation=index|status|search|preview|apply`, `projectId`, optional `query`/`limit` for search; `query` and optional C3/C4 `level` for preview; `previewId` and explicit `approved=true` for apply | Read scoped Obsidian notes, combine note/source results, generate a reviewed Markdown diff, and publish **only to explicitly selected Generated namespace** after hash checks |
| `compare` | `projectId`, `query`, optional `limit` | PHP legacy ↔ C# candidates; no inferred equivalence promoted to verified |
| `match` | `projectId`, `query`, optional `limit` | Active FE mock adapters, static axios/fetch calls and method/path matching C# endpoints; runtime links remain explicitly unverified |

Index for first use:

```json
{"action":"index","projectId":"vaa-training","mode":"full"}
```

Incremental update after editing source or switching branches:

```json
{"action":"index","projectId":"vaa-training","mode":"incremental"}
```

Read status (include the `jobId` returned by `index` to follow a specific job):

```json
{"action":"status","projectId":"vaa-training"}
```

Search with repository filter:

```json
{
  "action": "search", "projectId": "vaa-training",
  "query": "giáo trình học phần",
  "repoIds": ["legacy-php"],
  "languages": ["php"],
  "limit": 10
}
```

PHP source lookup after running `index`:

```json
{"action":"php","operation":"find","projectId":"vaa-training","query":"tín chỉ","repoIds":["legacy-php"],"kinds":["model_field"],"limit":10}
```

Trace a Laravel route:

```json
{"action":"trace","projectId":"vaa-training","query":"POST /admin/course-books/phones/batch-update","repoIds":["legacy-php"],"maxDepth":5}
```

Find a C# endpoint:

```json
{"action":"csharp","operation":"find","projectId":"vaa-training","query":"GET /api/teaching-surveys/active","repoIds":["training-csharp"],"kinds":["endpoint"]}
```

Trace C# MediatR/CQRS:

```json
{"action":"trace","projectId":"vaa-training","language":"csharp","query":"POST /api/teaching-surveys","repoIds":["training-csharp"],"limit":1,"maxDepth":6}
```

Compare possible PHP legacy and C# backend coverage without asserting migration or equivalent endpoints:

```json
{"action":"compare","projectId":"vaa-training","query":"teaching devices","limit":8}
```

Find the actual Next.js page and its source location:

```json
{"action":"typescript","operation":"find","projectId":"vaa-training","repoIds":["training-ts"],"query":"/teaching-devices","kinds":["next_page"]}
```

Trace a TypeScript export to the selected mock adapter (or trace the page route with `maxDepth:9`):

```json
{"action":"trace","projectId":"vaa-training","language":"typescript","repoIds":["training-ts"],"query":"teachingDevicesService","maxDepth":7}
```

Audit active mock selection and possible HTTP contract matches against C# (never a runtime/production assertion):

```json
{"action":"match","projectId":"vaa-training","query":"teaching devices","limit":8}
```

## Phase 6: directed graph, impact, and C4 projections

**Source graph:** existing `php_edges`, `csharp_edges` and `ts_edges` are projected into a common response **without altering SQLite schema v4 or creating cross-language runtime links**. Public `stableId`s are SHA-based and stable across full reindex when source paths/symbols/lines are unchanged. Each node carries repository, file, line, indexed SHA and revision; fresh hashes are checked before a fact appears in Mermaid.

```json
{"action":"trace","projectId":"vaa-training","language":"all","query":"/teaching-devices","languages":["typescript"],"direction":"downstream","maxDepth":8,"maxNodes":65,"limit":1}
```

**Impact:** `upstream` asks which files depend on the selected symbol/file; `downstream` asks which dependencies it uses; `both` follows either direction. Results separate `direct` / `indirect` verified-static edges and `potential` inferred paths. `existingTestCandidates` only lists **real indexed filenames** similar to the query, and `testCoverage` is always `not_verified_source_filename_matches_only`.

```json
{"action":"impact","projectId":"vaa-training","query":"teachingDevicesService","direction":"upstream","maxDepth":6,"maxNodes":70,"limit":1}
```

**C1–C4:** C1 is a system context, C2 is a source-based **logical container candidate** view (from Laravel composer, Next package or ASP.NET Web SDK project manifests; **not deployment verification**), C3 groups bounded feature/service source evidence requiring manual component review, and C4 displays actual source symbols/relations. Mermaid solid arrows represent verified **static references**, dashed arrows inferred candidates, and unresolved relationships are separate **gaps** rather than invented arrow targets. A `C2` query can expose explicit `dataFlowBreaks` such as `selected_mock_adapter` or `dynamic_http_request`, and `verifiedRuntimeLinks` remains an empty array absent live proof.

```json
{"action":"architecture","projectId":"vaa-training","level":"C1","format":"mermaid"}
```
```json
{"action":"architecture","projectId":"vaa-training","level":"C2","query":"teaching devices","format":"mermaid"}
```
```json
{"action":"architecture","projectId":"vaa-training","level":"C3","query":"/teaching-devices","limit":1,"maxDepth":8,"maxNodes":65,"format":"mermaid"}
```
```json
{"action":"architecture","projectId":"vaa-training","level":"C4","query":"POST /api/teaching-surveys","languages":["csharp"],"limit":1,"maxDepth":6,"maxNodes":65,"format":"mermaid"}
```

### Optional manually curated C1 context

Only if an operator explicitly creates `%OPENCLAW_STATE_DIR%/codebase-intelligence/contexts/<projectId>.json`, C1 may include additional actors and external systems. This file is **read only** for the tool; P6 never creates or edits it, and no note content is written to Obsidian. Format (placeholder references must be replaced with actual indexed source evidence):

```json
{
  "version": 1,
  "projectId": "vaa-training",
  "actors": [{"id": "training-staff", "label": "Training department staff"}],
  "externalSystems": [
    {"id": "catalog-api", "label": "External catalog candidate",
     "source": {"repoId": "training-csharp", "relativePath": "src/REPLACE_WITH_VERIFIED_SOURCE.cs",
                "line": 42, "identifier": "REPLACE_WITH_EXACT_SOURCE_TOKEN"}}
  ],
  "relationships": []
}
```

External candidates or relationships are **omitted** unless the specified file appears in the index, its current content hash matches the index, and the selected line contains the exact configured source identifier. Actors remain manually curated and unverified. Even a valid identifier is only code-reference evidence: it does **not** establish business identity, live network calls, or a deployed external system. Without a curated context, C1 deliberately displays the registered system scope alone, with missing-evidence explanations.

All graph/projection actions are bounded (max depth 8, nodes 8–120, capped edges) and **read only**; no auto-index, code evaluation, remote requests, git changes or Obsidian writes occur. A stale source file is removed from the active visualization and reported separately. The indexed source snapshot may not represent a currently deployed branch.

---
## Phase 7: Obsidian docs, preview and approved generated-only apply

**Scope must be explicit.** Put `docs-scope.json` in `%OPENCLAW_STATE_DIR%/codebase-intelligence/` (outside Git and vault). The real VAA pilot uses only the two selected folders for reading, and has `generatedRoot: null`, meaning **no auto-generated note can be applied** until a destination is agreed:

```json
{
  "version": 1,
  "projects": {
    "vaa-training": {
      "vaultRoot": "C:/YourVault",
      "readRoots": ["C:/YourVault/OpenClaw - Codebase Intelligence", "C:/YourVault/VAA - University Website Migration"],
      "generatedRoot": null
    }
  }
}
```

The root and each allowed read folder must exist under the configured vault, with no symlinks or junction escape. Dotfolders (`.obsidian`), symlinked files, `Generated/`, non-Markdown files, invalid UTF-8 and oversized files are excluded. Limits: 900 notes, 256 KiB each, 12 MiB total, depth <=12. Notes are parsed as **text**, not executed: a bounded YAML subset (title/tags/status/updated), headings, wikilinks, full relative source paths and SHA256. Paths cited in docs are **claims**, not source graph edges; direct file-path matches are checked against source-index SHA and rehashed from allowed current source before reporting current evidence.

**On-demand read/index/search:**

```json
{"action":"docs","operation":"index","projectId":"vaa-training"}
```
```json
{"action":"docs","operation":"status","projectId":"vaa-training"}
```
```json
{"action":"docs","operation":"search","projectId":"vaa-training","query":"Masterdata","limit":8}
```

`docs/search` returns `noteClaims` independently from `sourceEvidence`. `stale_note_changed_or_missing` suppresses cached excerpts/links; `stale_source_changed_or_missing` indicates a source reference no longer matches the indexed SHA. After source changes, use `index` source incremental and `docs/index`; after note edits, use `docs/index`. No semantic embedding or implicit write occurs.

**Preview (does not write Markdown in the vault):**

```json
{"action":"docs","operation":"preview","projectId":"vaa-training","query":"teachingDevicesService","level":"C4"}
```

The output includes `markdown`, unified `diff`, source hashes, linked note hashes, `generatedTarget`, a 40-hex `previewId` valid for 12 minutes and `writeScopeConfigured`. Pending previews are stored **only in OpenClaw local state**. The preview source graph must be non-truncated and current; it reports evidence separately from inferred/unresolved claims.

**Apply (do not invoke until the user reviews and explicitly approves the exact preview and its target):** Choose a per-project `generatedRoot` ending precisely in `/Generated/Codebase Intelligence` under the vault. For example, after the user chooses `C:/YourVault/Generated/Codebase Intelligence`, edit the scope config, rerun `docs/index` and `docs/preview`, then-with explicit approval-use:

```json
{"action":"docs","operation":"apply","projectId":"vaa-training","previewId":"<40-hex-id-from-current-preview>","approved":true}
```

`approved=true` is a required **approval assertion from the caller**, not cryptographic proof of a human click; the assistant must never set it without actual user approval. The tool denies any path outside the configured Generated directory, handwritten notes, or generated files whose publishing SHA ledger doesn't match the file (e.g. after manual edits). Apply rejects changed source/index revision (`SOURCE_CHANGED`/`INDEX_CHANGED`), changed linked note or destination (`DOC_CHANGED`), missing/expired preview, or changed scope. It serializes its own publishers and checks target hashes just before atomic same-volume replacement; an external editor that doesn't honor the lock can still race within the final filesystem operation, so there is no claim of a universal filesystem transaction. Repeat apply of an unchanged published preview is idempotent (`already_applied`). No manual notes or journals are ever overwritten.

**Real VAA read-only pilot (12 Nov 2026):** 57 Markdown notes indexed from the two scoped folders (11 Codebase Intelligence, 46 University Website Migration), **265 explicit path-reference candidates**; searches about Masterdata, BE QLĐT and Teaching Devices return source-backed freshness when exact paths exist. A C4 draft for `teachingDevicesService` was previewed with 2 referenced source files and 8 linked notes; no generated file was written to the real vault. The source graph index remained SQLite revision 11.

---
## Phase 8 — measured limits, drift checks and rollout

**Git snapshot drift:**

```json
{"action":"status","projectId":"vaa-training","checkWorktree":true}
```

`index.gitSnapshotDrift` compares current Git branch/HEAD against indexed snapshots. The check is optional so routine job polling stays fast. It **does not detect unstaged/dirty file contents**; source retrieval revalidates current file hashes, and `index(mode=incremental)` is required after code or branch changes.

**Search ranking:** exact basename/source-file matches are promoted after SHA256 verification, then TS AST facts, then lexical FTS results. For queries of 3+ tokens that fail full-term matching, OR fallback requires at least two tokens in a returned path/chunk to avoid one-word false positives. Symbol/file matching is not a claim that the module implements the user's business workflow.

**Obsidian business navigation:** `docs/search` adds `noteBackedSourceReferences` with note score, file SHA and citing note paths. Each element is a current **file-path citation in an Obsidian note**; it is not a verified dependency edge, service integration or migration claim. Manual notes remain read-only and `docs/apply` remains opt-in.

**Real VAA benchmark (12 Nov 2026; 2,356 indexed source files, 30,684 chunks):** full reindex measured 216,852 ms; no-change incremental 14,544 ms; measured searches/trace/impact 11–232 ms per call. Local SQLite database file was 162,570,240 bytes (~155 MiB). Parent Node process sampled RSS peak ~341 MiB and heap ~149 MiB. **Child PHP/Roslyn processes, OS page cache and WAL footprint are excluded from this memory/disk figure**. Full reindex was on an existing SQLite store; a separate first-ever cold VAA index was not timed.

**Accuracy method:** 19 manually curated queries with one exact expected source file each (not an exhaustive relevance set) and 2 negative queries. After hardening: exact code symbols 8/8 top-5, exact route/file identifiers 3/3, Vietnamese business phrases 1/8 from source lexical search, negative queries 2/2 empty; total 12/19. On the same 8 business queries, the separate Obsidian note-cited source navigation returns the expected file in the top 5 for 5/8. This is *single-file recall@5* only: files outside the chosen target may be relevant, so the benchmark cannot assign semantic false-positive rates or full precision.

**Security:** tests exercise Git branch/HEAD drift, uncommitted TS alias changes, changed C# routes and PHP migrations, index budgets, rollback on injected failure, corrupt SQLite, symlink escape and sensitive source exclusions. All actions are read-only against VAA repos; changed generated notes fail ownership/hash checks. No live MCP Gateway reload, real Generated note publishing, commit/push or merge was attempted. The source index and Obsidian docs index remain outside the Git repo.

**Rollout gate:** run `npm run check`, `npm run test:unit`, `git diff --check` and (only after an explicitly approved bridge reload) the live MCP smoke test. In-process MCP tools/list/tools/call does not prove that the still-running connector has refreshed schemas. Review Codebase Intelligence mixed read/write annotations and `docs/apply` human approval before activation.

---
Cancel:

```json
{"action":"index","projectId":"vaa-training","mode":"cancel","jobId":"<returned UUID>"}
```

`index` reports `queued` / `running` / `completed` / `failed` / `cancelled`. Search uses the last committed revision even while an update is in progress. The `status` revision contains `repoSnapshots` (branch and HEAD at indexing time); `freshness: not_checked_against_worktree` means that the status response alone does **not** prove source is still unchanged. For search results, selected files are re-hashed before a snippet is shown. Changed or unavailable files receive `stale_or_unavailable` with `snippet: null`; run incremental index to update.

## Index scope and limits

File enumeration uses Git `ls-files --cached --others --exclude-standard -z` so tracked files and untracked, non-ignored files are eligible. Each included file is checked with `lstat`, `realpath` and its canonical repo boundary before reading; symlinks, junction escapes, deleted files and untrusted paths cannot be indexed. Only source/config formats relevant to **PHP, C#, TypeScript/TSX, SQL** are considered; generated and binary files are excluded.

Conservative defaults:

- Max **5,000** source/config files per project, **2 MiB** per file, **128 MiB** source bytes and **45,000** text chunks.
- Max **300 s** inventory time and index processing budget for PHP/C#/TS AST indexing, bounded Git subprocess time/output. Initial AST builds are slower than FTS-only indexing; C# Roslyn uses bounded child processes, TS parsing is bounded per file.
- Exclude `.git`, `node_modules`, `vendor`, `.next`, `bin`, `obj`, `dist`, `build`, `storage`, `coverage`, `output`, temp folders and `.env*`, private keys, certificates and credentials.
- Lines containing likely secrets/auth configuration are **redacted before index creation**; this is a best-effort guard, not a DLP guarantee. Do not treat arbitrary private source as safe to publish.
- Search returns up to **30** distinct files, up to 8 query terms, and snippets capped at **550 characters**. Unicode FTS5 supports Vietnamese diacritics and lexical camelCase/PascalCase token expansion. Multiword queries try all terms first; `any_term_fallback` is explicitly marked as lower precision.
- Source code is **read-only**. No code scripts, Git hooks, npm/composer install, .NET build, network API, DB queries, Obsidian writes, source commits or pushes occur during indexing.
- SQLite journal mode WAL and transactional publish: failed/cancelled updates retain the last completed index. Corrupt SQLite files raise `INDEX_STORAGE_ERROR` and are not silently overwritten/deleted.
- At most one index job per project within an engine process. Job state is in memory (not durable across restart); multi-process concurrent writers are not supported yet.
- `node:sqlite` requires a compatible local Node runtime and may show an ExperimentalWarning on Node 24. The tested setup uses Node 24.14.0.

**Known limitations:** PHP, C# and TS AST graphs are static. Dynamic Laravel/JS routing, runtime DI, environment-specific host/baseURL, service wrappers with dynamically computed URLs and missing full MSBuild/TS semantic references can remain unresolved. HTTP method/path equality is a **contract candidate**, not proof FE called C#; source-based mock export binding is evidence of an active code reference, not deployed traffic. A model containing `credit` and `course_id` does not prove course/cohort credit grain. Invalid syntax is reported instead of fabricated facts. File moves become removal + insertion; every incremental pass hashes files. Ignored directories are excluded. Branch/HEAD is snapshot metadata; current branch is not rechecked on every `status`. Multi-process index arbitration and durable job recovery are later hardening.

## Verification

```powershell
node --test tests\codebase-index.test.mjs tests\codebase-intelligence.test.mjs tests\codebase-php.test.mjs tests\codebase-php-index.test.mjs tests\codebase-csharp.test.mjs tests\codebase-csharp-index.test.mjs tests\codebase-typescript.test.mjs tests\codebase-typescript-index.test.mjs tests\codebase-graph.test.mjs tests\codebase-docs.test.mjs
npm run check
npm run test:unit
git diff --check
```

Coverage includes scope validation, .gitignore, secret exclusions, oversized files, junction/symlink escape, Unicode FTS5, no-hit behavior, stale snippets, add/modify/delete/rename, idempotent incremental index, cancellation, concurrent-job refusal, corrupt store, atomic rollback, real MCP SDK tools/list and tools/call. There are no external network dependencies in the tests.

**Activation:** Newly registered MCP action schemas become visible to the currently running ChatGPT connector **after a managed bridge reload**. In-process MCP SDK tests and local pilot runs do not restart the user's current bridge session.
