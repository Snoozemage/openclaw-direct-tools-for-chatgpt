import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const PROJECT_ID = /^[a-z][a-z0-9-]{1,63}$/u;
const LANGUAGES = new Set(["php", "csharp", "typescript", "sql"]);
const MAX_PROJECTS = 20;
const MAX_REPOSITORIES = 12;
const MAX_CONFIG_BYTES = 128 * 1024;
const MAX_PROJECT_NAME = 120;
const MAX_ROOT_LENGTH = 1024;

export class ProjectRegistryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ProjectRegistryError";
    this.code = code;
  }
}

function reject(code, message) {
  throw new ProjectRegistryError(code, message);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object"
    && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function requireShape(value, keys, field) {
  if (!isPlainObject(value)) reject("INVALID_ARGUMENTS", field + " must be an object.");
  if (Object.keys(value).some((key) => !keys.includes(key))) {
    reject("INVALID_ARGUMENTS", field + " has unsupported fields.");
  }
}

export function validateProjectId(value, field = "projectId") {
  if (typeof value !== "string" || !PROJECT_ID.test(value)) {
    reject("INVALID_ARGUMENTS", field + " must match /^[a-z][a-z0-9-]{1,63}$/.");
  }
  return value;
}

function validateRepository(value) {
  requireShape(value, ["id", "root", "languages"], "repository");
  validateProjectId(value.id, "repository.id");
  if (typeof value.root !== "string" || !path.isAbsolute(value.root)
      || value.root.length > MAX_ROOT_LENGTH || value.root.includes("\0")) {
    reject("INVALID_ARGUMENTS", "repository.root must be an absolute local path up to 1024 characters.");
  }
  if (!Array.isArray(value.languages) || value.languages.length < 1 || value.languages.length > 4
      || value.languages.some((name) => !LANGUAGES.has(name))
      || new Set(value.languages).size !== value.languages.length) {
    reject("INVALID_ARGUMENTS", "repository.languages must be distinct supported language IDs.");
  }
  if (value.languages.every((name) => name === "sql")) {
    reject("INVALID_ARGUMENTS", "A repository requires php, csharp, or typescript; sql alone is not a pilot adapter.");
  }
  return value;
}

export function validateProjectRegistration(input) {
  requireShape(input, ["projectId", "name", "repositories"], "project");
  validateProjectId(input.projectId);
  if (input.name !== undefined
      && (typeof input.name !== "string" || input.name.trim().length < 1 || input.name.length > MAX_PROJECT_NAME)) {
    reject("INVALID_ARGUMENTS", "name must be a non-empty string up to 120 characters.");
  }
  if (!Array.isArray(input.repositories) || input.repositories.length < 1 || input.repositories.length > MAX_REPOSITORIES) {
    reject("INVALID_ARGUMENTS", "repositories must contain 1–12 entries.");
  }
  const ids = new Set();
  for (const repo of input.repositories) {
    validateRepository(repo);
    if (ids.has(repo.id)) reject("INVALID_ARGUMENTS", "Repository IDs must be unique within a project.");
    ids.add(repo.id);
  }
}

async function readJsonLimited(filePath, { absent = false } = {}) {
  let info;
  try {
    info = await stat(filePath);
  } catch (error) {
    if (error?.code === "ENOENT" && absent) return null;
    if (error?.code === "ENOENT") reject("SCOPE_NOT_CONFIGURED", "Scope allowlist file is missing: " + filePath);
    throw error;
  }
  if (!info.isFile() || info.size > MAX_CONFIG_BYTES) {
    reject("INVALID_CONFIG", "Local project configuration must be a regular JSON file under 128 KiB.");
  }
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8"));
    if (!isPlainObject(parsed)) reject("INVALID_CONFIG", "Configuration must be a JSON object.");
    return parsed;
  } catch (error) {
    if (error instanceof ProjectRegistryError) throw error;
    reject("INVALID_CONFIG", "Local project configuration is not valid JSON.");
  }
}

function pathKey(value) {
  // Windows file paths are case-insensitive; realpath resolves junctions and symlinks.
  return process.platform === "win32" ? value.toLowerCase() : value;
}

async function canonicalDirectory(value) {
  try {
    const resolved = await realpath(value);
    const info = await stat(resolved);
    if (!info.isDirectory()) reject("PATH_UNAVAILABLE", "Repository root must resolve to a directory.");
    return resolved;
  } catch (error) {
    if (error instanceof ProjectRegistryError) throw error;
    reject("PATH_UNAVAILABLE", "Repository root is missing or inaccessible.");
  }
}

