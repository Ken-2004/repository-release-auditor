import assert from "node:assert/strict";
import childProcess, { type ChildProcess, type ExecFileOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmod, mkdir, mkdtemp, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { PassThrough } from "node:stream";
import test, { type TestContext } from "node:test";

import { createGitClient, GitCommandError } from "../src/git/git.js";

const executableName = process.platform === "win32" ? "git.exe" : "git";

async function fixture(t: TestContext): Promise<string> {
  // Keep the original spelling: direct clients must resolve their own root.
  const directory = await mkdtemp(join(tmpdir(), "auditor-git-path-boundary-"));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 3 }));
  return directory;
}

async function directoryAlias(target: string, alias: string): Promise<void> {
  await symlink(target, alias, process.platform === "win32" ? "junction" : "dir");
  assert.notEqual(alias, await realpath(target));
  assert.equal(await realpath(alias), await realpath(target));
}

async function inertExecutable(directory: string): Promise<string> {
  const candidate = join(directory, executableName);
  await writeFile(candidate, "synthetic non-executable fixture\n");
  await chmod(candidate, 0o755);
  return candidate;
}

async function withPath(searchPath: string, run: () => Promise<void>): Promise<void> {
  const previous = process.env.PATH;
  try {
    process.env.PATH = searchPath;
    await run();
  } finally {
    if (previous === undefined) delete process.env.PATH;
    else process.env.PATH = previous;
  }
}

function mockExecution(t: TestContext) {
  const calls: { executable: string; path: string }[] = [];
  // Resolution still uses the real filesystem. Record process creation so no
  // synthetic executable can run, including when this regression is present.
  const mocked = t.mock.method(childProcess, "execFile", ((...args: unknown[]) => {
    const options = args[2] as ExecFileOptions;
    const callback = args[3] as (error: null, stdout: Buffer, stderr: Buffer) => void;
    calls.push({ executable: args[0] as string, path: options.env?.PATH ?? "" });
    queueMicrotask(() => callback(null, Buffer.from("git version 2.50.0\n"), Buffer.alloc(0)));
    return Object.assign(new EventEmitter(), { stdin: new PassThrough() }) as unknown as ChildProcess;
  }) as typeof childProcess.execFile);
  syncBuiltinESMExports();
  t.after(() => {
    mocked.mock.restore();
    syncBuiltinESMExports();
  });
  return calls;
}

function assertTrustedGitRefusal(error: unknown): boolean {
  assert.ok(error instanceof GitCommandError);
  assert.equal(error.message, "A trusted Git executable was not found on PATH.");
  assert.deepEqual(error.args, []);
  assert.equal(error.stderr, "");
  assert.equal(error.exitCode, null);
  return true;
}

test("Direct Git clients refuse target executables through alternate root and PATH spellings", async (t) => {
  const directory = await fixture(t);
  const target = join(directory, "target");
  const alias = join(directory, "target-alias");
  await mkdir(target);
  await directoryAlias(target, alias);
  await inertExecutable(target);
  const calls = mockExecution(t);
  for (const root of [target, alias]) {
    for (const entry of [target, alias]) {
      await withPath(["", ".", entry].join(delimiter), async () => {
        await assert.rejects(() => createGitClient(root), assertTrustedGitRefusal);
      });
    }
  }
  assert.equal(calls.length, 0, "no spelling of a target-owned executable may reach process creation");
});

test("Direct Git clients with an aliased root skip target candidates and use the installed Git", async (t) => {
  const directory = await fixture(t);
  const target = join(directory, "target");
  const alias = join(directory, "target-alias");
  await mkdir(target);
  await directoryAlias(target, alias);
  await inertExecutable(target);
  const trustedPath = process.env.PATH ?? "";
  await withPath([target, alias, trustedPath].join(delimiter), async () => {
    const git = await createGitClient(alias);
    assert.match(await git.run(alias, ["--version"]), /^git version /);
  });
});

