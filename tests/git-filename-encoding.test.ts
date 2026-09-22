import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rename, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import { GitCommandError } from "../src/git/git.js";
import { getRepositorySnapshot } from "../src/git/snapshot.js";

const cliPath = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const posixOnly = process.platform === "win32"
  ? "Raw non-UTF-8 filesystem names require POSIX; native Ubuntu coverage is separate."
  : false;
type Directory = string | Buffer;
type Filter = "clean" | "process";

function pathBytes(directory: Directory, name: Buffer | string): Buffer {
  return Buffer.concat([Buffer.from(directory), Buffer.from("/"), Buffer.from(name)]);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function repositoryState(directory: Directory) {
  return Promise.all(["config", "config.worktree", "index"].map(async (name) => {
    try {
      return await readFile(pathBytes(directory, `.git/${name}`));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }));
}

async function fixture(t: TestContext) {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "auditor-filename-encoding-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true, maxRetries: 3 }));
  const home = join(temporaryRoot, "synthetic-home");
  const xdg = join(temporaryRoot, "synthetic-xdg");
  await mkdir(home);
  await mkdir(xdg);
  const emptyConfig = join(temporaryRoot, "empty-config");
  await writeFile(emptyConfig, "");
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key))
  );
  Object.assign(env, {
    HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: xdg,
    GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C"
  });
  const originalEnvironment = process.env;
  process.env = { ...env };
  t.after(() => { process.env = originalEnvironment; });

  function gitBuffer(directory: string, args: string[], input?: Buffer): Buffer {
    return execFileSync("git", [
      "-c", "user.name=Synthetic Auditor Test",
      "-c", "user.email=synthetic@example.invalid", ...args
    ], {
      cwd: directory, env, input, windowsHide: true, stdio: "pipe", timeout: 30_000
    });
  }

  function git(directory: string, args: string[]): string {
    return gitBuffer(directory, args).toString("utf8");
  }

  async function repository(directory: string) {
    await mkdir(directory, { recursive: true });
    git(directory, ["init", "--quiet", "--template=", "-b", "main"]);
    git(directory, ["config", "core.autocrlf", "false"]);
    git(directory, ["config", "core.excludesFile", emptyConfig]);
    git(directory, ["config", "core.attributesFile", emptyConfig]);
    await writeFile(join(directory, "tracked.txt"), "initial\n");
    git(directory, ["add", "tracked.txt"]);
    git(directory, ["commit", "--quiet", "-m", "Synthetic fixture"]);
    return directory;
  }

  const directory = await repository(join(temporaryRoot, "repository"));
  const marker = join(temporaryRoot, "harmless-marker");
  const script = join(temporaryRoot, "synthetic-filter.mjs");
  await writeFile(script, [
    'import { writeFileSync } from "node:fs";',
    'writeFileSync(process.argv[2], "harmless-marker");',
    'if (process.argv[3] === "clean") process.stdin.pipe(process.stdout);'
  ].join("\n"));
  const quote = (value: string) => `'${value.replaceAll("\\", "/").replaceAll("'", "'\\''")}'`;
  function filterCommand(filter: Filter) {
    return [process.execPath, script, marker, filter].map(quote).join(" ");
  }

  async function trackedName(target: string, name: Buffer, filter?: Filter) {
    const path = pathBytes(target, name);
    await writeFile(path, "initial\n");
    if (filter !== undefined) {
      // Git accepts raw bytes in an exact .gitattributes pattern. The decoded
      // replacement-character path must not accidentally match this pattern.
      await writeFile(join(target, ".gitattributes"),
        Buffer.concat([name, Buffer.from(" filter=probe\n")]));
    }
    git(target, ["add", "--all"]);
    git(target, ["commit", "--quiet", "-m", "Synthetic filename"]);
    await writeFile(path, "mutated\n"); // Same size forces reliance on content comparison.
    const changedTime = new Date("2030-01-01T00:00:00Z");
    await utimes(path, changedTime, changedTime);
    if (filter !== undefined) configureFilter(target, filter);
  }

  function configureFilter(target: string, filter: Filter) {
    git(target, ["config", `filter.probe.${filter}`, filterCommand(filter)]);
    git(target, ["config", "filter.probe.required", "true"]);
  }

  function attributes(target: string, name: Buffer): Buffer {
    return gitBuffer(target, ["check-attr", "--all", "-z", "--stdin"],
      Buffer.concat([name, Buffer.from([0])]));
  }

  function gitlink(name: Buffer, head: string) {
    gitBuffer(directory, ["update-index", "-z", "--index-info"], Buffer.concat([
      Buffer.from(`160000 ${head}\t`), name, Buffer.from([0])
    ]));
  }

  function cli(format: "text" | "json") {
    const result = spawnSync(process.execPath, [cliPath, "--format", format, directory], {
      cwd: directory, env, encoding: "utf8", windowsHide: true, timeout: 30_000
    });
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    return result;
  }

  return { temporaryRoot, directory, marker, script, git, gitBuffer, repository,
    trackedName, configureFilter, filterCommand, attributes, gitlink, cli };
}

