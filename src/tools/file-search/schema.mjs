const text = (description) => ({ type: "string", description });

const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
};

export const fileSearchToolDefinitions = [
  {
    name: "openclaw_glob",
    title: "Find Files",
    description: "Find files using Node.js's built-in fs/promises.glob API, without a shell. Examples: **/*.ts, src/**/*.tsx, or *.{js,mjs}. Patterns are relative to the search root. The path defaults to the OpenClaw workspace. Returns up to 100 absolute file paths, newest modified first. .git and node_modules directories are excluded; symlinks are not returned or followed.",
    annotations: readOnlyAnnotations,
    inputSchema: {
      type: "object",
      properties: {
        pattern: text("Required pattern in Node.js fs/promises.glob syntax, relative to the search root. Use / separators. Absolute patterns and patterns containing '..' are rejected."),
        path: text("Optional directory to search, absolute or relative to the OpenClaw workspace. Defaults to the workspace root."),
      },
      required: ["pattern"],
      additionalProperties: false,
    },
  },
  {
    name: "openclaw_grep",
    title: "Search File Contents",
    description: "Search file contents by invoking ripgrep (rg) directly without a shell. Returns up to 100 matching lines with absolute file paths and line numbers. The path defaults to the OpenClaw workspace and may be a file or directory. Use include to limit files, for example *.ts or *.{ts,tsx}. Respects ripgrep's standard ignore rules such as .gitignore, skips hidden and binary files by default, excludes .git and node_modules explicitly, and skips files larger than 2 MiB. Matching is case-sensitive and line-based.",
    annotations: readOnlyAnnotations,
    inputSchema: {
      type: "object",
      properties: {
        pattern: text("Required ripgrep regular expression (Rust regex syntax) to match within each line. Matching is case-sensitive; look-around and backreferences are not supported by the default regex engine."),
        path: text("Optional file or directory to search, absolute or relative to the OpenClaw workspace. Defaults to the workspace root."),
        include: text("Optional ripgrep glob filter for files, such as *.ts, *.{ts,tsx}, or src/**/*.mjs. Patterns without / match filenames at any depth. Standard ignore rules still apply."),
      },
      required: ["pattern"],
      additionalProperties: false,
    },
  },
];
