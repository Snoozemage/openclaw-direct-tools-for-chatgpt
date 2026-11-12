import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createProjectRegistry } from "../src/tools/codebase-intelligence/registry.mjs";
import { createIndexEngine } from "../src/tools/codebase-intelligence/engine.mjs";
import { scanProject, sanitizeSource, INDEX_LIMITS } from "../src/tools/codebase-intelligence/scanner.mjs";
import { openExistingIndex, dbPath } from "../src/tools/codebase-intelligence/store.mjs";
import { createCodebaseIntelligenceHandler } from "../src/tools/codebase-intelligence/handler.mjs";

async function fixture(callback) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "codebase-p2-"));
  const source = path.join(dir, "source");
  const other = path.join(dir, "other");
  const stateRoot = path.join(dir, "state");
  await mkdir(source);
  await mkdir(other);
  await mkdir(stateRoot);
  try {
    execFileSync("git", ["init", "-q", source], { windowsHide: true, timeout: 5000 });
    await writeFile(path.join(source, ".gitignore"), "ignored/\n*.bak\n");
    await mkdir(path.join(source, "src"));
    await mkdir(path.join(source, "ignored"));
    await writeFile(path.join(source, "ignored", "ignore.php"), "<?php echo 'secret ignore';");
    await writeFile(path.join(source, ".env"), "PASSWORD=NEVER_INDEX_ME");
    await writeFile(path.join(source, "src", "course.php"), "<?php\n// Quản lý học phần tín chỉ\nfunction courseCredits() { return 3; }\n");
    await writeFile(path.join(source, "src", "secure.php"), "<?php\n$password = 'SUPER_SECRET_VALUE';\nfunction secureCourse() { return true; }\n");
    await writeFile(path.join(source, "src", "huge.php"), "x".repeat(2 * 1024 * 1024 + 1));
    await writeFile(path.join(source, "src", "device.cs"), "namespace Pilot; public class TeachingDevicesController { public void Update() {} }");
    await writeFile(path.join(source, "src", "route.tsx"), "export default function DevicesPage(){ return 'thiết bị'; }");
    await writeFile(path.join(other, "outside.php"), "<?php echo 'SHOULD_NOT_SCAN';");
    try {
      await symlink(path.join(other, "outside.php"), path.join(source, "src", "outside.php"), "file");
    } catch (error) {
      if (!["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) throw error;
    }
    const registry = createProjectRegistry({ stateRoot });
    await registry.register({
      projectId: "vaa-test",
      name: "Fixture",
      repositories: [{ id: "pilot", root: source, languages: ["php", "csharp", "typescript", "sql"] }],
    });
    await callback({ dir, source, other, stateRoot, registry });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function finish(engine, projectId, mode = "incremental") {
  const accepted = await engine.index({ projectId, mode });
  assert.equal(accepted.accepted, true);
  for (let attempt = 0; attempt < 300; attempt++) {
    const result = await engine.status(projectId, accepted.job.jobId);
    if (["completed", "failed", "cancelled"].includes(result.job?.state)) return result;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw Error("Fixture indexing job did not finish.");
}

test("scanner honors .gitignore, excludes sensitive/generated paths and never follows symlinks", async () => fixture(async ({ registry }) => {
  const project = await registry.ensureProjectAllowed("vaa-test");
  const listing = await scanProject(project);
  const paths = listing.files.map((item) => item.relativePath);
  assert.ok(paths.includes("src/course.php"));
  assert.ok(paths.includes("src/device.cs"));
  assert.ok(paths.includes("src/route.tsx"));
  assert.ok(!paths.includes(".env"));
  assert.ok(!paths.includes("ignored/ignore.php"));
  assert.ok(!paths.includes("src/outside.php"));
  assert.ok(!paths.includes("src/huge.php"), "Files larger than 2 MiB must be excluded");
  assert.match(sanitizeSource("password=TOP_SECRET\nregular_code"), /REDACTED.*\nregular_code/u);
}));

test("full index persists FTS5, Unicode search, safe snippets and status after reopen", async () => fixture(async ({ registry, stateRoot }) => {
  const engine = createIndexEngine({ registry });
  const completed = await finish(engine, "vaa-test", "full");
  assert.equal(completed.job.state, "completed", JSON.stringify(completed.job.error));
  assert.equal(completed.index.state, "ready");
  assert.equal(completed.index.revision, 1);
  assert.ok(Array.isArray(completed.index.repoSnapshots));
  assert.equal(completed.index.repoSnapshots[0].repoId, "pilot");
  assert.ok(completed.index.fileCount >= 4);
  const found = await engine.search({ projectId: "vaa-test", query: "học phần" });
  assert.equal(found.indexRevision, 1);
  assert.ok(found.results.some((item) => item.relativePath === "src/course.php"));
  assert.ok(found.results.every((item) => item.freshness === "verified_current_hash"));
  const words = await engine.search({ projectId: "vaa-test", query: "Teaching Devices" });
  assert.ok(words.results.some((item) => item.relativePath === "src/device.cs"));
  const secret = await engine.search({ projectId: "vaa-test", query: "SUPER_SECRET_VALUE" });
  assert.equal(secret.results.length, 0);
  const missing = await engine.search({ projectId: "vaa-test", query: "NEVER_INDEX_ME" });
  assert.equal(missing.results.length, 0);
  const filtered = await engine.search({ projectId: "vaa-test", query: "course", repoIds: ["pilot"], languages: ["php"] });
  assert.ok(filtered.results.length > 0);
  assert.ok(filtered.results.every((item) => item.language === "php"));
  const reopen = createIndexEngine({ registry });
  assert.equal((await reopen.status("vaa-test")).index.fileCount, completed.index.fileCount);
  const db = await openExistingIndex(path.join(stateRoot, "index"), "vaa-test");
  assert.ok(db.prepare("PRAGMA integrity_check").get().integrity_check === "ok");
  db.close();
}));

test("incremental updates only changed files, removes stale and handles rename", async () => fixture(async ({ registry, source }) => {
  const engine = createIndexEngine({ registry });
  const initial = await finish(engine, "vaa-test", "full");
  assert.equal(initial.job.state, "completed");
  const second = await finish(engine, "vaa-test");
  assert.equal(second.job.state, "completed");
  assert.equal(second.index.changed, 0);
  assert.equal(second.index.removed, 0);
  assert.equal(second.index.unchanged, second.index.fileCount);

  const file = path.join(source, "src", "course.php");
  await writeFile(file, "<?php\nfunction creditUpdated(){ return 'new_unique_credit_token'; }\n");
  const stale = await engine.search({ projectId: "vaa-test", query: "tín chỉ" });
  assert.ok(stale.results.some((item) => item.freshness === "stale_or_unavailable"));
  assert.ok(stale.results.every((item) => item.freshness !== "stale_or_unavailable" || item.snippet === null));

  const updated = await finish(engine, "vaa-test");
  assert.equal(updated.job.state, "completed");
  assert.equal(updated.index.changed, 1);
  assert.equal(updated.index.unchanged, updated.index.fileCount - 1);
  const newer = await engine.search({ projectId: "vaa-test", query: "new_unique_credit_token" });
  assert.ok(newer.results.some((item) => item.relativePath === "src/course.php"));
  const old = await engine.search({ projectId: "vaa-test", query: "tín chỉ" });
  assert.equal(old.results.length, 0);

  await rename(path.join(source, "src", "course.php"), path.join(source, "src", "course-renamed.php"));
  const renamed = await finish(engine, "vaa-test");
  assert.equal(renamed.job.state, "completed");
  assert.equal(renamed.index.changed, 1);
  assert.equal(renamed.index.removed, 1);
  const search = await engine.search({ projectId: "vaa-test", query: "new_unique_credit_token" });
  assert.ok(search.results.some((item) => item.relativePath === "src/course-renamed.php"));
  assert.ok(!search.results.some((item) => item.relativePath === "src/course.php"));
}));

test("atomic rollback retains previous revision on forced error", async () => fixture(async ({ registry, source }) => {
  const good = createIndexEngine({ registry });
  const first = await finish(good, "vaa-test", "full");
  assert.equal(first.job.state, "completed");
  await writeFile(path.join(source, "src", "course.php"), "<?php\nfunction creditUpdated(){ return 'future_data'; }\n");
  const broken = createIndexEngine({
    registry,
    beforeCommit() { throw new Error("synthetic failure"); },
  });
  const failed = await finish(broken, "vaa-test");
  assert.equal(failed.job.state, "failed");
  assert.equal(failed.index.revision, first.index.revision);
  const original = await good.search({ projectId: "vaa-test", query: "tín chỉ" });
  assert.ok(original.results.some((item) => item.freshness === "stale_or_unavailable"));
  const unreleased = await good.search({ projectId: "vaa-test", query: "future_data" });
  assert.equal(unreleased.results.length, 0);
}));

test("search and indexing enforce registered project roots, caps and reject unknown input", async () => fixture(async ({ registry, source }) => {
  const engine = createIndexEngine({ registry, limits: { ...INDEX_LIMITS, maxFiles: 2 } });
  const failed = await finish(engine, "vaa-test", "full");
  assert.equal(failed.job.state, "failed");
  assert.equal(failed.job.error.code, "INDEX_LIMIT_EXCEEDED");
  assert.equal(failed.index.state, "not_indexed");
  await assert.rejects(() => engine.search({ projectId: "vaa-test", query: "course" }), (e) => e.code === "INDEX_MISSING");
  await assert.rejects(() => engine.search({ projectId: "vaa-test", query: "" }), (e) => e.code === "INVALID_ARGUMENTS");
  await assert.rejects(() => engine.search({ projectId: "vaa-test", query: "course", repoIds: ["not-allowed"] }), (e) => e.code === "INVALID_ARGUMENTS");
  await rm(path.join(source, ".git"), { recursive: true, force: true });
  await assert.rejects(() => engine.search({ projectId: "vaa-test", query: "course" }), (e) => e.code === "PATH_UNAVAILABLE");
  await assert.rejects(() => engine.index({ projectId: "vaa-test" }), (e) => e.code === "PATH_UNAVAILABLE");
}));

test("job cancellation retains index revision and concurrent jobs do not overlap", async () => fixture(async ({ registry, source }) => {
  const engine = createIndexEngine({ registry });
  const first = await finish(engine, "vaa-test", "full");
  assert.equal(first.job.state, "completed");
  await writeFile(path.join(source, "src", "course.php"), "<?php\nfunction course() { return 7; }\n");
  const started = await engine.index({ projectId: "vaa-test", mode: "incremental" });
  assert.equal(started.accepted, true);
  const duplicate = await engine.index({ projectId: "vaa-test", mode: "incremental" });
  assert.equal(duplicate.accepted, false);
  assert.equal(duplicate.job.jobId, started.job.jobId);
  const cancelling = await engine.index({ projectId: "vaa-test", mode: "cancel", jobId: started.job.jobId });
  assert.equal(cancelling.accepted, true);
  for (let i = 0; i < 200; i++) {
    const status = await engine.status("vaa-test", started.job.jobId);
    if (status.job?.state === "cancelled") {
      assert.equal(status.index.revision, first.index.revision);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw Error("Cancellation did not complete.");
}));

test("corrupt index is reported without silently overwriting it", async () => fixture(async ({ registry, stateRoot }) => {
  const indexRoot = path.join(stateRoot, "index");
  await mkdir(indexRoot);
  const filename = dbPath(indexRoot, "vaa-test");
  await writeFile(filename, "not a sqlite database");
  const engine = createIndexEngine({ registry });
  await assert.rejects(() => engine.status("vaa-test"), (e) => e.code === "INDEX_STORAGE_ERROR");
  assert.equal((await readFile(filename, "utf8")), "not a sqlite database");
}));

test("handler exposes MCP actions and validates operation-specific filters", async () => fixture(async ({ registry }) => {
  const engine = createIndexEngine({ registry });
  const handler = createCodebaseIntelligenceHandler({ registry, engine });
  const bad = await handler("openclaw_codebase_intelligence", {
    action: "search", projectId: "vaa-test", query: "query", limit: 1000,
  });
  assert.equal(bad.structuredContent.code, "INVALID_ARGUMENTS");
  const accepted = await handler("openclaw_codebase_intelligence", {
    action: "index", projectId: "vaa-test", mode: "full",
  });
  assert.equal(accepted.structuredContent.accepted, true);
  for (let attempt = 0; attempt < 200; attempt++) {
    const status = await handler("openclaw_codebase_intelligence", {
      action: "status", projectId: "vaa-test", jobId: accepted.structuredContent.job.jobId,
    });
    if (status.structuredContent.status.job.state === "completed") break;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  const result = await handler("openclaw_codebase_intelligence", {
    action: "search", projectId: "vaa-test", query: "học phần",
  });
  assert.equal(result.structuredContent.search.mode, "lexical_fts5");
  assert.ok(result.structuredContent.search.results.length);
}));
