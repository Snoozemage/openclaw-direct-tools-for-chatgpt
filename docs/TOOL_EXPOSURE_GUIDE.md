# Tool Exposure Guide

## Purpose and source of truth

This guide defines how to add, change, validate, and remove public MCP tools in the OpenClaw Direct Tools for ChatGPT bridge. It replaces the former implementation plan, whose initial-state description and next-step roadmap no longer reflected the repository.

The code is the source of truth for the exposed tool surface:

- `src/mcp/tool-definitions.mjs` assembles the public tool schemas.
- `src/mcp/tool-dispatcher.mjs` routes calls to tool handlers.
- `src/tools/<feature>/schema.mjs` owns a feature's public MCP contract where a separate schema module is appropriate.
- `src/tools/<feature>/handler.mjs` owns dispatch and argument preparation for that feature where a separate handler module is appropriate.

Do not maintain a second manually curated list of all public tool names here. Update the README's overview when the user-facing capabilities or requirements materially change.

## Architecture and ownership

The bridge exposes two broad kinds of capabilities:

- **OpenClaw wrappers** forward supported operations to OpenClaw's native runtime. Examples include Browser, Computer, Files, and runtime execution/process tools. The relevant OpenClaw implementation and runtime remain authoritative for native actions, permissions, and validation.
- **Bridge-native tools** implement functionality owned by this repository, such as local project search and screenshot rendering. Their behavior, validation, dependencies, and failure modes must be documented and tested by this project.

Keep each feature's code under `src/tools/<feature>/`. Create only the modules that have a clear responsibility; small features do not need extra abstraction layers. Keep schema definitions and handlers separate when that improves clarity, and follow the structure of the closest existing feature.

## Adding or changing a tool

1. **Inspect the real contract.** For a wrapper, inspect the installed OpenClaw schema and implementation or another authoritative source. Verify supported actions, argument names, permissions, routing, and expected results. Do not infer a native contract from examples alone.
2. **Decide ownership and routing.** Determine whether the operation belongs in OpenClaw or in the bridge. Use the supported native invocation path for wrappers; keep bridge-native behavior local and explicitly bounded. Do not route routine operations through the OpenClaw main agent when a direct native tool is available and appropriate.
3. **Implement the smallest coherent feature.** Add or update the feature's schema and handler modules as needed. Keep public schemas explicit, compact, and aligned with the actual behavior. Avoid duplicating native validation unless the bridge needs its own boundary validation for safety or a different public contract.
4. **Register the tool.** Add its schema to `src/mcp/tool-definitions.mjs` and its handler to `src/mcp/tool-dispatcher.mjs`. Follow the existing import and registry patterns. Ensure the handler leaves unrelated tool names untouched so other handlers can process them.
5. **Define failure behavior.** Preserve native error details for wrapper calls instead of masking failures or manufacturing success. For bridge-owned validation or execution failures, return actionable errors and avoid exposing secrets. Do not claim an operation succeeded without a confirming result.
6. **Add regression coverage.** Test the public MCP schema, required and rejected arguments, dispatch, result formatting, error handling, and relevant boundaries. For wrappers, test argument preparation and preservation of native results. For bridge-native tools, test core behavior, limits, invalid inputs, dependency failures, and no-result cases.
7. **Update the right documentation.** Update the README for meaningful capability, setup, dependency, or user-facing behavior changes. Keep implementation-specific guidance near the relevant feature when it would otherwise make this guide feature-specific.

## Public schema and dispatch rules

- Keep public tool names stable unless a deliberate breaking change is intended.
- Describe accepted syntax and important limitations in schema descriptions, including regex dialects, path interpretation, size/result caps, or runtime requirements where relevant.
- Do not expose parameters the bridge intentionally controls internally. Validate or filter caller arguments at the bridge boundary when required by the public contract.
- Register each schema and handler once. Avoid disconnected legacy handlers or duplicate implementations after replacing behavior.
- Preserve read-only and risk annotations accurately. An annotation must describe the actual side effects, not the preferred or intended use.
- Validate schemas and representative calls through the same MCP surface users invoke, not only through internal helper tests.

## Security and runtime boundaries

- A direct wrapper is not a permission bypass. OpenClaw permissions, node approval, browser attachment, and native runtime rules remain authoritative.
- Treat arguments from MCP callers as untrusted input. Validate boundary inputs before use; restrict paths and actions to the documented contract.
- Avoid constructing shell commands from untrusted arguments. Prefer argument-array process execution with shell invocation disabled when a subprocess is required.
- Keep credentials, generated runtime configuration, tunnel profiles, logs, and process state outside the repository. Never commit secrets or test fixtures that contain real credentials.
- Keep bridge and monitor endpoints local unless network exposure is deliberately designed and secured.
- Bound resource use where the tool can traverse directories, spawn subprocesses, cache data, or return large results. Document meaningful caps and test the cap behavior.

## Validation workflow

Run the relevant targeted tests while developing, then run the repository checks before treating a substantial change as complete:

```powershell
npm run check
npm run test:unit
```

For changes that affect live bridge or Gateway behavior, run the smoke suite only when the configured local runtime is available:

```powershell
npm test -- -BaseUrl http://127.0.0.1:19002
```

Also review the final diff and run `git diff --check`. Confirm the test output reflects the final version of the code, not a version before the last edit. Live smoke results are environment-dependent and should not be inferred from unit tests.

## Codebase Intelligence release review (Phase 8)

`openclaw_codebase_intelligence` is **one** mixed read/write MCP tool, not a collection of new public tool names. Its `project`, `index`, `trace`, `impact`, `architecture`, `docs` and other operations live behind a single strict dispatch/schema. Keep `readOnlyHint=false`: indexing writes to local state, and `docs/apply` can write to a user-selected Generated folder. `docs/preview` never authorizes `docs/apply`; a fresh `previewId`, exact review and explicit approval are required, plus source/revision/note/target hash checks. All source repositories remain read-only.

Before shipping codebase changes, verify scoped source and Obsidian folder paths, parser dependencies (PHP-Parser 5.7.0, pinned Roslyn SDK/.NET and TypeScript 5.8.3), and configured budgets. Benchmark source search with both exact code symbols and Vietnamese business queries: distinguish single-file recall@5 from precision, and keep documentary links clearly separate from static AST or runtime proof. `status(checkWorktree=true)` checks Git branch/HEAD only; dirty uncommitted changes require incremental index. An index built on another branch must not be treated as current without a fresh scan.

Run the in-process MCP tests and syntax suite first. Use live smoke only after the user explicitly authorizes a controlled bridge reload, since a running bridge may expose an older tool schema. Preserve baseline failures from unrelated Browser tests as separately identified issues. The bridge restart, Git commit, push, and merge are separate opt-in operational actions.

## Removal and replacement

When a tool or implementation is replaced, update the public schema registry and dispatcher together. Remove obsolete code and tests that only support the retired contract, while retaining regression tests for behavior that still exists. Search the repository for renamed tool names, module paths, and documentation links before finishing.

## Completion checklist

- [ ] The behavior and native contract have an authoritative basis.
- [ ] The public schema and dispatcher both reflect the intended tool surface.
- [ ] Arguments, permissions, side effects, and error behavior are explicit.
- [ ] Regression tests cover the public contract and important failure cases.
- [ ] `npm run check`, `npm run test:unit`, and `git diff --check` pass as applicable.
- [ ] The README and feature documentation are updated where needed.
- [ ] No obsolete implementation, stale reference, secret, or unrelated change remains.