async function assertRefused(
  f: Awaited<ReturnType<typeof fixture>>,
  invalidEncoding: boolean,
  additionalRoots: Directory[] = []
) {
  const roots: Directory[] = [f.directory, ...additionalRoots];
  const before = await Promise.all(roots.map(repositoryState));
  assert.equal(await exists(f.marker), false, "marker absent immediately before inspection");
  let diagnostic = "";
  await assert.rejects(() => getRepositorySnapshot(f.directory), (error: unknown) => {
    assert.ok(error instanceof GitCommandError);
    assert.equal(error.stderr, "");
    if (invalidEncoding) assert.match(error.message, /UTF-8/);
    diagnostic = error.message;
    assert.ok(diagnostic.length < 200);
    return true;
  });
  assert.equal(await exists(f.marker), false, "snapshot preflight must not execute the filter");
  for (const format of ["text", "json"] as const) {
    const result = f.cli(format);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr.replaceAll("\r\n", "\n"),
      `Repository scan could not start.\n${diagnostic}\n`);
    for (const value of [f.directory, f.marker, f.script,
      f.filterCommand("clean"), f.filterCommand("process"), "odd-", "nested-"]) {
      assert.equal(result.stderr.includes(value), false, "diagnostics must stay redacted");
    }
    assert.equal(await exists(f.marker), false, `${format} CLI must not execute the filter`);
  }
  assert.deepEqual(await Promise.all(roots.map(repositoryState)), before);
}

const unicodeNames = ["café-日本語-😀.txt", "odd-\uFFFD.txt"];
test("Git inspection preserves valid Unicode and a genuine replacement character", async (t) => {
  const f = await fixture(t);
  for (const name of unicodeNames) await writeFile(join(f.directory, name), "Unicode fixture\n");
  f.git(f.directory, ["add", "--all"]);
  f.git(f.directory, ["commit", "--quiet", "-m", "Synthetic valid Unicode"]);
  const before = await repositoryState(f.directory);
  const snapshot = await getRepositorySnapshot(f.directory);
  for (const name of unicodeNames) assert.ok(snapshot.trackedFiles.includes(name));
  assert.equal(snapshot.trackedFiles.length, unicodeNames.length + 1);
  assert.equal(snapshot.isDirty, false);
  assert.deepEqual(await repositoryState(f.directory), before);
});

for (const name of unicodeNames) {
  for (const filter of ["clean", "process"] as const) {
    test(`Git inspection refuses an exact ${filter} filter on valid Unicode ${name}`, async (t) => {
      const f = await fixture(t);
      await f.trackedName(f.directory, Buffer.from(name), filter);
      assert.ok(f.attributes(f.directory, Buffer.from(name)).includes(Buffer.from("\0filter\0probe\0")));
      await assertRefused(f, false);
    });
  }
}

