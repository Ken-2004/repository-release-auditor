import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test, { type TestContext } from "node:test";

import { createGitClient, GitCommandError } from "../src/git/git.js";

async function fixture(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "auditor-git-execution-"));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true, maxRetries: 3 });
  });
  return directory;
}

async function withEnvironment(
  changes: Record<string, string>,
  run: () => Promise<void>
): Promise<void> {
  const previous = new Map(Object.keys(changes).map((key) => [key, process.env[key]]));
  try {
    Object.assign(process.env, changes);
    await run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("Git resolution refuses relative PATH entries and target-owned executables", async (t) => {
  const directory = await fixture(t);
  const candidate = join(directory, process.platform === "win32" ? "git.exe" : "git");
  await writeFile(candidate, "synthetic non-executable fixture\n");
  await chmod(candidate, 0o755);
  await withEnvironment({ PATH: ["", ".", directory].join(delimiter) }, async () => {
    await assert.rejects(() => createGitClient(directory), (error: unknown) => {
      assert.ok(error instanceof GitCommandError);
      assert.equal(error.message, "A trusted Git executable was not found on PATH.");
      return true;
    });
  });
});

test("Git resolution skips target-owned candidates before using the trusted installation", async (t) => {
  const directory = await fixture(t);
  const candidate = join(directory, process.platform === "win32" ? "git.exe" : "git");
  await writeFile(candidate, "synthetic non-executable fixture\n");
  await chmod(candidate, 0o755);
  const trustedPath = process.env.PATH ?? "";
  await withEnvironment({ PATH: directory + delimiter + trustedPath }, async () => {
    const git = await createGitClient(directory);
    assert.match(await git.run(directory, ["--version"]), /^git version /);
  });
});

test("Git retains protected global safe.directory configuration without inherited injection", async (t) => {
  const directory = await fixture(t);
  const home = join(directory, "synthetic-home");
  const xdg = join(home, "xdg");
  await mkdir(xdg, { recursive: true });
  const permitted = ["synthetic", "ownership", "exception"].join("-");
  await writeFile(join(home, ".gitconfig"), `[safe]\n\tdirectory = ${permitted}\n`);
  await withEnvironment({
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: xdg,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "safe.directory",
    GIT_CONFIG_VALUE_0: "*",
    GIT_CONFIG_GLOBAL: join(directory, "nonexistent-config")
  }, async () => {
    const git = await createGitClient(directory);
    const result = await git.run(directory,
      ["config", "--global", "--show-scope", "--get", "safe.directory"]);
    assert.equal(result.trim(), `global\t${permitted}`);
  });
});

test("Git rejects oversized command input before execution", async (t) => {
  const directory = await fixture(t);
  const git = await createGitClient(directory);
  await assert.rejects(
    () => git.run(directory, ["check-attr", "--stdin"], "x".repeat(10 * 1024 * 1024 + 1)),
    (error: unknown) => {
      assert.ok(error instanceof GitCommandError);
      assert.equal(error.message, "Git inspection exceeded its execution budget.");
      assert.equal(error.stderr, "");
      return true;
    }
  );
});

test("Git output overflow fails with a bounded diagnostic and no captured value", async (t) => {
  const directory = await fixture(t);
  const config = join(directory, "large-config");
  const marker = ["SYNTHETIC", "OUTPUT", "VALUE"].join("_");
  await writeFile(config, `[fixture]\nvalue = ${marker}${"x".repeat(11 * 1024 * 1024)}\n`);
  const git = await createGitClient(directory);
  await assert.rejects(() => git.run(directory, ["config", "--file", config, "--get", "fixture.value"]),
    (error: unknown) => {
      assert.ok(error instanceof GitCommandError);
      assert.equal(error.stderr, "");
      assert.equal(error.message.includes(marker), false);
      assert.ok(error.message.length < 200);
      return true;
    });
});

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

test("Git subprocess timeout fails within the execution limit", { timeout: 25_000 }, async (t) => {
  const directory = await fixture(t);
  const helper = join(directory, "synthetic-wait.mjs");
  const pidFile = join(directory, "synthetic-wait.pid");
  await writeFile(helper,
    'import { writeFileSync } from "node:fs";\n' +
    `writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\n` +
    "setTimeout(() => {}, 30_000);\n");
  const nodePath = process.platform === "win32" ? process.execPath.replace(/\\/g, "/") : process.execPath;
  const helperPath = process.platform === "win32" ? helper.replace(/\\/g, "/") : helper;
  const git = await createGitClient(directory);
  const started = performance.now();
  try {
    // Deliberately invoke a benign helper through the adapter to exercise its
    // process limit. Repository inspection never invokes this alias. Redirect
    // helper streams so descendants cannot retain Git's captured output pipes.
    await assert.rejects(() => git.run(directory, [
      "-c", `alias.synthetic-wait=!exec ${shellQuote(nodePath)} ${shellQuote(helperPath)} >/dev/null 2>&1 </dev/null`,
      "synthetic-wait"
    ]), (error: unknown) => {
      assert.ok(error instanceof GitCommandError);
      assert.equal(error.exitCode, null);
      assert.equal(error.stderr, "");
      return true;
    });
    assert.ok(performance.now() - started < 20_000);
  } finally {
    // The timeout kills Git itself; reap only this fixture's known helper.
    let pid: number | undefined;
    try {
      pid = Number(await readFile(pidFile, "utf8"));
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    if (pid !== undefined && Number.isSafeInteger(pid) && pid > 0) {
      try {
        process.kill(pid, "SIGKILL");
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
      }
    }
  }
});
