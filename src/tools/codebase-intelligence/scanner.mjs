import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { ProjectRegistryError } from "./registry.mjs";

export const INDEX_LIMITS = Object.freeze({
  maxFiles: 5000,
  maxFileBytes: 2 * 1024 * 1024,
  maxSourceBytes: 128 * 1024 * 1024,
  maxChunks: 45000,
  maxChunkChars: 1600,
  maxJobMs: 300_000, // PHP AST first pass adds bounded subprocess parsing on top of file hashing.
});
const DISALLOWED_DIRS = new Set([
  ".git", ".next", ".nuxt", ".turbo", "node_modules", "vendor", "obj",
  "bin", "dist", "build", "coverage", "storage", "output", "tmp",
  "temp", ".cache", ".idea", ".vs", "packages",
]);
const ALLOWED_CONFIG = new Set(["composer.json", "package.json", "tsconfig.json", "tsconfig.base.json"]);
const SENSITIVE_BASENAME = /(?:^\.env(?:\.|$)|\.env(?:\.|$)|(?:^|[-_.])(?:secret|secrets|credential|credentials|private[-_.]?key)(?:[-_.]|$)|^id_(?:rsa|ed25519|ecdsa)|(?:\.pem|\.key|\.pfx|\.p12|\.jks|\.keystore)$)/iu;
// Fail closed: redact entire matching lines before they enter SQLite or MCP results.
const SECRET_LINE = /(?:password|passwd|api[_-]?key|secret|access[_-]?token|refresh[_-]?token|bearer\s|authorization|private\s+key|client[_-]?secret|connectionstring|connection_string)/iu;

function fail(code, message) {
  throw new ProjectRegistryError(code, message);
}

function insideRoot(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!path.isAbsolute(relative)
    && relative !== ".." && !relative.startsWith(".." + path.sep));
}

function sourceLanguage(fileName, languages) {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".blade.php") && languages.includes("php")) return "php";
  const ext = path.extname(lower);
  if (ext === ".php" && languages.includes("php")) return "php";
  if (ext === ".cs" && languages.includes("csharp")) return "csharp";
  if ((ext === ".ts" || ext === ".tsx") && languages.includes("typescript")) return "typescript";
  if (ext === ".sql" && languages.includes("sql")) return "sql";
  if ((ext === ".csproj" || ext === ".sln") && languages.includes("csharp")) return "config";
  if (ALLOWED_CONFIG.has(path.basename(lower))) return "config";
  return null;
}

function excluded(relativePath, language) {
  const parts = relativePath.replace(/\\/gu, "/").split("/");
  const name = parts.at(-1);
  if (parts.some((part) => DISALLOWED_DIRS.has(part.toLowerCase()))) return true;
  if (parts.some((part) => SENSITIVE_BASENAME.test(part))) return true;
  if (/\.(?:min|bundle|generated|g|d)\.ts$/iu.test(name)) return true;
  if (name.toLowerCase().endsWith(".lock") || /(?:\.min\.|\.map$)/iu.test(name)) return true;
  if (name === ".gitmodules" || name === ".gitattributes" || name === ".gitignore") return true;
  return !language;
}

export function sanitizeSource(text) {
  return text.split(/\r?\n/u).map((line) => SECRET_LINE.test(line)
    ? "[REDACTED: possible credential or authentication configuration]"
    : line.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/gu, " ")).join("\n");
}

function git(root, args, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-c", "core.fsmonitor=false", ...args], {
      cwd: root, shell: false, windowsHide: true,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
      signal,
    });
    const buffers = [];
    let bytes = 0;
    let errorOutput = "";
    const timer = setTimeout(() => child.kill(), 15_000);
    child.stdout.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > 8 * 1024 * 1024) child.kill();
      else buffers.push(chunk);
    });
    child.stderr.on("data", (chunk) => { errorOutput += chunk.toString("utf8").slice(0, 300); });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 || bytes > 8 * 1024 * 1024) {
        reject(new ProjectRegistryError("GIT_INVENTORY_FAILED", "Git inventory failed (code " + code + ")."));
      } else resolve(Buffer.concat(buffers));
    });
  });
}

async function listTrackedAndUntracked(root, signal) {
  const result = await git(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], signal);
  return [...new Set(result.toString("utf8").split("\0").filter(Boolean))].sort();
}

export async function snapshotRepositories(project, signal) {
  const snapshots = [];
  for (const repo of project.repositories) {
    const root = await realpath(repo.root);
    let branch = null, head = null;
    try { branch = (await git(root, ["symbolic-ref", "--short", "HEAD"], signal)).toString("utf8").trim(); } catch {}
    try { head = (await git(root, ["rev-parse", "HEAD"], signal)).toString("utf8").trim(); } catch {}
    snapshots.push({ repoId: repo.id, branch, head });
  }
  return snapshots;
}