test("Child Git PATH resolves external aliases and excludes target aliases and unusable entries", async (t) => {
  const directory = await fixture(t);
  const target = join(directory, "target");
  const nested = join(target, "nested");
  const targetAlias = join(directory, "target-alias");
  const nestedAlias = join(directory, "nested-alias");
  const install = join(directory, "external-git");
  const installAlias = join(directory, "external-git-alias");
  const helpers = join(directory, "external-child-tools");
  const helpersAlias = join(directory, "external-child-tools-alias");
  const nonDirectory = join(directory, "regular-file-path-entry");
  await mkdir(nested, { recursive: true });
  await mkdir(install);
  await mkdir(helpers);
  await directoryAlias(target, targetAlias);
  await directoryAlias(nested, nestedAlias);
  await directoryAlias(install, installAlias);
  await directoryAlias(helpers, helpersAlias);
  await inertExecutable(target);
  const executable = await inertExecutable(install);
  await writeFile(join(helpers, "synthetic-child-tool"), "harmless helper fixture\n");
  await writeFile(nonDirectory, "synthetic non-directory fixture\n");
  const calls = mockExecution(t);
  await withPath([
    "", ".", target, targetAlias, nested, nestedAlias,
    join(directory, "missing"), nonDirectory, installAlias, helpersAlias
  ].join(delimiter), async () => {
    const git = await createGitClient(targetAlias);
    await git.run(targetAlias, ["--version"]);
  });
  const canonicalInstall = await realpath(install);
  const canonicalHelpers = await realpath(helpers);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.executable, await realpath(executable));
    const entries = call.path.split(delimiter);
    assert.equal(entries[0], canonicalInstall, "child commands prefer the selected Git installation");
    assert.deepEqual(new Set(entries), new Set([canonicalInstall, canonicalHelpers]));
    for (const entry of entries) {
      assert.equal(entry, await realpath(entry), "retained entries use filesystem-resolved spellings");
    }
  }
});

test("An unresolved direct Git client root fails through a fixed redacted boundary", async (t) => {
  const directory = await fixture(t);
  const root = join(directory, "SYNTHETIC_PRIVATE_MISSING_ROOT");
  const calls = mockExecution(t);
  await assert.rejects(() => createGitClient(root), (error: unknown) => {
    assert.ok(error instanceof GitCommandError);
    assert.equal(error.message, "The Git inspection root could not be resolved safely.");
    assert.deepEqual(error.args, []);
    assert.equal(error.stderr, "");
    assert.equal(error.exitCode, null);
    return true;
  });
  assert.equal(calls.length, 0, "an unresolved trust boundary must prevent execution");
});

test("Git containment keeps case-distinct POSIX directories separate", {
  skip: process.platform === "win32" ? "POSIX case-sensitive path semantics" : false
}, async (t) => {
  const directory = await fixture(t);
  const target = join(directory, "target");
  const external = join(directory, "TARGET");
  await mkdir(target);
  await mkdir(external);
  assert.notEqual((await stat(target)).ino, (await stat(external)).ino);
  const executable = await inertExecutable(external);
  const calls = mockExecution(t);
  await withPath(external, async () => {
    await createGitClient(target);
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.executable, await realpath(executable));
  assert.deepEqual(new Set(calls[0]!.path.split(delimiter)), new Set([await realpath(external)]));
});

test("An external PATH directory cannot supply an executable symlink into the target", {
  skip: process.platform === "win32" ? "POSIX executable symlink fixture" : false
}, async (t) => {
  const directory = await fixture(t);
  const target = join(directory, "target");
  const external = join(directory, "external");
  await mkdir(target);
  await mkdir(external);
  const targetExecutable = await inertExecutable(target);
  await symlink(targetExecutable, join(external, executableName));
  const calls = mockExecution(t);
  await withPath(external, async () => {
    await assert.rejects(() => createGitClient(target), assertTrustedGitRefusal);
  });
  assert.equal(calls.length, 0, "the resolved executable needs its own containment check");
});
