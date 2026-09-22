import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import { GitCommandError } from "../src/git/git.js";
import { getRepositorySnapshot } from "../src/git/snapshot.js";

const cliPath = fileURLToPath(new URL("../src/cli.js", import.meta.url));
type ConfigScope = "local" | "global" | "include" | "worktree";

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function fixture(t: TestContext) {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "auditor git safety-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true, maxRetries: 3 }));
  const home = join(temporaryRoot, "home");
  const xdg = join(temporaryRoot, "xdg");
  await mkdir(home);
  await mkdir(xdg);
  const emptyConfig = join(temporaryRoot, "empty-config");
  await writeFile(emptyConfig, "");

  const env: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key))
  );
  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: xdg,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C"
  });
  const originalEnvironment = process.env;
  process.env = { ...env };
  t.after(() => { process.env = originalEnvironment; });

  function git(directory: string, args: string[]): string {
    return execFileSync("git", [
      "-c", "user.name=Synthetic Auditor Test",
      "-c", "user.email=synthetic@example.invalid",
      ...args
    ], {
      cwd: directory, env, encoding: "utf8", windowsHide: true,
      stdio: "pipe", timeout: 30_000
    });
  }

  async function repository(directory = join(temporaryRoot, "repository")) {
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

  const directory = await repository();
  const marker = join(temporaryRoot, "marker");
  const script = join(temporaryRoot, "marker.mjs");
  await writeFile(script, [
    'import { writeFileSync } from "node:fs";',
    'writeFileSync(process.argv[2], "harmless-marker");',
    'if (process.argv[3] === "clean") process.stdin.pipe(process.stdout);',
    'else if (process.argv[3] === "fsmonitor") process.stdout.write("token\\0/\\0");'
  ].join("\n"));

  function markerCommand(mode: string) {
    // Git runs these configured commands through its shell on both platforms.
    const quote = (value: string) => `'${value.replaceAll("\\", "/").replaceAll("'", "'\\''")}'`;
    return [process.execPath, script, marker, mode].map(quote).join(" ");
  }

  function configure(scope: ConfigScope, key: string, value: string, target = directory) {
    if (scope === "global") {
      git(target, ["config", "--file", join(home, ".gitconfig"), key, value]);
    } else if (scope === "include") {
      const included = join(temporaryRoot, "included-config");
      git(target, ["config", "include.path", included]);
      git(target, ["config", "--file", included, key, value]);
    } else if (scope === "worktree") {
      git(target, ["config", "extensions.worktreeConfig", "true"]);
      git(target, ["config", "--worktree", key, value]);
    } else {
      git(target, ["config", key, value]);
    }
  }

  async function filteredFile(target = directory) {
    await writeFile(join(target, ".gitattributes"), "tracked.txt filter=probe\n");
    git(target, ["add", ".gitattributes"]);
    git(target, ["commit", "--quiet", "-m", "Synthetic attributes"]);
    await writeFile(join(target, "tracked.txt"), "mutated\n");
    const changedTime = new Date("2030-01-01T00:00:00Z");
    await utimes(join(target, "tracked.txt"), changedTime, changedTime);
  }

  function cli() {
    const result = spawnSync(process.execPath, [cliPath, directory], {
      cwd: directory, env: process.env, encoding: "utf8",
      windowsHide: true, timeout: 30_000
    });
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    return result;
  }

  return { temporaryRoot, directory, home, marker, git, repository, configure, markerCommand, filteredFile, cli };
}

async function state(directory: string) {
  const names = ["config", "config.worktree", "index"];
  return Promise.all(names.map(async (name) => {
    const path = join(directory, ".git", name);
    return await exists(path) ? await readFile(path) : null;
  }));
}

async function assertRefused(f: Awaited<ReturnType<typeof fixture>>, additionalRoots: string[] = []) {
  const roots = [f.directory, ...additionalRoots];
  const before = await Promise.all(roots.map(state));
  await assert.rejects(() => getRepositorySnapshot(f.directory), GitCommandError);
  const result = f.cli();
  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.notEqual(result.stderr, "");
  assert.equal(result.stderr.includes(f.markerCommand("clean")), false);
  assert.equal(result.stderr.includes(f.markerCommand("process")), false);
  assert.equal(await exists(f.marker), false);
  assert.deepEqual(await Promise.all(roots.map(state)), before);
}

