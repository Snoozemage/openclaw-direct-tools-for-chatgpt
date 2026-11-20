import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { makeAdminPlan, isJobId } from "../src/tools/admin/operations.mjs";
import { adminToolDefinition } from "../src/tools/admin/schema.mjs";

test("admin tool accepts a general command and purpose", () => {
  assert.equal(adminToolDefinition.name, "openclaw_admin");
  assert.deepEqual(adminToolDefinition.inputSchema.properties.action.enum, ["run", "status"]);
  assert.ok(adminToolDefinition.inputSchema.properties.command);
  assert.ok(adminToolDefinition.inputSchema.properties.purpose);
  assert.equal(adminToolDefinition.annotations.destructiveHint, true);
  assert.match(adminToolDefinition.description, /instead of sudo in openclaw_exec/u);
});

test("any user-approved shell command can run as root, including local RPM installs", () => {
  const command = "dnf install -y /home/snoozemage/Downloads/dbeaver-ce-latest-linux-x86_64.rpm";
  const plan = makeAdminPlan({ command, purpose: "Cài DBeaver Community" });
  assert.equal(plan.program, "/usr/bin/bash");
  assert.deepEqual(plan.args, ["--noprofile", "--norc", "-c", command]);
  assert.equal(plan.display, command);
  assert.equal(plan.purpose, "Cài DBeaver Community");
  assert.equal(plan.timeoutMs, 900000);

  const script = "printf 'hello' | tee /tmp/example\n/usr/bin/id -u";
  assert.equal(makeAdminPlan({ command: script, purpose: "Kiểm thử" }).display, script);
  assert.equal(makeAdminPlan({
    command: "systemctl restart example.service",
    purpose: "Khởi động lại dịch vụ",
    workdir: "/tmp",
    timeoutSeconds: 30,
  }).timeoutMs, 30000);
});

test("admin command envelope requires an accurate, printable purpose and bounded inputs", () => {
  const base = { command: "/usr/bin/id -u", purpose: "Kiểm tra quyền quản trị" };
  assert.throws(() => makeAdminPlan({ purpose: base.purpose }), /shell command/);
  assert.throws(() => makeAdminPlan({ command: " ", purpose: base.purpose }), /shell command/);
  assert.throws(() => makeAdminPlan({ ...base, command: "a".repeat(4097) }), /shell command/);
  assert.throws(() => makeAdminPlan({ ...base, command: "id\u0000" }), /shell command/);
  assert.throws(() => makeAdminPlan({ command: base.command }), /purpose/);
  assert.throws(() => makeAdminPlan({ ...base, purpose: "line one\nline two" }), /purpose/);
  assert.throws(() => makeAdminPlan({ ...base, purpose: "x".repeat(161) }), /purpose/);
  assert.throws(() => makeAdminPlan({ ...base, workdir: "../tmp" }), /absolute/);
  assert.throws(() => makeAdminPlan({ ...base, timeoutSeconds: 0 }), /timeoutSeconds/);
  assert.throws(() => makeAdminPlan({ ...base, timeoutSeconds: 3601 }), /timeoutSeconds/);
  assert.throws(() => makeAdminPlan({ ...base, timeoutSeconds: 1.5 }), /timeoutSeconds/);
  assert.throws(() => makeAdminPlan({ ...base, operation: "polkit-test" }), /Unsupported/);
});

test("admin helper shows the purpose before using pkexec, without a second confirmation", async () => {
  const source = await readFile(new URL("../scripts/linux/admin-runner.mjs", import.meta.url), "utf8");
  assert.match(source, /invoke\("\/usr\/bin\/pkexec"/u);
  assert.match(source, /invoke\("\/usr\/bin\/notify-send"/u);
  assert.ok(source.indexOf('invoke("/usr/bin/notify-send"') < source.indexOf('invoke("/usr/bin/pkexec"'));
  assert.match(source, /cwd: plan.workdir/u);
  assert.match(source, /timeoutMs: plan.timeoutMs/u);
  assert.doesNotMatch(source, /kdialog|--yesno|--no-label/u);
});

test("status job IDs cannot traverse the runtime directory", () => {
  assert.equal(isJobId("0123456789abcdef0123456789abcdef"), true);
  assert.equal(isJobId("../passwd"), false);
  assert.equal(isJobId("0123456789abcdef0123456789abcdeg"), false);
});
