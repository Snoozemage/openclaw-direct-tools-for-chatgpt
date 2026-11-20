const string = (description, extra = {}) => ({ type: "string", description, ...extra });

export const adminToolDefinition = {
  name: "openclaw_admin",
  title: "Run Linux Admin Command",
  description: "Run a user-authorized non-interactive shell command as root on Linux via KDE Polkit, instead of sudo in openclaw_exec. Provide the exact command (without sudo) and a truthful purpose shown in a KDE notification before execution. Polkit requests authentication when needed. Use action=run, then action=status with the returned jobId.",
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["run", "status"], description: "Run a root command or check a job." },
      command: string("Shell command to execute as root, without a sudo prefix. Bash syntax supported (pipes, redirects, scripts); no interactive stdin. Required for run.", { maxLength: 4096 }),
      purpose: string("Short, accurate reason for elevation, shown on the KDE desktop. Required for run.", { maxLength: 160 }),
      workdir: string("Optional absolute working directory for the root command."),
      timeoutSeconds: { type: "integer", minimum: 1, maximum: 3600, description: "Command timeout in seconds (default 900)." },
      jobId: string("Job ID from run. Required for status."),
    },
    required: ["action"],
    additionalProperties: false,
  },
};