export function createProjectRegistry({ stateRoot, scopePath } = {}) {
  if (typeof stateRoot !== "string" || !path.isAbsolute(stateRoot)
      || typeof scopePath !== "string" || !path.isAbsolute(scopePath)) {
    throw new TypeError("stateRoot and scopePath must be absolute local paths.");
  }

  const registryPath = path.join(stateRoot, "projects.json");
  let transaction = Promise.resolve();
  function serialize(task) {
    const next = transaction.then(task);
    transaction = next.catch(() => {});
    return next;
  }

  async function getAllowlist() {
    const config = await readJsonLimited(scopePath);
    if (config.version !== 1 || !Array.isArray(config.allowedRoots)
        || config.allowedRoots.length === 0 || config.allowedRoots.length > 30
        || config.allowedRoots.some((root) => typeof root !== "string"
          || !path.isAbsolute(root) || root.length > MAX_ROOT_LENGTH)) {
      reject("INVALID_CONFIG", "scope.json requires version=1 and 1–30 absolute allowedRoots.");
    }

    const roots = new Set();
    for (const root of config.allowedRoots) {
      roots.add(pathKey(await canonicalDirectory(root)));
    }
    return roots;
  }

  async function ensureAllowedRepository(root, allowed) {
    const actualRoot = await canonicalDirectory(root);
    if (!allowed.has(pathKey(actualRoot))) {
      reject("REPO_NOT_ALLOWED", "Repository root is not in the explicit local scope allowlist.");
    }
    const gitMarker = path.join(actualRoot, ".git");
    try {
      const gitInfo = await lstat(gitMarker);
      if (gitInfo.isSymbolicLink() || !(gitInfo.isDirectory() || gitInfo.isFile())) {
        reject("PATH_UNAVAILABLE", "Repository .git metadata is not a regular file or directory.");
      }
    } catch (error) {
      if (error instanceof ProjectRegistryError) throw error;
      reject("PATH_UNAVAILABLE", "Expected a Git repository root with .git metadata.");
    }
    return actualRoot;
  }

  async function readRegistry() {
    const value = await readJsonLimited(registryPath, { absent: true });
    if (value === null) return { version: 1, projects: [] };
    if (value.version !== 1 || !Array.isArray(value.projects) || value.projects.length > MAX_PROJECTS) {
      reject("INVALID_CONFIG", "Project registry has an unsupported version or size.");
    }
    return value;
  }

  async function saveRegistry(value) {
    await mkdir(stateRoot, { recursive: true });
    const temporaryPath = path.join(stateRoot, ".projects-" + randomUUID() + ".tmp");
    try {
      await writeFile(temporaryPath, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      await rename(temporaryPath, registryPath);
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => {});
    }
  }

  function presentProject(project) {
    return {
      projectId: project.projectId,
      name: project.name,
      repositories: project.repositories.map((repo) => ({
        id: repo.id,
        root: repo.root,
        languages: [...repo.languages],
      })),
      createdAt: project.createdAt,
    };
  }

  async function register(input) {
    validateProjectRegistration(input);
    return serialize(async () => {
      const allowed = await getAllowlist();
      const canonicalRepos = [];
      for (const repo of input.repositories) {
        canonicalRepos.push({
          id: repo.id,
          root: await ensureAllowedRepository(repo.root, allowed),
          languages: [...repo.languages],
        });
      }
      if (new Set(canonicalRepos.map((repo) => pathKey(repo.root))).size !== canonicalRepos.length) {
        reject("INVALID_ARGUMENTS", "Duplicate repository roots are not permitted.");
      }
      const registry = await readRegistry();
      const existing = registry.projects.find((project) => project.projectId === input.projectId);
      const name = input.name?.trim() || input.projectId;
      if (existing) {
        const same = existing.name === name && JSON.stringify(existing.repositories) === JSON.stringify(canonicalRepos);
        if (!same) reject("PROJECT_EXISTS", "Project ID already belongs to a different registration.");
        return { project: presentProject(existing), created: false };
      }
      if (registry.projects.length >= MAX_PROJECTS) reject("PROJECT_LIMIT", "Maximum number of projects reached.");
      const project = {
        projectId: input.projectId,
        name,
        repositories: canonicalRepos,
        createdAt: new Date().toISOString(),
      };
      registry.projects.push(project);
      await saveRegistry(registry);
      return { project: presentProject(project), created: true };
    });
  }

  async function list() {
    const registry = await readRegistry();
    return registry.projects.map((project) => ({
      projectId: project.projectId,
      name: project.name,
      repositoryCount: project.repositories.length,
      createdAt: project.createdAt,
    }));
  }

  async function show(projectId) {
    validateProjectId(projectId);
    const registry = await readRegistry();
    const project = registry.projects.find((item) => item.projectId === projectId);
    if (!project) reject("PROJECT_NOT_FOUND", "No registered project exists with this ID.");
    return presentProject(project);
  }

  async function ensureProjectAllowed(projectId) {
    const project = await show(projectId);
    const allowed = await getAllowlist();
    const repositories = [];
    for (const repo of project.repositories) {
      repositories.push({ ...repo, root: await ensureAllowedRepository(repo.root, allowed) });
    }
    return { ...project, repositories };
  }

  async function status(projectId) {
    const project = await show(projectId);
    const allowed = await getAllowlist();
    const unavailable = [];
    for (const repo of project.repositories) {
      try {
        await ensureAllowedRepository(repo.root, allowed);
      } catch {
        unavailable.push(repo.id);
      }
    }
    return {
      projectId,
      repositoryCount: project.repositories.length,
      repositoriesUnavailable: unavailable,
      index: {
        state: "not_indexed",
        revision: null,
        fileCount: 0,
        message: "Phase 1 only registers projects. Indexing starts in Phase 2.",
      },
    };
  }

  return { register, list, show, status, ensureProjectAllowed, stateRoot, scopePath, registryPath };
}
