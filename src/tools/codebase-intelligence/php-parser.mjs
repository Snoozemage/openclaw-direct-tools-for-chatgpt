import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ProjectRegistryError } from "./registry.mjs";

const HELPER_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "php-helper");
const HELPER_SCRIPT = path.join(HELPER_DIR, "extract.php");
const AUTOLOAD = path.join(HELPER_DIR, "vendor", "autoload.php");
export const PHP_ADAPTER_VERSION = "php-ast-v4-views-precision:nikic-5.7.0";
const MAX_OUTPUT = 3_500_000;
const MAX_SOURCE = 2_100_000;

export async function assertPhpParserReady() {
  try {
    await Promise.all([access(HELPER_SCRIPT), access(AUTOLOAD)]);
  } catch {
    throw new ProjectRegistryError("PARSER_UNAVAILABLE",
      "Standalone PHP parser is not installed. Run composer install --no-plugins --no-scripts --no-dev in src/tools/codebase-intelligence/php-helper.");
  }
}

/**
 * Local PHP CLI receives source via stdin, parses it and returns bounded AST facts.
 * NEVER invokes project autoloaders or executes analyzed PHP source.
 */
export async function extractPhpFacts({ relativePath, source, signal, timeoutMs = 4500 } = {}) {
  if (typeof source !== "string" || Buffer.byteLength(source, "utf8") > MAX_SOURCE ||
      typeof relativePath !== "string" || relativePath.length > 1024 ||
      relativePath.includes("\0") || relativePath.split(/[\\/]/u).includes("..")) {
    throw new ProjectRegistryError("INVALID_ARGUMENTS", "Invalid PHP parser source or relative path.");
  }
  await assertPhpParserReady();
  if (signal?.aborted) throw new ProjectRegistryError("INDEX_CANCELLED", "PHP parsing cancelled.");

  const payload = JSON.stringify({ version: 1, code: source, relativePath });
  return new Promise((resolve, reject) => {
    const proc = spawn("php", ["-d", "display_errors=0", "-d", "log_errors=0", "-d", "xdebug.mode=off", HELPER_SCRIPT], {
      cwd: HELPER_DIR, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"], signal,
      env: { ...process.env, XDEBUG_MODE: "off" },
    });
    let output = "";
    let outputBytes = 0;
    let stderr = "";
    let finished = false;
    const timeout = setTimeout(() => proc.kill(), timeoutMs);
    proc.stdout.on("data", (buffer) => {
      outputBytes += buffer.length;
      if (outputBytes > MAX_OUTPUT) { proc.kill(); return; }
      output += buffer.toString("utf8");
    });
    proc.stderr.on("data", (buffer) => { stderr += buffer.toString("utf8").slice(0, 240); });
    proc.on("error", (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      reject(new ProjectRegistryError(error?.name === "AbortError" ? "INDEX_CANCELLED" : "PARSER_UNAVAILABLE",
        "PHP AST parser process failed to start or was cancelled."));
    });
    proc.on("close", (exitCode, sig) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      if (signal?.aborted) { reject(new ProjectRegistryError("INDEX_CANCELLED","PHP parsing cancelled.")); return; }
      if (exitCode !== 0 || outputBytes > MAX_OUTPUT || sig) {
        reject(new ProjectRegistryError("PHP_PARSER_FAILED",
          "PHP parser process failed, timed out, or exceeded output budget."));
        return;
      }
      try {
        const parsed = JSON.parse(output);
        if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.facts) && parsed.ok) throw Error("Bad JSON response");
        if (!parsed.ok) {
          // Syntax error in one legacy file should not block unrelated source indexing.
          resolve({ facts: [], parseError: parsed.code || "PHP_PARSE_ERROR" });
          return;
        }
        if (parsed.facts.length > 3500) throw Error("Too many parser facts");
        const facts = parsed.facts.map((fact) => {
          if (!fact || !["route","class","interface","trait","model","model_table","model_field",
            "method","eloquent_relation","table_access","table_operation","view_render","migration_table","migration_column","static_call"].includes(fact.kind) ||
              typeof fact.name !== "string" || !Number.isInteger(fact.startLine) ||
              !Number.isInteger(fact.endLine) || fact.startLine <= 0 || fact.endLine < fact.startLine ||
              !["verified_static","inferred","unresolved"].includes(fact.status)) throw Error("Invalid parser fact");
          return fact;
        });
        resolve({ facts, parseError: null });
      } catch {
        reject(new ProjectRegistryError("PHP_PARSER_FAILED","PHP parser emitted invalid or unbounded AST facts."));
      }
    });
    proc.stdin.on("error", () => {}); // a child process that exits early may close stdin
    proc.stdin.end(payload);
  });
}