export async function scanProject(project, { signal, onProgress = () => {}, limits = INDEX_LIMITS } = {}) {
  const files = [];
  const visited = new Set();
  let skipped = 0;
  let bytes = 0;
  let examined = 0;
  const startedAt = Date.now();
  const repoSnapshots = await snapshotRepositories(project, signal);

  for (const repo of project.repositories) {
    if (signal?.aborted) fail("INDEX_CANCELLED", "Indexing was cancelled.");
    const root = await realpath(repo.root);
    const entries = await listTrackedAndUntracked(root, signal);
    for (const relativePath of entries) {
      if (signal?.aborted) fail("INDEX_CANCELLED", "Indexing was cancelled.");
      if (Date.now() - startedAt > limits.maxJobMs) fail("INDEX_TIMEOUT", "The inventory exceeded the time budget.");
      examined++;
      if (!relativePath || path.isAbsolute(relativePath) ||
        relativePath.split(/[\\/]/u).includes("..")) {
        skipped++;
        continue;
      }
      const language = sourceLanguage(relativePath, repo.languages);
      if (excluded(relativePath, language)) { skipped++; continue; }
      const absolute = path.resolve(root, relativePath);
      if (!insideRoot(root, absolute)) { skipped++; continue; }
      const key = repo.id + "\0" + relativePath;
      if (visited.has(key)) continue;
      visited.add(key);
      let details, resolved;
      try {
        details = await lstat(absolute);
        if (!details.isFile() || details.isSymbolicLink() || details.size > limits.maxFileBytes) {
          skipped++;
          continue;
        }
        resolved = await realpath(absolute);
        if (!insideRoot(root, resolved)) { skipped++; continue; }
        const actual = await stat(resolved);
        if (!actual.isFile() || actual.size !== details.size) { skipped++; continue; }
      } catch (error) {
        if (error?.code === "ENOENT" || error?.code === "EACCES" || error?.code === "EPERM") {
          skipped++;
          continue;
        }
        throw error;
      }
      if (files.length >= limits.maxFiles || bytes + details.size > limits.maxSourceBytes) {
        fail("INDEX_LIMIT_EXCEEDED", "Index file-count or source-byte limit was exceeded.");
      }
      bytes += details.size;
      files.push({
        repoId: repo.id, root, relativePath: relativePath.replace(/\\/gu, "/"),
        absolutePath: resolved, language, size: details.size,
      });
      if (examined % 200 === 0) {
        onProgress({ phase: "inventory", examined, accepted: files.length, skipped });
        await new Promise((resolve) => setImmediate(resolve));
      }
    }
  }
  onProgress({ phase: "inventory", examined, accepted: files.length, skipped });
  return { files, examined, skipped, bytes, repoSnapshots };
}

export async function readSafeFile(file, { signal, maxFileBytes = INDEX_LIMITS.maxFileBytes, includeRaw = false } = {}) {
  if (signal?.aborted) fail("INDEX_CANCELLED", "Indexing was cancelled.");
  // Both the path and final target must remain within the repo on every read.
  const realRoot = await realpath(file.root);
  const realFile = await realpath(path.resolve(realRoot, file.relativePath));
  if (!insideRoot(realRoot, realFile) || realFile !== file.absolutePath) {
    fail("REPO_NOT_ALLOWED", "A file target changed or escaped the repository root.");
  }
  const info = await lstat(path.resolve(realRoot, file.relativePath));
  if (!info.isFile() || info.isSymbolicLink() || info.size > maxFileBytes) {
    fail("INDEX_FILE_CHANGED", "A scanned file is no longer an eligible regular source file.");
  }
  const contents = await readFile(realFile, { signal });
  if (contents.length > maxFileBytes || contents.includes(0)) return null;
  const decoded = contents.toString("utf8");
  if (decoded.includes("\uFFFD")) return null;
  const safe = sanitizeSource(decoded);
  return {
    hash: createHash("sha256").update(contents).digest("hex"),
    size: contents.length,
    text: safe,
    // Never persist or return this field through MCP; it exists only for local static parsing.
    ...(includeRaw ? { rawText: decoded } : {}),
  };
}

export function makeChunks(text, maxChars = INDEX_LIMITS.maxChunkChars) {
  const lines = text.split("\n");
  const chunks = [];
  let current = [];
  let currentSize = 0;
  let startLine = 1;
  const emit = (endLine) => {
    if (!current.length) return;
    chunks.push({ startLine, endLine, body: current.join("\n") });
    current = [];
    currentSize = 0;
  };
  for (let i = 0; i < lines.length; i++) {
    // One massive line is indexed as a bounded prefix; no unbounded FTS content.
    const line = lines[i].slice(0, maxChars);
    if (current.length && currentSize + line.length + 1 > maxChars) {
      emit(i);
      startLine = i + 1;
    }
    if (!current.length) startLine = i + 1;
    current.push(line);
    currentSize += line.length + 1;
  }
  emit(lines.length);
  return chunks.filter((item) => item.body.trim().length > 0);
}