for (const scope of ["local", "global", "include", "worktree"] as const) {
  test(`Git inspection disables ${scope} fsmonitor without modifying configuration or index`, async (t) => {
    const f = await fixture(t);
    f.configure(scope, "core.fsmonitor", f.markerCommand("fsmonitor"));
    const before = await state(f.directory);
    const snapshot = await getRepositorySnapshot(f.directory);
    assert.equal(snapshot.isDirty, false);
    assert.equal(await exists(f.marker), false);
    assert.deepEqual(await state(f.directory), before);
  });

  for (const filter of ["clean", "process"] as const) {
    test(`Git inspection refuses ${scope} ${filter} filters before execution`, async (t) => {
      const f = await fixture(t);
      await f.filteredFile();
      f.configure(scope, `filter.probe.${filter}`, f.markerCommand(filter));
      f.configure(scope, "filter.probe.required", "true");
      await assertRefused(f);
    });
  }
}

test("Git inspection permits unused filter configuration without executing it", async (t) => {
  const f = await fixture(t);
  f.configure("local", "filter.probe.process", f.markerCommand("process"));
  const before = await state(f.directory);
  assert.equal((await getRepositorySnapshot(f.directory)).isDirty, false);
  assert.equal(await exists(f.marker), false);
  assert.deepEqual(await state(f.directory), before);
});

for (const attribute of ["filter", "-filter", "filter=unspecified"]) {
  test(`Git inspection conservatively refuses tracked ${attribute} attributes`, async (t) => {
    const f = await fixture(t);
    await writeFile(join(f.directory, ".gitattributes"), `tracked.txt ${attribute}\n`);
    f.git(f.directory, ["add", ".gitattributes"]);
    f.git(f.directory, ["commit", "--quiet", "-m", "Synthetic filter attribute"]);
    await assertRefused(f);
  });
}

test("Git inspection ignores inherited repository, index, object, and configuration selectors", async (t) => {
  const f = await fixture(t);
  const other = await f.repository(join(f.temporaryRoot, "other"));
  await writeFile(join(f.directory, "tracked.txt"), "requested repository is dirty\n");
  const otherGit = join(other, ".git");
  const injectedConfig = join(f.temporaryRoot, "injected-config");
  f.git(f.directory, ["config", "--file", injectedConfig, "core.bare", "true"]);
  const injections: NodeJS.ProcessEnv[] = [
    { GIT_DIR: otherGit, GIT_WORK_TREE: other, GIT_COMMON_DIR: otherGit },
    { GIT_INDEX_FILE: join(otherGit, "index"), GIT_OBJECT_DIRECTORY: join(otherGit, "objects"),
      GIT_ALTERNATE_OBJECT_DIRECTORIES: join(otherGit, "objects"), GIT_NAMESPACE: "synthetic" },
    { GIT_CONFIG_GLOBAL: injectedConfig, GIT_CONFIG_SYSTEM: injectedConfig,
      GIT_CONFIG: injectedConfig, GIT_CONFIG_PARAMETERS: "'core.bare=true'",
      GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.bare", GIT_CONFIG_VALUE_0: "true" },
    { GIT_EXEC_PATH: f.directory, GIT_TRACE: f.marker, GIT_TRACE_SETUP: f.marker,
      GIT_TRACE2_EVENT: f.marker, GIT_OPTIONAL_LOCKS: "1" }
  ];
  const before = await state(f.directory);
  for (const injection of injections) {
    const saved = process.env;
    process.env = { ...saved, ...injection };
    try {
      const snapshot = await getRepositorySnapshot(f.directory);
      assert.equal(resolve(snapshot.root), resolve(f.directory));
      assert.equal(snapshot.isDirty, true);
    } finally {
      process.env = saved;
    }
  }
  assert.equal(await exists(f.marker), false);
  assert.deepEqual(await state(f.directory), before);
});

for (const flag of ["assume-unchanged", "skip-worktree"] as const) {
  test(`Git inspection refuses ${flag} instead of claiming a concealed mismatch is clean`, async (t) => {
    const f = await fixture(t);
    f.git(f.directory, ["update-index", `--${flag}`, "tracked.txt"]);
    await writeFile(join(f.directory, "tracked.txt"), "different bytes\n");
    assert.notEqual(await readFile(join(f.directory, "tracked.txt"), "utf8"),
      f.git(f.directory, ["show", ":tracked.txt"]));
    await assertRefused(f);
  });
}

test("Git inspection refuses sparse checkouts with missing tracked files", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.directory, "omitted.txt"), "synthetic omitted content\n");
  f.git(f.directory, ["add", "omitted.txt"]);
  f.git(f.directory, ["commit", "--quiet", "-m", "Sparse fixture"]);
  f.git(f.directory, ["sparse-checkout", "set", "--no-cone", "tracked.txt"]);
  assert.equal(await exists(join(f.directory, "omitted.txt")), false);
  await assertRefused(f);
});

