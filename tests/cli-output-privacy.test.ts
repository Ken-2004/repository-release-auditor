import assert from "node:assert/strict";
import { execFileSync, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const cliPath = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const privateMarker = "SYNTHETIC_PRIVATE_DIAGNOSTIC_68429";
const privateDetail = `${privateMarker}\n\u001b[31msynthetic\u0007\u202e`;
const genericDiagnostic =
  "Repository scan failed because of an unexpected runtime or filesystem error.\n";
const filenameSkip = process.platform === "win32"
  ? "Windows filenames cannot contain C0 controls; formatter coverage runs on all platforms."
  : false;

async function fixture(t: TestContext, name = "repository") {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "auditor-output-privacy-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true, maxRetries: 3 }));
  const directory = join(temporaryRoot, name);
  const home = join(temporaryRoot, "synthetic-home");
  const xdg = join(temporaryRoot, "synthetic-xdg");
  await Promise.all([directory, home, xdg].map((path) => mkdir(path)));
  const emptyConfig = join(temporaryRoot, "empty-config");
  await writeFile(emptyConfig, "");
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key))
  );
  Object.assign(env, {
    HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: xdg,
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: emptyConfig,
    GIT_TERMINAL_PROMPT: "0", LC_ALL: "C"
  });

  function git(args: string[]): string {
    return execFileSync("git", [
      "-c", "user.name=Synthetic Auditor Test",
      "-c", "user.email=synthetic@example.invalid", ...args
    ], { cwd: directory, env, encoding: "utf8", windowsHide: true,
      stdio: "pipe", timeout: 30_000 });
  }

  function init() {
    git(["init", "--quiet", "--template=", "-b", "main"]);
    git(["config", "core.autocrlf", "false"]);
    git(["config", "core.excludesFile", emptyConfig]);
    git(["config", "core.attributesFile", emptyConfig]);
  }

  function commit() {
    git(["add", "--all"]);
    git(["commit", "--quiet", "-m", "Synthetic output fixture"]);
  }

  function cli(args: string[], loader?: string, explicitPath = true) {
    const result = spawnSync(process.execPath, [
      ...(loader === undefined ? [] : ["--import", pathToFileURL(loader).href]),
      cliPath, ...args, ...(explicitPath ? [directory] : [])
    ], { cwd: directory, env, encoding: "utf8", windowsHide: true, timeout: 30_000 });
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    return result;
  }

  return { temporaryRoot, directory, git, init, commit, cli };
}

function assertFailure(result: SpawnSyncReturns<string>, diagnostic: string) {
  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr.replaceAll("\r\n", "\n"), diagnostic);
  assert.equal(result.stderr.includes(privateMarker), false);
  assert.equal(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/u
    .test(result.stderr.replaceAll("\r\n", "\n")), false);
  assert.equal(/^\s+at /m.test(result.stderr), false);
  assert.ok(result.stderr.length < 300);
}