const invalidName = Buffer.concat([Buffer.from("odd-"), Buffer.from([0xff]), Buffer.from(".txt")]);
for (const filter of ["clean", "process"] as const) {
  test(`Git inspection refuses raw invalid UTF-8 before an exact ${filter} filter`,
    { skip: posixOnly }, async (t) => {
      const f = await fixture(t);
      await f.trackedName(f.directory, invalidName, filter);
      assert.ok(f.attributes(f.directory, invalidName).includes(Buffer.from("\0filter\0probe\0")));
      assert.equal(f.attributes(f.directory, Buffer.from(invalidName.toString("utf8"))).length, 0);
      await assertRefused(f, true);
    });
}

test("Git inspection refuses an invalid UTF-8 filename even without filters",
  { skip: posixOnly }, async (t) => {
    const f = await fixture(t);
    await f.trackedName(f.directory, invalidName);
    await assertRefused(f, true);
  });

test("Git inspection cannot collapse distinct invalid byte filenames into one path",
  { skip: posixOnly }, async (t) => {
    const f = await fixture(t);
    const other = Buffer.concat([Buffer.from("odd-"), Buffer.from([0xfe]), Buffer.from(".txt")]);
    assert.notDeepEqual(invalidName, other);
    assert.equal(invalidName.toString("utf8"), other.toString("utf8"));
    await writeFile(pathBytes(f.directory, invalidName), "first\n");
    await writeFile(pathBytes(f.directory, other), "second\n");
    f.git(f.directory, ["add", "--all"]);
    f.git(f.directory, ["commit", "--quiet", "-m", "Synthetic distinct raw names"]);
    const listed = f.gitBuffer(f.directory, ["ls-files", "-z"]);
    assert.ok(listed.includes(Buffer.concat([invalidName, Buffer.from([0])])));
    assert.ok(listed.includes(Buffer.concat([other, Buffer.from([0])])));
    await assertRefused(f, true);
  });

for (const filter of ["clean", "process"] as const) {
  test(`Git inspection refuses invalid UTF-8 inside an initialized submodule before its ${filter} filter`,
    { skip: posixOnly }, async (t) => {
      const f = await fixture(t);
      const nested = await f.repository(join(f.directory, "nested"));
      await f.trackedName(nested, invalidName, filter);
      await writeFile(join(f.directory, ".gitmodules"),
        '[submodule "nested"]\n\tpath = nested\n\turl = ./nested\n');
      f.git(f.directory, ["add", ".gitmodules"]);
      f.gitlink(Buffer.from("nested"), f.git(nested, ["rev-parse", "HEAD"]).trim());
      assert.ok(f.attributes(nested, invalidName).includes(Buffer.from("\0filter\0probe\0")));
      assert.equal(f.attributes(nested, Buffer.from(invalidName.toString("utf8"))).length, 0);
      await assertRefused(f, true, [nested]);
    });
}

test("Git inspection refuses a raw invalid UTF-8 gitlink before traversing its filtered worktree",
  { skip: posixOnly }, async (t) => {
    const f = await fixture(t);
    const nested = await f.repository(join(f.directory, "nested"));
    await f.trackedName(nested, Buffer.from("ordinary.txt"), "clean");
    const head = f.git(nested, ["rev-parse", "HEAD"]).trim();
    const name = Buffer.concat([Buffer.from("nested-"), Buffer.from([0xff])]);
    const moved = pathBytes(f.directory, name);
    await rename(nested, moved);
    await writeFile(join(f.directory, ".gitmodules"), Buffer.concat([
      Buffer.from('[submodule "nested"]\n\tpath = '), name, Buffer.from("\n\turl = ./nested\n")
    ]));
    f.git(f.directory, ["add", ".gitmodules"]);
    f.gitlink(name, head);
    await assertRefused(f, true, [moved]);
  });