test("Git inspection refuses enabled sparse-index configuration", async (t) => {
  const f = await fixture(t);
  f.git(f.directory, ["config", "index.sparse", "true"]);
  await assertRefused(f);
});

test("Git inspection refuses core.ignoreStat instead of trusting skipped comparisons", async (t) => {
  const f = await fixture(t);
  f.configure("local", "core.ignoreStat", "true");
  await writeFile(join(f.directory, "tracked.txt"), "different bytes\n");
  await assertRefused(f);
});

for (const key of ["extensions.partialClone", "remote.synthetic.promisor"]) {
  test(`Git inspection refuses ${key} without attempting remote access`, async (t) => {
    const f = await fixture(t);
    f.configure("local", "remote.synthetic.url", "./unused-synthetic-remote");
    f.configure("local", key, key === "extensions.partialClone" ? "synthetic" : "true");
    await assertRefused(f);
  });
}

test("Git inspection refuses local core.worktree redirection outside the requested repository", async (t) => {
  const f = await fixture(t);
  const other = await f.repository(join(f.temporaryRoot, "other"));
  f.git(f.directory, ["config", "core.worktree", other]);
  await assertRefused(f, [other]);
});

test("Git inspection supports linked worktrees and requests from their subdirectories", async (t) => {
  const f = await fixture(t);
  const linked = join(f.temporaryRoot, "linked-worktree");
  f.git(f.directory, ["worktree", "add", "--quiet", "-b", "linked", linked]);
  const subdirectory = join(linked, "nested-directory");
  await mkdir(subdirectory);
  const gitDirectory = f.git(linked, ["rev-parse", "--absolute-git-dir"]).trim();
  const linkedIndex = join(gitDirectory, "index");
  const before = await readFile(linkedIndex);
  const commonBefore = await state(f.directory);

  const clean = await getRepositorySnapshot(subdirectory);
  assert.equal(resolve(clean.root), resolve(linked));
  assert.equal(clean.branch, "linked");
  assert.equal(clean.isDirty, false);
  await writeFile(join(linked, "tracked.txt"), "linked worktree changed\n");
  const dirty = await getRepositorySnapshot(linked);
  assert.equal(dirty.isDirty, true);
  assert.deepEqual(await readFile(linkedIndex), before);
  assert.deepEqual(await state(f.directory), commonBefore);
});

test("Git inspection disables post-index-change hooks and keeps a dirty index unchanged", async (t) => {
  const f = await fixture(t);
  const hooks = join(f.temporaryRoot, "hooks");
  await mkdir(hooks);
  await writeFile(join(hooks, "post-index-change"),
    `#!/bin/sh\nexec ${f.markerCommand("hook")}\n`, { mode: 0o755 });
  f.configure("local", "core.hooksPath", hooks);
  await writeFile(join(f.directory, "tracked.txt"), "dirty fixture content\n");
  const before = await state(f.directory);
  assert.equal((await getRepositorySnapshot(f.directory)).isDirty, true);
  assert.equal(await exists(f.marker), false);
  assert.deepEqual(await state(f.directory), before);
});

