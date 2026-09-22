import assert from "node:assert/strict";
import childProcess, { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createGitClient, GitCommandError } from "../src/git/git.js";

const diagnostic = "Git inspection failed or exceeded its execution limits.";
const privateMarker = "SYNTHETIC_PRIVATE_SPAWN_VALUE";
const rawDiagnostic = `${privateMarker}\n\u001b[31msynthetic process-creation failure`;
const cliPath = fileURLToPath(new URL("../src/cli.js", import.meta.url));

async function fixture(t: TestContext) {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "auditor-git-spawn-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true, maxRetries: 3 }));
  const directory = join(temporaryRoot, "repository");
  const home = join(temporaryRoot, "home");
  const xdg = join(temporaryRoot, "xdg");
  await Promise.all([directory, home, xdg].map((path) => mkdir(path)));
  const savedEnvironment = process.env;
  process.env = {
    ...Object.fromEntries(Object.entries(savedEnvironment).filter(([key]) => !/^GIT_/i.test(key))),
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: xdg,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C"
  };
  t.after(() => { process.env = savedEnvironment; });
  return { temporaryRoot, directory };
}

function assertRedactedFailure(error: unknown): boolean {
  assert.ok(error instanceof GitCommandError);
  assert.equal(error.message, diagnostic);
  assert.equal(error.stderr, "");
  assert.equal(error.exitCode, null);
  assert.deepEqual(error.args, []);
  assert.equal("cause" in error, false);
  assert.equal("code" in error, false);
  for (const rendered of [String(error), error.stack ?? "", JSON.stringify(error)]) {
    assert.equal(rendered.includes(privateMarker), false);
    assert.equal(rendered.includes("\u001b"), false);
    assert.equal(rendered.includes("ERR_INVALID_ARG_VALUE"), false);
  }
  return true;
}

function mockSpawnFailure(t: TestContext) {
  const rawError = Object.assign(new Error(rawDiagnostic), {
    code: "EINVAL", syscall: "spawn", path: privateMarker
  });
  const mocked = t.mock.method(childProcess, "execFile", (() => {
    throw rawError;
  }) as unknown as typeof childProcess.execFile);
  syncBuiltinESMExports();
  t.after(() => {
    mocked.mock.restore();
    syncBuiltinESMExports();
  });
  return mocked;
}

test("Git redacts synchronous process-creation failure during the initial version check", async (t) => {
  const f = await fixture(t);
  const mocked = mockSpawnFailure(t);
  await assert.rejects(() => createGitClient(f.directory), assertRedactedFailure);
  assert.equal(mocked.mock.callCount(), 1);
});

for (const method of ["run", "tryRun"] as const) {
  test(`Git ${method} redacts synchronous process-creation errors`, async (t) => {
    const f = await fixture(t);
    const git = await createGitClient(f.directory);
    const mocked = mockSpawnFailure(t);
    await assert.rejects(() => git[method](f.directory, ["--version"]), assertRedactedFailure);
    assert.equal(mocked.mock.callCount(), 1);
  });

  test(`Git ${method} redacts actual synchronous Node argument-validation errors`, async (t) => {
    const f = await fixture(t);
    const git = await createGitClient(f.directory);
    // A NUL argument fails validation before Node can launch any process.
    assert.throws(() => childProcess.execFile(process.execPath, ["\0"]), (error: unknown) => {
      assert.ok(error instanceof TypeError);
      assert.equal((error as NodeJS.ErrnoException).code, "ERR_INVALID_ARG_VALUE");
      return true;
    });
    await assert.rejects(() => git[method](f.directory, ["--version", `${rawDiagnostic}\0`]),
      assertRedactedFailure);
  });
}

test("Git preserves normal nonzero results for tryRun and fixed errors for run", async (t) => {
  const f = await fixture(t);
  const config = join(f.temporaryRoot, "empty-config");
  await writeFile(config, "");
  const git = await createGitClient(f.directory);
  const args = ["config", "--file", config, "--get", "synthetic.missing"];
  assert.deepEqual(await git.tryRun(f.directory, args), {
    ok: false, stdout: "", stderr: "", exitCode: 1
  });
  await assert.rejects(() => git.run(f.directory, args), (error: unknown) => {
    assert.ok(error instanceof GitCommandError);
    assert.equal(error.message, diagnostic);
    assert.equal(error.stderr, "");
    assert.equal(error.exitCode, 1);
    return true;
  });
});

for (const format of ["text", "json"] as const) {
  test(`${format} CLI keeps synchronous Git process errors inside its fixed diagnostic boundary`, async (t) => {
    const f = await fixture(t);
    // Root discovery needs only a synthetic marker; the injected failure occurs
    // at the version check before any repository command or configuration read.
    await mkdir(join(f.directory, ".git"));
    const loader = join(f.temporaryRoot, "synthetic-spawn-failure.mjs");
    await writeFile(loader, [
      'import childProcess from "node:child_process";',
      'import { syncBuiltinESMExports } from "node:module";',
      "childProcess.execFile = () => {",
      `  throw Object.assign(new Error(${JSON.stringify(rawDiagnostic)}), { code: "EINVAL" });`,
      "};",
      "syncBuiltinESMExports();",
      ""
    ].join("\n"));
    const result = spawnSync(process.execPath,
      ["--import", pathToFileURL(loader).href, cliPath, "--format", format, f.directory], {
        cwd: f.directory, env: process.env, encoding: "utf8", windowsHide: true, timeout: 10_000
      });
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr.replaceAll("\r\n", "\n"),
      `Repository scan could not start.\n${diagnostic}\n`);
    assert.equal(result.stderr.includes(privateMarker), false);
    assert.equal(result.stderr.includes("\u001b"), false);
    assert.equal(result.stderr.includes(f.directory), false);
    assert.equal(result.stderr.includes(loader), false);
  });
}