test("CLI escapes Unicode display controls in real roots and filenames without changing JSON values", async (t) => {
  const f = await fixture(t, "repository-\u200f");
  f.init();
  const unicode = "caf\u00e9-\u65e5\u672c\u8a9e-\ud83d\ude00-e\u0301-\ufffd";
  const filename = `${unicode}-\u0085\u009b\u2028\u2029\u202e\u2066.key`;
  const displayed = `${unicode}-\\u0085\\u009b\\u2028\\u2029\\u202e\\u2066.key`;
  await writeFile(join(f.directory, filename), "Synthetic inert file\n");
  await writeFile(join(f.directory, "credentials.json"), "{}\n");
  f.commit();
  const text = f.cli(["--format", "text"]);
  assert.equal(text.status, 1);
  assert.equal(text.stderr, "");
  assert.equal(text.stdout.includes("repository-\\u200f"), true);
  assert.equal(text.stdout.includes(`Path: ${displayed}\n`), true);
  assert.equal(text.stdout.match(/^\[WARNING\] risky-tracked-file$/gm)?.length, 2);
  assert.equal(/[\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/u.test(text.stdout), false);

  const json = f.cli(["--format", "json"]);
  assert.equal(json.status, 1);
  assert.equal(json.stderr, "");
  const report = JSON.parse(json.stdout);
  assert.equal(report.schemaVersion, 1);
  assert.deepEqual(report.summary, {
    findingCount: 2, bySeverity: { info: 0, warning: 2, error: 0 }
  });
  assert.equal(report.repository.root, (await realpath(f.directory)).replaceAll("\\", "/"));
  assert.deepEqual(report.findings.map((finding: { path: string }) => finding.path),
    [filename, "credentials.json"].sort());
  assert.equal(json.stdout.includes(displayed), true);
  assert.equal(/[\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/u.test(json.stdout), false);
});

const inertNames = [
  { label: "newline", filename: "name\n[WARNING] forged.key", displayed: "name\\u000a[WARNING] forged.key" },
  { label: "carriage return", filename: "name\rforged.key", displayed: "name\\u000dforged.key" },
  { label: "escape sequence and bell", filename: "name\u001b[31m\u0007.key", displayed: "name\\u001b[31m\\u0007.key" }
];
for (const { label, filename, displayed } of inertNames) {
  test(`CLI safely reports a real tracked filename containing ${label}`,
    { skip: filenameSkip }, async (t) => {
      const f = await fixture(t);
      f.init();
      await writeFile(join(f.directory, filename), "Synthetic inert file\n");
      f.commit();
      const text = f.cli(["--format", "text"]);
      assert.equal(text.status, 1);
      assert.equal(text.stderr, "");
      assert.equal(text.stdout.includes(`Path: ${displayed}\n`), true);
      assert.equal(text.stdout.split("\n").filter((line) => line.startsWith("[WARNING]")).length, 1);
      assert.equal(text.stdout.includes("\n[WARNING] forged"), false);
      assert.equal(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/u.test(text.stdout), false);
      const json = f.cli(["--format", "json"]);
      assert.equal(json.status, 1);
      assert.equal(json.stderr, "");
      const report = JSON.parse(json.stdout);
      assert.equal(report.schemaVersion, 1);
      assert.equal(report.summary.findingCount, 1);
      assert.equal(report.summary.bySeverity.warning, 1);
      assert.equal(report.findings.length, 1);
      assert.equal(report.findings[0].path, filename);
      assert.equal(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/u.test(json.stdout), false);
    });
}

const argumentCases = [
  { label: "unknown option", args: [`--${privateDetail.repeat(200)}`],
    diagnostic: "Invalid command-line arguments. Use --help for usage.\n" },
  { label: "invalid format", args: ["--format", privateDetail],
    diagnostic: "Expected --format text or --format json.\n" },
  { label: "conflicting formats", args: ["--format", "text", "--json", privateDetail],
    diagnostic: "Conflicting output formats; choose text or json.\n" },
  { label: "extra paths", args: [privateDetail, "extra"],
    diagnostic: "Expected at most one repository path.\n" }
];
for (const { label, args, diagnostic } of argumentCases) {
  test(`CLI redacts synthetic private arguments for ${label}`, async (t) => {
    const f = await fixture(t);
    for (const format of ["text", "json"]) {
      assertFailure(f.cli(["--format", format, ...args], undefined, false), diagnostic);
    }
  });
}

const thrownValues = ["error", "string", "object", "null", "undefined"] as const;
function thrownExpression(kind: typeof thrownValues[number]): string {
  if (kind === "error") return `new Error(${JSON.stringify(privateDetail)}, { cause: new Error(${JSON.stringify(privateDetail)}) })`;
  if (kind === "string") return JSON.stringify(privateDetail);
  if (kind === "null" || kind === "undefined") return kind;
  return `{
    toString: convert, toJSON: convert, valueOf: convert,
    [Symbol.for("nodejs.util.inspect.custom")]: convert,
    get message() { return convert(); }, get stack() { return convert(); }
  }`;
}

for (const kind of thrownValues) {
  test(`CLI uses a fixed fallback for an unexpected thrown ${kind}`, async (t) => {
    const f = await fixture(t);
    const conversionMarker = join(f.temporaryRoot, "converted");
    const loader = join(f.temporaryRoot, "synthetic-cwd-failure.mjs");
    await writeFile(loader, [
      'import { writeFileSync } from "node:fs";',
      `function convert() { writeFileSync(${JSON.stringify(conversionMarker)}, "converted"); return ${JSON.stringify(privateDetail)}; }`,
      `process.cwd = () => { throw ${thrownExpression(kind)}; };`, ""
    ].join("\n"));
    for (const format of ["text", "json"]) {
      assertFailure(f.cli(["--format", format], loader, false), genericDiagnostic);
      await assert.rejects(access(conversionMarker), { code: "ENOENT" });
    }
  });
}

test("CLI redacts scoped filesystem failures after repository inspection", async (t) => {
  const f = await fixture(t);
  f.init();
  await writeFile(join(f.directory, "ordinary.txt"), "Synthetic tracked text\n");
  f.commit();
  const trigger = join(f.temporaryRoot, "read-attempted");
  const loader = join(f.temporaryRoot, "synthetic-read-failure.mjs");
  await writeFile(loader, [
    'import fs from "node:fs";',
    'import { basename } from "node:path";',
    'import { syncBuiltinESMExports } from "node:module";',
    "const descriptors = new Set();",
    "const open = fs.openSync; const read = fs.readSync;",
    "fs.openSync = (path, ...args) => {",
    "  const descriptor = open(path, ...args);",
    '  if (typeof path === "string" && basename(path) === "ordinary.txt") descriptors.add(descriptor);',
    "  return descriptor;",
    "};",
    "fs.readSync = (descriptor, ...args) => {",
    "  if (descriptors.has(descriptor)) {",
    `    fs.writeFileSync(${JSON.stringify(trigger)}, "attempted");`,
    `    throw Object.assign(new Error(${JSON.stringify(privateDetail)}), { code: "EACCES", path: ${JSON.stringify(privateDetail)} });`,
    "  }",
    "  return read(descriptor, ...args);",
    "};",
    "syncBuiltinESMExports();", ""
  ].join("\n"));
  for (const format of ["text", "json"]) {
    assertFailure(f.cli(["--format", format], loader), genericDiagnostic);
    assert.equal(await readFile(trigger, "utf8"), "attempted");
  }
});

test("CLI retains a fixed configuration diagnostic without exposing malformed source", async (t) => {
  const f = await fixture(t);
  f.init();
  await writeFile(join(f.directory, ".repository-release-auditor.json"), `{${privateMarker}\u202e\n`);
  for (const format of ["text", "json"]) {
    assertFailure(f.cli(["--format", format]),
      "Configuration error: .repository-release-auditor.json: invalid JSON.\n");
  }
});
