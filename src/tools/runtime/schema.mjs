const string = (description) => ({ type: "string", description });
const number = (description) => ({ type: "number", description });
const boolean = (description) => ({ type: "boolean", description });

export const runtimeToolDefinitions = [
  {
    name: "openclaw_exec",
    title: "Run Command",
    description: "Run a shell command through OpenClaw's native exec tool. Use for builds, tests, Git, package managers, and other development commands. Always set background: true when launching a GUI application or any persistent server/watcher so it survives exec completion; leave it off for finite commands. If the result says a process is still running, use openclaw_process with its sessionId. On Windows, invoke executables directly and use backslash paths; do not wrap commands in cmd /c or powershell -Command.",
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    inputSchema: {
      type: "object",
      properties: {
        title: { ...string("Short purpose of this command; do not claim success."), maxLength: 120 },
        command: string("Required shell command to execute."),
        workdir: string("Working directory. Omit or use empty string for the configured default; whitespace-only is invalid."),
        env: { type: "object", patternProperties: { "^.*$": { type: "string" } }, description: "Literal environment variable overrides; values are not expanded." },
        yieldMs: number("Milliseconds before returning a running-command handle; default 10000."),
        awaitResults: boolean("Wait for the terminal result when needed; do not use for detached servers."),
        background: boolean("Start an independent background process that survives the request. Set true when launching a GUI app, persistent server, watcher, or other long-lived process; omit for finite commands."),
        timeoutSeconds: number("Maximum process lifetime in seconds; 0 disables the timeout."),
        pty: boolean("Allocate a pseudo-terminal for commands that genuinely require interactive TTY behavior."),
        elevated: boolean("Request host elevation if allowed by policy."),
        host: { type: "string", enum: ["auto", "gateway", "node"], description: "Execution host. Omit for the configured host; auto uses the configured host." },
        ask: string("Request stricter execution approval under the host policy."),
        node: string("Paired node ID/name; implies host=node and conflicts with other hosts."),
      },
      required: ["command"],
    },
  },
  {
    name: "openclaw_process",
    title: "Manage Command Process",
    description: "Inspect or control an existing process started by openclaw_exec. Use list to discover sessions; poll/log to inspect status and output; write/send-keys/submit/paste to provide input; kill/clear/remove to manage the session. All actions except list require sessionId.",
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "poll", "log", "write", "send-keys", "submit", "paste", "kill", "clear", "remove"], description: "Process action." },
        sessionId: string("Required for every action except list."),
        data: string("Input data for write."),
        keys: { type: "array", items: { type: "string" }, description: "Key tokens for send-keys." },
        hex: { type: "array", items: { type: "string" }, description: "Hex bytes for send-keys." },
        literal: string("Literal key input for send-keys."),
        text: string("Text to paste."),
        bracketed: boolean("Wrap pasted text in bracketed-paste mode."),
        eof: boolean("Close stdin after write."),
        offset: number("Log offset."),
        limit: number("Maximum log length."),
        timeout: { ...number("For poll, wait up to this many milliseconds; values above 30000 are clamped."), minimum: 0 },
      },
      required: ["action"],
    },
  },
];