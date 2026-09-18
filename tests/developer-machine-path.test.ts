import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { developerMachinePathRule, findDeveloperMachinePath } from "../src/rules/developer-machine-path.js";

const aliceWindowsParts = ["C:", "Users", "Alice", "project"];
const aliceHomePath = ["/home", "alice", "project"].join("/");
const aliceMacPath = ["/Users", "alice", "project"].join("/");
const workPath = ["D:", "work", "repo"].join("/");
const privateHomePath = ["/home", "private-user", "private-project"].join("/");

for (const [text, kind] of [
  [`path=${aliceWindowsParts.join("\\")}`, "Windows drive path"],
  [`path=${aliceWindowsParts.join("/")}`, "Windows drive path"],
  [["D:", "workspace", "repo"].join("\\"), "Windows drive path"],
  [JSON.stringify({ path: aliceWindowsParts.join("\\") }), "Windows drive path"],
  [["/home", "user", "project"].join("/"), "Unix home path"],
  [aliceMacPath, "Unix home path"],
  [["/mnt/c", "Users", "alice", "project"].join("/"), "WSL home path"],
  [["/mnt/d", "home", "alice", "project"].join("/"), "WSL home path"],
  [["/home", "élise", "project"].join("/"), "Unix home path"]
]) {
  test(`recognizes ${text}`, () => {
    assert.deepEqual(findDeveloperMachinePath(`ordinary text\r\n${text}`), { line: 2, kind });
  });
}

test("ignores relative paths, Git paths, and ordinary system locations", () => {
  for (const text of [
    "./src/index.ts", "../config/file.json", `src${aliceHomePath}`, `.${aliceHomePath}`,
    `..${aliceMacPath}`, "~/project", "/usr/local/bin", "/etc/config", "/var/log/app",
    "/tmp/output", "/opt/app", "/workspace/project", "C:relative/file.txt",
    ["C:", "Windows", "System32"].join("\\"), ["C:", "Program Files", "tool", "bin"].join("/"),
    ["C:", "ProgramData", "tool"].join("/"), ["C:", "Temp", "runtime"].join("/"),
    "https://example.com/path", `//example.com${aliceHomePath}`,
    `https://example.com${aliceHomePath}?file=${aliceWindowsParts.join("/")}`,
    `file://${aliceHomePath}`, `ssh://server${aliceMacPath}`,
    `https://example.com/?dir=${aliceHomePath}`,
    `//example.com/?dir=${aliceHomePath}`, JSON.stringify(["C:", "Windows"].join("/"))
  ]) {
    assert.equal(findDeveloperMachinePath(text), null, text);
  }
});

test("ignores explicit username/root placeholders without exempting literal user names", () => {
  for (const text of [
    "/home/<user>/project", "/Users/{username}/project", "/home/${USER}/project",
    "/home/[username]/project", "/home/__USER__/project", "/home/../project",
    "/mnt/c/Users/<username>/project", String.raw`C:\Users\%USERNAME%\project`,
    String.raw`C:\Users\<username>\project`, "D:/${WORKSPACE}/project"
  ]) {
    assert.equal(findDeveloperMachinePath(text), null, text);
  }
  assert.notEqual(findDeveloperMachinePath(["/home", "user", "project"].join("/")), null);
  assert.notEqual(findDeveloperMachinePath(["/home", "alice", "<project>"].join("/")), null);
});

test("finds the first real path after URLs or placeholders with correct line numbers", () => {
  assert.deepEqual(findDeveloperMachinePath(
    `https://example.com${["/home", "alice"].join("/")}\n/home/<user>/example\r\n` +
    `${["/Users", "bob", "project"].join("/")}\n${workPath}`
  ), { line: 3, kind: "Unix home path" });
});

test("rule returns sorted unique files and static redacted evidence", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "auditor-machine-path-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3 }));
  await mkdir(join(root, "nested"));
  await writeFile(join(root, "nested", "config.txt"), `unrelated-secret\n${privateHomePath}\n${workPath}`);
  await writeFile(join(root, "a.txt"), ["C:", "Users", "private-user", "private-project"].join("/"));
  await writeFile(join(root, "untracked.txt"), privateHomePath);
  const trackedFiles = ["nested/config.txt", "a.txt", "nested/config.txt"];
  const repository = { root, branch: "main", head: null, trackedFiles, statusEntries: [], isDirty: false };
  const findings = developerMachinePathRule.run({ repository });
  assert.deepEqual(findings.map((finding) => finding.path), ["a.txt", "nested/config.txt"]);
  assert.deepEqual(developerMachinePathRule.run({ repository: {
    ...repository, trackedFiles: trackedFiles.toReversed()
  } }), findings);
  assert.deepEqual(findings.map((finding) => finding.evidence), [
    "Line 1: Windows drive path; value redacted.", "Line 2: Unix home path; value redacted."
  ]);
  assert.deepEqual(trackedFiles, ["nested/config.txt", "a.txt", "nested/config.txt"]);
  for (const finding of findings) {
    assert.equal(finding.ruleId, "developer-machine-path");
    assert.equal(finding.severity, "warning");
    assert.match(finding.remediation ?? "", /relative paths, environment variables/);
  }
  assert.doesNotMatch(JSON.stringify(findings), /private-user|private-project|unrelated-secret/);
});