test("Git inspection disables built-in fsmonitor configuration without starting a daemon", async (t) => {
  const f = await fixture(t);
  f.configure("local", "core.fsmonitor", "true");
  const before = await state(f.directory);
  assert.equal((await getRepositorySnapshot(f.directory)).isDirty, false);
  assert.equal(await exists(join(f.directory, ".git", "fsmonitor--daemon")), false);
  assert.deepEqual(await state(f.directory), before);
});

for (const kind of ["malformed", "missing-object"] as const) {
  test(`Git inspection refuses ${kind} HEAD instead of treating it as unborn`, async (t) => {
    const f = await fixture(t);
    const value = kind === "malformed" ? "invalid reference\n" : `${"f".repeat(40)}\n`;
    await writeFile(join(f.directory, ".git", "HEAD"), value);
    await assertRefused(f);
    assert.equal(await readFile(join(f.directory, ".git", "HEAD"), "utf8"), value);
  });
}

async function submodule(f: Awaited<ReturnType<typeof fixture>>, parent = f.directory) {
  const nested = await f.repository(join(parent, "nested"));
  const head = f.git(nested, ["rev-parse", "HEAD"]).trim();
  await writeFile(join(parent, ".gitmodules"), [
    '[submodule "nested"]', '\tpath = nested', '\turl = ./nested', '\tignore = all', ""
  ].join("\n"));
  f.git(parent, ["add", ".gitmodules"]);
  f.git(parent, ["update-index", "--add", "--cacheinfo", `160000,${head},nested`]);
  f.git(parent, ["commit", "--quiet", "-m", "Synthetic submodule"]);
  return nested;
}

test("Git inspection disables submodule fsmonitor and still observes submodule changes", async (t) => {
  const f = await fixture(t);
  const nested = await submodule(f);
  f.configure("local", "core.fsmonitor", f.markerCommand("fsmonitor"), nested);
  const before = await Promise.all([f.directory, nested].map(state));
  assert.equal((await getRepositorySnapshot(f.directory)).isDirty, false);
  await writeFile(join(nested, "tracked.txt"), "submodule changed\n");
  assert.equal((await getRepositorySnapshot(f.directory)).isDirty, true);
  assert.equal(await exists(f.marker), false);
  assert.deepEqual(await Promise.all([f.directory, nested].map(state)), before);
});

for (const filter of ["clean", "process"] as const) {
  test(`Git inspection refuses submodule ${filter} filters before parent status executes them`, async (t) => {
    const f = await fixture(t);
    const nested = await submodule(f);
    await f.filteredFile(nested);
    f.configure("local", `filter.probe.${filter}`, f.markerCommand(filter), nested);
    f.configure("local", "filter.probe.required", "true", nested);
    await assertRefused(f, [nested]);
  });
}

test("Git inspection refuses index flags hidden inside a submodule", async (t) => {
  const f = await fixture(t);
  const nested = await submodule(f);
  f.git(nested, ["update-index", "--assume-unchanged", "tracked.txt"]);
  await writeFile(join(nested, "tracked.txt"), "concealed submodule mismatch\n");
  await assertRefused(f, [nested]);
});

test("Git inspection preflights filters in recursively nested submodules", async (t) => {
  const f = await fixture(t);
  const nested = await submodule(f);
  const inner = await submodule(f, nested);
  await f.filteredFile(inner);
  f.configure("local", "filter.probe.process", f.markerCommand("process"), inner);
  f.configure("local", "filter.probe.required", "true", inner);
  await assertRefused(f, [nested, inner]);
});

test("Git inspection refuses a corrupt HEAD inside a submodule", async (t) => {
  const f = await fixture(t);
  const nested = await submodule(f);
  const value = `${"f".repeat(40)}\n`;
  await writeFile(join(nested, ".git", "HEAD"), value);
  await assertRefused(f, [nested]);
  assert.equal(await readFile(join(nested, ".git", "HEAD"), "utf8"), value);
});
