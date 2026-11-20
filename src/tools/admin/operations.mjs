// Convert a user-authorized shell command into a bounded Polkit request.
// The root command itself is unrestricted; this module validates only the
// request envelope, not the command's effects.
import { isAbsolute } from "node:path";

const MAX_COMMAND_LENGTH = 4096;
const MAX_PURPOSE_LENGTH = 160;
const DEFAULT_TIMEOUT_SECONDS = 900;
const MAX_TIMEOUT_SECONDS = 3600;

export function makeAdminPlan(input) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new TypeError("Administrative request must be an object.");
  if (Object.keys(input).some((key) => !["command", "purpose", "workdir", "timeoutSeconds"].includes(key)))
    throw new TypeError("Unsupported administrative request field.");

  const { command, purpose, workdir, timeoutSeconds = DEFAULT_TIMEOUT_SECONDS } = input;
  if (typeof command !== "string" || !command.trim() || command.length > MAX_COMMAND_LENGTH
      || /[\u0000]/u.test(command))
    throw new TypeError("Expected a non-empty shell command (max 4096 characters, no NUL).");
  if (typeof purpose !== "string" || !purpose.trim() || purpose.length > MAX_PURPOSE_LENGTH
      || /[\u0000-\u001f\u007f]/u.test(purpose))
    throw new TypeError("Expected a single-line purpose (max 160 characters).");
  if (workdir !== undefined && (typeof workdir !== "string" || !isAbsolute(workdir)
      || !workdir.trim() || workdir.length > 4096 || /[\u0000-\u001f\u007f]/u.test(workdir)))
    throw new TypeError("workdir must be an absolute directory path.");
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > MAX_TIMEOUT_SECONDS)
    throw new TypeError("timeoutSeconds must be an integer from 1 to 3600.");

  return {
    program: "/usr/bin/bash",
    args: ["--noprofile", "--norc", "-c", command],
    display: command,
    purpose: purpose.trim(),
    ...(workdir === undefined ? {} : { workdir }),
    timeoutMs: timeoutSeconds * 1000,
  };
}

export function isJobId(value) {
  return typeof value === "string" && /^[0-9a-f]{32}$/u.test(value);
}
