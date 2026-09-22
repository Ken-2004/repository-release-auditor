import assert from "node:assert/strict";
import childProcess, { type ChildProcess, type ExecFileOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test, { type TestContext } from "node:test";

import { createGitClient, GitCommandError, type GitClient } from "../src/git/git.js";
import { inspectRepository } from "../src/git/inspection.js";

async function fixture(t: TestContext): Promise<string> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "auditor-git-limits-")));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 3 }));
  return directory;
}

function assertBudgetRefusal(error: unknown): boolean {
  assert.ok(error instanceof GitCommandError);
  assert.equal(error.message, "Git inspection exceeded its execution budget.");
  assert.equal(error.stderr, "");
  assert.deepEqual(error.args, []);
  return true;
}

function mockExecution(t: TestContext) {
  const calls: { cwd: ExecFileOptions["cwd"]; timeout: number | undefined }[] = [];
  // Keep the real adapter, executable resolution, and budget accounting, but
  // replace process creation so boundary tests do not launch 512 subprocesses.
  const mocked = t.mock.method(childProcess, "execFile", ((...args: unknown[]) => {
    const options = args[2] as ExecFileOptions;
    const callback = args[3] as (
      error: null, stdout: string | Buffer, stderr: string | Buffer
    ) => void;
    calls.push({ cwd: options.cwd, timeout: options.timeout });
    const output = "git version 2.50.0\n";
    queueMicrotask(() => callback(null,
      options.encoding === "utf8" ? output : Buffer.from(output),
      options.encoding === "utf8" ? "" : Buffer.alloc(0)));
    return Object.assign(new EventEmitter(), { stdin: new PassThrough() }) as unknown as ChildProcess;
  }) as typeof childProcess.execFile);
  syncBuiltinESMExports();
  t.after(() => {
    mocked.mock.restore();
    syncBuiltinESMExports();
  });
  return calls;
}

test("Git shares its 60-second deadline across commands and worktrees", async (t) => {
  const root = await fixture(t);
  const calls = mockExecution(t);
  let elapsed = 0;
  t.mock.method(Date, "now", () => 1_000_000 + elapsed);
  const git = await createGitClient(root);
  assert.equal(calls[0]!.timeout, 10_000);

  elapsed = 50_001;
  await git.run(join(root, "first-submodule"), ["--version"]);
  assert.equal(calls.at(-1)!.timeout, 9_999);
  elapsed = 59_999;
  assert.equal((await git.tryRun(join(root, "second-submodule"), ["--version"])).ok, true);
  assert.equal(calls.at(-1)!.timeout, 1);

  elapsed = 60_000;
  await assert.rejects(() => git.run(root, ["--version"]), assertBudgetRefusal);
  await assert.rejects(() => git.tryRun(join(root, "third-submodule"), ["--version"]),
    assertBudgetRefusal);
  assert.equal(calls.length, 3, "expired commands must never reach process creation");
});

test("Git allows 512 total commands and refuses the next across run, tryRun, and worktrees", async (t) => {
  const root = await fixture(t);
  const calls = mockExecution(t);
  t.mock.method(Date, "now", () => 1_000_000);
  const git = await createGitClient(root);
  // The required version check consumes the first command in the same budget.
  for (let command = 2; command <= 512; command++) {
    if (command % 2 === 0) await git.run(root, ["--version"]);
    else assert.equal((await git.tryRun(join(root, "nested"), ["--version"])).ok, true);
  }
  assert.equal(calls.length, 512);
  await assert.rejects(() => git.run(join(root, "another-worktree"), ["--version"]),
    assertBudgetRefusal);
  await assert.rejects(() => git.tryRun(root, ["--version"]), assertBudgetRefusal);
  assert.equal(calls.length, 512, "over-budget commands must never reach process creation");
});

async function traversalFixture(t: TestContext) {
  const root = await fixture(t);
  await mkdir(join(root, ".git"));
  const children = new Map<string, string[]>([[root, []]]);
  const inspected: string[] = [];
  const oid = "a".repeat(40);
  const git: GitClient = {
    async run(directory, args) {
      assert.ok(children.has(directory), "inspection must stay inside the synthetic tree");
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
        inspected.push(directory);
        return `${directory}\n`;
      }
      if (args[0] === "ls-files") {
        return children.get(directory)!.map((name) => `H 160000 ${oid} 0\t${name}\0`).join("");
      }
      if (args[0] === "check-attr") return "";
      assert.fail(`Unexpected synthetic Git command: ${args[0]}`);
    },
    async tryRun(directory, args) {
      assert.ok(children.has(directory));
      if (args[0] === "config") return { ok: false, stdout: "", stderr: "", exitCode: 1 };
      if (args[0] === "rev-parse" && args[1] === "--verify") {
        return { ok: true, stdout: `${oid}\n`, stderr: "", exitCode: 0 };
      }
      assert.fail(`Unexpected synthetic Git command: ${args[0]}`);
    }
  };
  async function add(parent: string, name: string): Promise<string> {
    const directory = join(parent, name);
    await mkdir(join(directory, ".git"), { recursive: true });
    children.get(parent)!.push(name);
    children.set(directory, []);
    return directory;
  }
  return { root, git, inspected, add };
}

function assertTraversalRefusal(error: unknown): boolean {
  assert.ok(error instanceof GitCommandError);
  assert.equal(error.message, "Submodule inspection exceeded its supported limits.");
  assert.equal(error.stderr, "");
  assert.deepEqual(error.args, []);
  return true;
}

for (const depth of [16, 17]) {
  test(`Submodule traversal ${depth === 16 ? "allows depth 16" : "refuses depth 17 before inspecting it"}`,
    async (t) => {
      const f = await traversalFixture(t);
      let deepest = f.root;
      for (let level = 1; level <= depth; level++) deepest = await f.add(deepest, "nested");
      if (depth === 16) {
        assert.equal((await inspectRepository(f.git, f.root)).root, f.root);
        assert.equal(f.inspected.at(-1), deepest);
      } else {
        await assert.rejects(() => inspectRepository(f.git, f.root), assertTraversalRefusal);
        assert.equal(f.inspected.includes(deepest), false);
      }
      assert.equal(f.inspected.length, 17, "root is depth zero; depth 16 includes 17 worktrees");
    });
}

for (const count of [128, 129]) {
  test(`Submodule traversal ${count === 128 ? "allows 128 repositories" : "refuses repository 129"} across sibling branches`,
    async (t) => {
      const f = await traversalFixture(t);
      const first = await f.add(f.root, "first");
      const second = await f.add(f.root, "second");
      for (let i = 0; i < 63; i++) await f.add(first, `child-${i}`);
      let last = second;
      for (let i = 0; i < count - 66; i++) last = await f.add(second, `child-${i}`);
      if (count === 128) {
        assert.equal((await inspectRepository(f.git, f.root)).root, f.root);
        assert.equal(f.inspected.at(-1), last);
      } else {
        await assert.rejects(() => inspectRepository(f.git, f.root), assertTraversalRefusal);
        assert.equal(f.inspected.includes(last), false);
      }
      assert.equal(f.inspected.length, 128, "the root and every recursive branch share one count");
      assert.equal(new Set(f.inspected).size, 128);
    });
}
