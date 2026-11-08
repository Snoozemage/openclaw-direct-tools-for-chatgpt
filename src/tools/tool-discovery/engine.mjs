// Native tool names already exposed through bridge-specific wrappers. Keeping
// these out of discovery avoids parallel paths that could bypass wrapper rules.
export const directlyWrappedNativeTools = new Set([
  "apply_patch",
  "browser",
  "computer",
  "edit",
  "exec",
  "ls",
  "process",
  "read",
  "write",
]);

function asText(value) {
  return typeof value === "string" ? value : "";
}

function flattenEffectiveTools(effective) {
  const accessById = new Map(
    (Array.isArray(effective?.toolAccess?.tools) ? effective.toolAccess.tools : [])
      .map((item) => [item.id, item])
      .filter(([id]) => typeof id === "string"),
  );
  const entries = [];
  for (const group of Array.isArray(effective?.groups) ? effective.groups : []) {
    for (const tool of Array.isArray(group?.tools) ? group.tools : []) {
      if (typeof tool?.id !== "string" || !tool.id) continue;
      const access = accessById.get(tool.id);
      entries.push({
        id: tool.id,
        name: tool.id,
        source: tool.source ?? group.source ?? "unknown",
        label: tool.label ?? tool.id,
        description: asText(tool.rawDescription) || asText(tool.fullDescription) || asText(tool.description),
        group: group.label ?? group.id ?? "Other",
        status: access?.status ?? "unknown",
        reasons: Array.isArray(access?.reasons) ? access.reasons : [],
      });
    }
  }
  return entries;
}

function typeLabel(schema) {
  if (Array.isArray(schema?.enum) && schema.enum.length) {
    return schema.enum.map((value) => JSON.stringify(value)).join(" | ");
  }
  if (schema?.type === "array") return (typeLabel(schema.items) || "unknown") + "[]";
  if (schema?.type === "object") return "object";
  if (typeof schema?.type === "string") return schema.type;
  if (Array.isArray(schema?.anyOf)) return schema.anyOf.map(typeLabel).filter(Boolean).join(" | ");
  return "unknown";
}

export function formatInputSignature(schema, maxLength = 1400) {
  const properties = schema?.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return "{}";
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const fields = Object.entries(properties).map(([name, definition]) => {
    return name + (required.has(name) ? "" : "?") + ": " + typeLabel(definition);
  });
  let signature = "{ " + fields.join("; ") + " }";
  if (signature.length > maxLength) signature = signature.slice(0, maxLength - 1) + "…";
  return signature;
}

export function buildAvailableToolCatalog(effective, runtimeTools) {
  const entries = flattenEffectiveTools(effective);
  const counts = new Map();
  for (const entry of entries) counts.set(entry.id, (counts.get(entry.id) ?? 0) + 1);
  const runtimeByName = new Map(
    (Array.isArray(runtimeTools) ? runtimeTools : [])
      .filter((tool) => typeof tool?.name === "string")
      .map((tool) => [tool.name, tool]),
  );

  // Gateway previews never open MCP transports. Admit the explicitly configured
  // CUA tools only after the installed native runtime constructed and policy-
  // filtered them; never turn an unknown server schema into an execution grant.
  for (const tool of runtimeTools ?? []) {
    if (tool.nativePolicyValidated !== true || tool.source !== "mcp"
      || !tool.name?.startsWith("cua-driver__") || counts.has(tool.name)) continue;
    entries.push({
      id: tool.name, name: tool.name, source: "mcp", label: tool.name,
      description: asText(tool.description), group: "Configured CUA MCP",
      status: "available", reasons: [],
    });
    counts.set(tool.name, 1);
  }

  // Only return tools with a native policy-approved status and a real schema
  // constructed by the installed runtime. Never infer schemas from summaries.
  return entries.flatMap((entry) => {
    if (entry.status !== "available" || counts.get(entry.id) !== 1) return [];
    if (directlyWrappedNativeTools.has(entry.id)) return [];
    const runtimeTool = runtimeByName.get(entry.id);
    if (!runtimeTool?.parameters || typeof runtimeTool.parameters !== "object") return [];
    return [{
      ...entry,
      description: asText(runtimeTool.description) || entry.description,
      inputSchema: runtimeTool.parameters,
      ...(runtimeTool.outputSchema ? { outputSchema: runtimeTool.outputSchema } : {}),
    }];
  });
}

function tokenize(value) {
  return (String(value ?? "").toLocaleLowerCase("en").match(/[\p{L}\p{N}_-]+/gu) ?? [])
    .filter((token) => token.length > 1);
}

function searchableText(tool) {
  const trustedSchemaSource = tool.source === "core" || tool.source === "plugin";
  const properties = trustedSchemaSource ? (tool.inputSchema?.properties ?? {}) : {};
  const parameters = Object.entries(properties).flatMap(([name, schema]) => [name, schema?.description ?? ""]);
  return [tool.id, tool.label, tool.group, tool.source, tool.description, ...parameters].join(" ").toLocaleLowerCase("en");
}

function scoreTool(tool, queryTokens, queryText) {
  const name = tool.id.toLocaleLowerCase("en");
  const label = String(tool.label).toLocaleLowerCase("en");
  const description = (tool.description + " " + searchableText(tool)).toLocaleLowerCase("en");
  let score = 0;
  if (name === queryText) score += 100;
  if (label === queryText) score += 80;
  if (name.includes(queryText) && queryText.length > 2) score += 30;
  for (const token of queryTokens) {
    if (name.split(/[_-]+/).includes(token)) score += 12;
    else if (name.includes(token)) score += 7;
    if (label.includes(token)) score += 5;
    if (description.includes(token)) score += 2;
  }
  return score;
}

export function searchToolCatalog(catalog, query, limit = 8, source) {
  const queryText = String(query ?? "").trim().toLocaleLowerCase("en");
  if (!queryText) throw new TypeError("query must be a non-empty string.");
  const queryTokens = tokenize(queryText);
  const maxResults = Number.isInteger(limit) ? Math.max(1, Math.min(limit, 20)) : 8;
  return (Array.isArray(catalog) ? catalog : [])
    .filter((tool) => !source || tool.source === source)
    .map((tool) => ({ tool, score: scoreTool(tool, queryTokens, queryText) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.tool.id.localeCompare(b.tool.id))
    .slice(0, maxResults)
    .map(({ tool }) => ({
      id: tool.id,
      name: tool.id,
      source: tool.source,
      group: tool.group,
      description: tool.description.slice(0, 420),
      descriptionTruncated: tool.description.length > 420,
      input: tool.source === "core" || tool.source === "plugin"
        ? formatInputSignature(tool.inputSchema)
        : "unknown",
    }));
}

export function describeTool(catalog, id) {
  if (typeof id !== "string" || !id.trim()) {
    throw new TypeError("id must be a non-empty tool id returned by openclaw_tool_search.");
  }
  const matches = (Array.isArray(catalog) ? catalog : []).filter((tool) => tool.id === id);
  if (matches.length !== 1) {
    throw new Error("Tool '" + id + "' is not uniquely available through discovery. Search the current tool catalog and use an exact returned id.");
  }
  const tool = matches[0];
  return {
    id: tool.id,
    name: tool.id,
    source: tool.source,
    group: tool.group,
    description: tool.description,
    inputSchema: tool.inputSchema,
    ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
  };
}
