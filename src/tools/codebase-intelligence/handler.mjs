import path from "node:path";
import { stateDir } from "../../config/runtime.mjs";
import { codebaseIntelligenceToolDefinition } from "./schema.mjs";
import { createProjectRegistry, ProjectRegistryError, validateProjectId } from "./registry.mjs";
import { createIndexEngine } from "./engine.mjs";
import { createDocsAdapter } from "./docs-adapter.mjs";

const name = codebaseIntelligenceToolDefinition.name;
const storageRoot = path.join(stateDir, "codebase-intelligence");

function failure(code, message) {
  return {
    isError: true,
    diagnostics: { stage: "codebase_intelligence", code },
    content: [{ type: "text", text: code + ": " + message }],
    structuredContent: { ok: false, code, message },
  };
}

function success(action, details) {
  return {
    content: [{ type: "text", text: JSON.stringify({ ok: true, action, ...details }) }],
    structuredContent: { ok: true, action, ...details },
  };
}

function checkFields(args, allowed) {
  if (!args || typeof args !== "object" || Array.isArray(args)
      || Object.keys(args).some((key) => !allowed.includes(key))) {
    throw new ProjectRegistryError("INVALID_ARGUMENTS", "Unexpected or invalid arguments for this action.");
  }
}

export function createCodebaseIntelligenceHandler({
  registry = createProjectRegistry({ stateRoot: storageRoot }),
  engine,
  docs,
} = {}) {
  const indexEngine = engine ?? createIndexEngine({ registry });
  const docsAdapter = docs ?? createDocsAdapter({registry,engine:indexEngine});
  return async function handleCodebaseIntelligenceTool(toolName, args = {}) {
    if (toolName !== name) return undefined;

    try {
      if (args?.action === "project") {
        if (args.operation === "list") {
          checkFields(args, ["action", "operation"]);
          return success("project", { operation: "list", projects: await registry.list() });
        }
        if (args.operation === "show") {
          checkFields(args, ["action", "operation", "projectId"]);
          validateProjectId(args.projectId);
          return success("project", { operation: "show", project: await registry.show(args.projectId) });
        }
        if (args.operation === "register") {
          checkFields(args, ["action", "operation", "projectId", "name", "repositories"]);
          const result = await registry.register({
            projectId: args.projectId,
            ...(args.name === undefined ? {} : { name: args.name }),
            repositories: args.repositories,
          });
          return success("project", { operation: "register", ...result });
        }
        return failure("INVALID_OPERATION", "Project action needs operation=register, list or show.");
      }

      if (args?.action === "index") {
        checkFields(args, ["action", "projectId", "mode", "jobId"]);
        validateProjectId(args.projectId);
        if (args.mode !== "cancel" && args.jobId !== undefined) {
          return failure("INVALID_ARGUMENTS", "jobId is only valid with index/cancel.");
        }
        return success("index", await indexEngine.index({
          projectId: args.projectId,
          mode: args.mode ?? "incremental",
          jobId: args.jobId,
        }));
      }

      if (args?.action === "status") {
        checkFields(args, ["action", "projectId", "jobId", "checkWorktree"]);
        validateProjectId(args.projectId);
        return success("status", { status: await indexEngine.status(args.projectId, args.jobId,
          {checkWorktree:args.checkWorktree??false}) });
      }

      if (args?.action === "search") {
        checkFields(args, ["action", "projectId", "query", "limit", "repoIds", "languages"]);
        validateProjectId(args.projectId);
        return success("search", { search: await indexEngine.search({
          projectId: args.projectId,
          query: args.query,
          limit: args.limit ?? 10,
          repoIds: args.repoIds ?? [],
          languages: args.languages ?? [],
        }) });
      }

      if (args?.action === "php") {
        checkFields(args, ["action", "operation", "projectId", "query", "repoIds", "limit", "kinds"]);
        if (args.operation !== "find") return failure("INVALID_OPERATION", "PHP action supports operation=find.");
        return success("php", { result: await indexEngine.phpSearch({
          projectId: args.projectId, query: args.query,
          repoIds: args.repoIds ?? [], limit: args.limit ?? 10,
          kinds: args.kinds ?? [],
        }) });
      }

      if (args?.action === "csharp") {
        checkFields(args, ["action", "operation", "projectId", "query", "repoIds", "limit", "kinds"]);
        if (args.operation !== "find") return failure("INVALID_OPERATION", "C# action supports operation=find.");
        return success("csharp", { result: await indexEngine.csharpSearch({
          projectId: args.projectId, query: args.query,
          repoIds: args.repoIds ?? [], limit: args.limit ?? 10,
          kinds: args.kinds ?? [],
        }) });
      }

      if (args?.action === "typescript") {
        checkFields(args, ["action", "operation", "projectId", "query", "repoIds", "limit", "kinds"]);
        if (args.operation !== "find") return failure("INVALID_OPERATION", "TypeScript action supports operation=find.");
        return success("typescript", { result: await indexEngine.typescriptSearch({
          projectId: args.projectId, query: args.query,
          repoIds: args.repoIds ?? [], limit: args.limit ?? 10,
          kinds: args.kinds ?? [],
        }) });
      }

      if (args?.action === "trace") {
        checkFields(args, ["action", "projectId", "query", "repoIds", "limit", "maxDepth", "language", "direction", "maxNodes", "languages"]);
        return success("trace", { trace: await indexEngine.trace({
          projectId: args.projectId, query: args.query,
          repoIds: args.repoIds ?? [], limit: args.limit ?? 3,
          maxDepth: args.maxDepth ?? (args.language === "typescript" ? 7 : 5),
          language: args.language ?? "php",direction:args.direction ?? "downstream",
          maxNodes:args.maxNodes ?? 75,languages:args.languages ?? [],
        }) });
      }

      if (args?.action === "impact") {
        checkFields(args, ["action", "projectId", "query", "repoIds", "languages", "limit", "maxDepth", "maxNodes", "direction"]);
        return success("impact", { impact: await indexEngine.impact({
          projectId:args.projectId,query:args.query,repoIds:args.repoIds ?? [],
          languages:args.languages ?? [],limit:args.limit ?? 3,
          maxDepth:args.maxDepth ?? 5,maxNodes:args.maxNodes ?? 65,
          direction:args.direction ?? "upstream",
        }) });
      }

      if (args?.action === "architecture") {
        checkFields(args, ["action", "projectId", "query", "level", "repoIds", "languages", "limit", "maxDepth", "maxNodes", "direction", "format"]);
        if (args.format !== undefined && args.format !== "mermaid")
          return failure("INVALID_ARGUMENTS", "Architecture output format must be mermaid.");
        return success("architecture", { architecture: await indexEngine.architecture({
          projectId:args.projectId,level:args.level ?? "C2",query:args.query,
          repoIds:args.repoIds ?? [],languages:args.languages ?? [],limit:args.limit ?? 3,
          maxDepth:args.maxDepth ?? 5,maxNodes:args.maxNodes ?? 65,
          direction:args.direction ?? "downstream",
        }) });
      }

      if (args?.action === "docs") {
        if (args.operation === "index") {
          checkFields(args, ["action", "operation", "projectId"]);
          return success("docs", { operation:"index", result:await docsAdapter.index({projectId:args.projectId}) });
        }
        if (args.operation === "status") {
          checkFields(args, ["action", "operation", "projectId"]);
          return success("docs", { operation:"status", result:await docsAdapter.status({projectId:args.projectId}) });
        }
        if (args.operation === "search") {
          checkFields(args, ["action", "operation", "projectId", "query", "limit"]);
          return success("docs", { operation:"search", result:await docsAdapter.search({
            projectId:args.projectId,query:args.query,limit:args.limit??10,
          }) });
        }
        if (args.operation === "preview") {
          checkFields(args, ["action", "operation", "projectId", "query", "level"]);
          return success("docs", { operation:"preview", result:await docsAdapter.preview({
            projectId:args.projectId,query:args.query,level:args.level??"C4",
          }) });
        }
        if (args.operation === "apply") {
          checkFields(args, ["action", "operation", "projectId", "previewId", "approved"]);
          return success("docs", { operation:"apply", result:await docsAdapter.apply({
            projectId:args.projectId,previewId:args.previewId,approved:args.approved,
          }) });
        }
        return failure("INVALID_OPERATION", "Docs actions: index, status, search, preview or apply.");
      }

      if (args?.action === "compare") {
        checkFields(args, ["action", "projectId", "query", "limit"]);
        return success("compare", { comparison: await indexEngine.compare({
          projectId: args.projectId, query: args.query, limit: args.limit ?? 8,
        }) });
      }

      if (args?.action === "match") {
        checkFields(args, ["action", "projectId", "query", "limit"]);
        return success("match", { result: await indexEngine.matchFrontendBackend({
          projectId: args.projectId, query: args.query, limit: args.limit ?? 10,
        }) });
      }

      return failure("UNKNOWN_ACTION", "Supported actions: project, index, status, search, php, csharp, typescript, trace, impact, architecture, docs, compare, match.");
    } catch (error) {
      if (error instanceof ProjectRegistryError) return failure(error.code, error.message);
      return failure("REGISTRY_IO_ERROR", "Unable to access the local project registry.");
    }
  };
}

export const handleCodebaseIntelligenceTool = createCodebaseIntelligenceHandler();
