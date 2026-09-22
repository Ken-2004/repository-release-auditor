import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";

import { CONFIG_FILENAME, type ForbiddenPattern } from "../src/config/types.js";
import { MAX_TEXT_FILE_BYTES } from "../src/files/tracked-text.js";
import { createForbiddenPatternRule } from "../src/rules/forbidden-pattern.js";

const value = ["Private", "Policy", "Fixture"].join("_");
const pattern: ForbiddenPattern = { id: "marker", text: value, caseSensitive: true };

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "auditor-pattern-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3 }));
  const repository = { root, branch: "main", head: null, trackedFiles: [] as string[], statusEntries: [], isDirty: false };
  async function file(path: string, text: string | Buffer) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
    repository.trackedFiles.push(path);
  }
  const run = (patterns: readonly ForbiddenPattern[] = [pattern]) =>
    createForbiddenPatternRule(patterns).run({ repository });
  return { root, repository, file, run };
}

test("literal matching preserves case by default and treats regex/glob characters literally", async (t) => {
  const f = await fixture(t);
  await f.file("a.txt", value.toLowerCase());
  assert.deepEqual(f.run(), []);
  assert.equal(f.run([{ ...pattern, caseSensitive: false }]).length, 1);
  await f.file("b.txt", value);
  assert.equal(f.run().length, 1);
  assert.deepEqual(f.run([]), []);
  const literal = [value, ".*+[x]?$"].join("");
  assert.deepEqual(f.run([{ ...pattern, text: literal }]), []);
  await f.file("literal.txt", literal);
  assert.equal(f.run([{ ...pattern, text: literal }])[0]?.path, "literal.txt");
});

for (const [name, ending] of [["LF", "\n"], ["CRLF", "\r\n"], ["CR", "\r"]] as const) {
  test(`first occurrence uses correct ${name} line numbers and deduplicates repetitions`, async (t) => {
    const f = await fixture(t);
    await f.file("nested/file.txt", ["ordinary", "", value, value].join(ending));
    const findings = f.run();
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.path, "nested/file.txt");
    assert.equal(findings[0]?.evidence, 'Line 3: matched configured pattern "marker"; value redacted.');
  });
}

test("case-insensitive Unicode expansion preserves line numbers; multiline patterns stay literal", async (t) => {
  const f = await fixture(t);
  await f.file("unicode.txt", `${"\u0130".repeat(20)}\r\n${value.toUpperCase()}\r\nend`);
  assert.match(f.run([{ ...pattern, caseSensitive: false }])[0]?.evidence ?? "", /^Line 2:/);
  assert.match(f.run([{ ...pattern, text: `${value}\r\nend`, caseSensitive: false }])[0]?.evidence ?? "", /^Line 2:/);
  assert.deepEqual(f.run([{ ...pattern, text: `${value}\nend`, caseSensitive: false }]), []);
});

test("findings are sorted by path then ID with redacted evidence and no input mutation", async (t) => {
  const f = await fixture(t);
  const surrounding = ["unrelated", "private", "source"].join("_");
  await f.file("nested/z.txt", `${surrounding}\n${value} ${surrounding}`);
  await f.file("a.txt", value);
  f.repository.trackedFiles.push("a.txt");
  const patterns = [{ ...pattern, id: "z" }, { ...pattern, id: "A" }];
  const findings = f.run(patterns);
  assert.deepEqual(findings.map((finding) => [finding.path, finding.evidence]), [
    ["a.txt", 'Line 1: matched configured pattern "A"; value redacted.'],
    ["a.txt", 'Line 1: matched configured pattern "z"; value redacted.'],
    ["nested/z.txt", 'Line 2: matched configured pattern "A"; value redacted.'],
    ["nested/z.txt", 'Line 2: matched configured pattern "z"; value redacted.']
  ]);
  assert.deepEqual(patterns.map((entry) => entry.id), ["z", "A"]);
  assert.deepEqual(f.repository.trackedFiles, ["nested/z.txt", "a.txt", "a.txt"]);
  f.repository.trackedFiles.reverse();
  assert.deepEqual(f.run(patterns.toReversed()), findings);
  for (const finding of findings) {
    assert.equal(finding.ruleId, "forbidden-pattern");
    assert.equal(finding.category, "repository");
    assert.equal(finding.severity, "warning");
    assert.match(finding.remediation ?? "", /remove or replace.*revise the repository policy/);
  }
  assert.equal(JSON.stringify(findings).includes(value), false);
  assert.equal(JSON.stringify(findings).includes(surrounding), false);
});

test("only the root config is exempt; nested files and other rules retain their scope", async (t) => {
  const f = await fixture(t);
  await f.file(CONFIG_FILENAME, JSON.stringify({ forbiddenPatterns: [pattern] }));
  await f.file(`nested/${CONFIG_FILENAME}`, value);
  assert.deepEqual(f.run().map((finding) => finding.path), [`nested/${CONFIG_FILENAME}`]);
});

test("reader skips binary, oversized, unsupported, missing, directory, and linked files", async (t) => {
  const f = await fixture(t);
  await f.file("binary.txt", Buffer.concat([Buffer.from([0]), Buffer.from(value)]));
  await f.file("encoding.txt", Buffer.concat([Buffer.from([0xff]), Buffer.from(value)]));
  await f.file("oversized.txt", value.padEnd(MAX_TEXT_FILE_BYTES + 1, "x"));
  await f.file("unsupported.dat", value);
  await f.file("nested.txt/file.txt", value);
  f.repository.trackedFiles = ["binary.txt", "encoding.txt", "oversized.txt", "unsupported.dat", "missing.txt", "nested.txt"];
  await writeFile(join(f.root, "untracked.txt"), value);
  await symlink(join(f.root, "nested.txt"), join(f.root, "linked"), process.platform === "win32" ? "junction" : "dir");
  f.repository.trackedFiles.push("linked/file.txt");
  assert.deepEqual(f.run(), []);
});
