/**
 * Conservative Blade route-reference extractor.
 * Blade is not parsed as executable PHP AST. These are only textual named-route
 * references and can remain unresolved at runtime; no source is evaluated.
 */
export function extractBladeRouteFacts(text,relativePath=null) {
  const facts=[];
  const pattern=/\b(?:route|to_route)\s*\(\s*(['"])([a-z][a-z0-9._-]{1,160})\1/giu;
  let match;
  while((match=pattern.exec(text))!==null && facts.length<160) {
    const line=1+(text.slice(0,match.index).match(/\n/gu)?.length??0);
    facts.push({
      kind:"blade_route_reference",name:match[2],parent:relativePath,target:match[2],
      startLine:line,endLine:line,status:"inferred",
      details:{evidence:"blade_named_route_literal",runtimeVerified:false},
    });
  }
  return facts;
}

/**
 * Include file-existence evidence for an indexed Blade template.
 * Rendering from a controller is a convention-based inference, never runtime verified.
 */
export function extractBladeFacts(text, relativePath) {
  const references = extractBladeRouteFacts(text,relativePath);
  if (typeof relativePath !== "string" || !relativePath.startsWith("resources/views/") ||
      !relativePath.endsWith(".blade.php")) return references;
  return [{
    kind: "view_file", name: relativePath, parent: null, target: null,
    startLine: 1, endLine: 1, status: "verified_static",
    details: { evidence: "file_inventory", isBladeTemplate: true },
  }, ...references];
}
