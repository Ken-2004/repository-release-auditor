import assert from "node:assert/strict";
import { execFileSync, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import { MAX_TEXT_FILE_BYTES } from "../src/files/tracked-text.js";

const cliPath = fileURLToPath(new URL("../src/cli.js", import.meta.url));

async function fixture(t: TestContext) {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "repository auditor cli-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true, maxRetries: 3 }));
  const directory = join(temporaryRoot, "repository");
  const emptyConfig = join(temporaryRoot, "empty-config");
  await mkdir(directory);
  await writeFile(emptyConfig, "");

  // Keep the real PATH, but isolate Git from the caller's repository and config.
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key))
  );
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_GLOBAL = emptyConfig;
  env.GIT_CEILING_DIRECTORIES = temporaryRoot;
  env.GIT_TERMINAL_PROMPT = "0";
  env.LC_ALL = "C";

  function git(args: string[], cwd = directory): string {
    return execFileSync("git", [
      "-c", "user.name=Repository Auditor Test",
      "-c", "user.email=repository-auditor@example.invalid",
      ...args
    ], { cwd, env, encoding: "utf8", windowsHide: true, stdio: "pipe" });
  }

  function cli(args: string[] = [directory], cliEnv = env) {
    const result = spawnSync(process.execPath, [cliPath, ...args], {
      cwd: directory,
      env: cliEnv,
      encoding: "utf8",
      windowsHide: true,
      timeout: 30_000
    });
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    return result;
  }

  function init(cwd = directory) {
    git(["init", "--quiet", "--template=", "-b", "main"], cwd);
    git(["config", "core.autocrlf", "false"], cwd);
    git(["config", "core.excludesFile", emptyConfig], cwd);
    git(["config", "core.attributesFile", emptyConfig], cwd);
  }

  async function commitFile() {
    await writeFile(join(directory, "tracked.txt"), "original\n");
    git(["add", "tracked.txt"]);
    git(["commit", "--quiet", "-m", "fixture"]);
  }

  return { directory, env, git, cli, init, commitFile };
}

function assertClean(result: SpawnSyncReturns<string>) {
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\nNo findings\.\r?\n$/);
  assert.doesNotMatch(result.stdout, /git-cleanliness/);
  assert.equal(result.stderr, "");
}

function assertDirty(result: SpawnSyncReturns<string>) {
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /\n1 finding:\r?\n/);
  assert.equal(result.stdout.match(/\[WARNING\] git-cleanliness/g)?.length, 1);
  assert.doesNotMatch(result.stdout, /No findings/);
  assert.equal(result.stderr, "");
}

test("CLI reports no findings for unborn, committed, and detached clean repositories", async (t) => {
  const f = await fixture(t);
  f.init();
  assertClean(f.cli());
  await f.commitFile();
  assertClean(f.cli([])); // The default path is the child process's cwd.
  f.git(["checkout", "--quiet", "--detach"]);
  assertClean(f.cli());
});

for (const state of ["untracked", "staged", "modified", "deleted", "renamed", "mixed"] as const) {
  test(`CLI reports one warning for ${state} changes`, async (t) => {
    const f = await fixture(t);
    f.init();
    await f.commitFile();
    if (state === "untracked" || state === "mixed") {
      f.git(["config", "status.showUntrackedFiles", "no"]);
      await writeFile(join(f.directory, "untracked file.txt"), "new\n");
    }
    if (state === "modified" || state === "staged" || state === "mixed") {
      await writeFile(join(f.directory, "tracked.txt"), "changed\n");
      if (state !== "modified") f.git(["add", "tracked.txt"]);
    }
    if (state === "deleted") await rm(join(f.directory, "tracked.txt"));
    if (state === "renamed") {
      await rename(join(f.directory, "tracked.txt"), join(f.directory, "renamed file.txt"));
      f.git(["add", "-A"]);
    }
    assertDirty(f.cli());
  });
}

test("CLI ignores intentionally ignored untracked files", async (t) => {
  const f = await fixture(t);
  f.init();
  await writeFile(join(f.directory, ".gitignore"), ".env\n");
  f.git(["add", ".gitignore"]);
  f.git(["commit", "--quiet", "-m", "ignore fixture"]);
  await writeFile(join(f.directory, ".env"), "ignored\n");
  assertClean(f.cli());
});

test("CLI detects dirty submodules even when Git config hides them", async (t) => {
  const f = await fixture(t);
  f.init();
  const nested = join(f.directory, "nested");
  await mkdir(nested);
  f.init(nested);
  await writeFile(join(nested, "file.txt"), "original\n");
  f.git(["add", "file.txt"], nested);
  f.git(["commit", "--quiet", "-m", "nested fixture"], nested);
  const head = f.git(["rev-parse", "HEAD"], nested).trim();
  await writeFile(join(f.directory, ".gitmodules"), '[submodule "nested"]\n\tpath = nested\n\turl = ./nested\n\tignore = all\n');
  f.git(["add", ".gitmodules"]);
  f.git(["update-index", "--add", "--cacheinfo", `160000,${head},nested`]);
  f.git(["commit", "--quiet", "-m", "submodule fixture"]);
  assertClean(f.cli());
  await writeFile(join(nested, "file.txt"), "changed\n");
  assertDirty(f.cli());
});

test("CLI reports non-Git directories on stderr and exits 2", async (t) => {
  const f = await fixture(t);
  const result = f.cli();
  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Repository scan could not start\./);
});

for (const args of [["--unknown-option"], [".", "extra-path"]]) {
  test(`CLI rejects invalid arguments: ${args.join(" ")}`, async (t) => {
    const f = await fixture(t);
    f.init();
    const result = f.cli(args);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
    assert.notEqual(result.stderr, "");
  });
}

test("CLI reports missing Git on stderr and exits 2", async (t) => {
  const f = await fixture(t);
  const env = Object.fromEntries(
    Object.entries(f.env).filter(([key]) => key.toUpperCase() !== "PATH")
  );
  env.PATH = f.directory;
  const result = f.cli([], env);
  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Repository scan could not start\./);
});

const sensitiveFixtureContent = "DO_NOT_PRINT_FIXTURE_CREDENTIAL_726491";

function assertRiskyPaths(result: SpawnSyncReturns<string>, paths: string[]) {
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout.match(/\[WARNING\] risky-tracked-file/g)?.length, paths.length);
  assert.deepEqual(
    result.stdout.split(/\r?\n/).filter((line) => line.startsWith("Path: "))
      .map((line) => line.slice(6)),
    paths
  );
  assert.doesNotMatch(result.stdout, /git-cleanliness|No findings/);
  assert.equal((result.stdout + result.stderr).includes(sensitiveFixtureContent), false);
}

for (const path of [
  ".env", ".env.production", "id_ed25519", "private-key.pem",
  "client.p12", "client.pfx", "nested directory/.ENV.Production"
]) {
  test(`CLI warns about committed ${path} without revealing contents`, async (t) => {
    const f = await fixture(t);
    f.init();
    const file = join(f.directory, ...path.split("/"));
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, sensitiveFixtureContent);
    f.git(["add", "--", path]);
    f.git(["commit", "--quiet", "-m", "risky path fixture"]);
    assertRiskyPaths(f.cli(), [path]);
  });
}

test("CLI accepts committed ordinary files, env templates, and public certificates", async (t) => {
  const f = await fixture(t);
  f.init();
  for (const path of [
    "README.md", "auth.json", "config.json", "settings.yml",
    ".env.example", ".env.sample", ".env.template", ".env.production.example",
    "public.crt", "public.cer", "public.pem", "id_rsa.pub"
  ]) {
    await writeFile(join(f.directory, path), sensitiveFixtureContent);
  }
  f.git(["add", "."]);
  f.git(["commit", "--quiet", "-m", "ordinary paths fixture"]);
  assertClean(f.cli());
});

test("CLI reports multiple risky paths in deterministic order", async (t) => {
  const f = await fixture(t);
  f.init();
  for (const path of ["secrets.json", "nested/.env.production", ".aws/config"]) {
    const file = join(f.directory, ...path.split("/"));
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, sensitiveFixtureContent);
  }
  f.git(["add", "."]);
  f.git(["commit", "--quiet", "-m", "multiple risky paths fixture"]);
  const first = f.cli();
  assertRiskyPaths(first, [".aws/config", "nested/.env.production", "secrets.json"]);
  assert.equal(f.cli().stdout, first.stdout);
});

test("CLI reports a force-tracked ignored env file alongside the cleanliness warning", async (t) => {
  const f = await fixture(t);
  f.init();
  await writeFile(join(f.directory, ".gitignore"), ".env\n");
  f.git(["add", ".gitignore"]);
  f.git(["commit", "--quiet", "-m", "ignore fixture"]);
  await writeFile(join(f.directory, ".env"), sensitiveFixtureContent);
  f.git(["add", "--force", ".env"]);
  const result = f.cli();
  assert.equal(result.status, 1);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /\n2 findings:\r?\n/);
  assert.equal(result.stdout.match(/\[WARNING\] git-cleanliness/g)?.length, 1);
  assert.equal(result.stdout.match(/\[WARNING\] risky-tracked-file/g)?.length, 1);
  assert.match(result.stdout, /\nPath: \.env\r?\n/);
  assert.equal((result.stdout + result.stderr).includes(sensitiveFixtureContent), false);
});

const aliceProjectPath = ["/home", "alice", "project"].join("/");

test("CLI reports machine paths once per file with deterministic, redacted evidence", async (t) => {
  const f = await fixture(t);
  f.init();
  await mkdir(join(f.directory, "nested"));
  await writeFile(join(f.directory, "nested", "build.txt"), [
    `unrelated ${sensitiveFixtureContent}`,
    ["C:", "Users", "PrivateAlice", "PrivateProject"].join("\\"),
    ["/home", "PrivateBob", "OtherProject"].join("/")
  ].join("\n"));
  await writeFile(join(f.directory, "a.txt"), ["/mnt/c", "Users", "PrivateCarol", "HiddenProject"].join("/"));
  f.git(["add", "."]);
  f.git(["commit", "--quiet", "-m", "machine path fixtures"]);
  const result = f.cli();
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /\n2 findings:\r?\n/);
  assert.equal(result.stdout.match(/\[WARNING\] developer-machine-path/g)?.length, 2);
  assert.deepEqual(result.stdout.split(/\r?\n/).filter((line) => line.startsWith("Path: ")), [
    "Path: a.txt", "Path: nested/build.txt"
  ]);
  assert.match(result.stdout, /Evidence: Line 1: WSL home path; value redacted\./);
  assert.match(result.stdout, /Evidence: Line 2: Windows drive path; value redacted\./);
  assert.doesNotMatch(result.stdout, /PrivateAlice|PrivateBob|PrivateCarol|PrivateProject|OtherProject|HiddenProject|git-cleanliness/);
  assert.equal((result.stdout + result.stderr).includes(sensitiveFixtureContent), false);
  assert.equal(f.cli().stdout, result.stdout);
});

test("CLI accepts relative paths, URLs, system paths, and explicit placeholders", async (t) => {
  const f = await fixture(t);
  f.init();
  await writeFile(join(f.directory, "README.md"), [
    "./src/index.ts", "../config/file.json", `https://example.com${aliceProjectPath}`,
    `https://example.com/?file=${["C:", "Users", "Alice", "project"].join("/")}`, "/usr/local/bin", "/var/log/app",
    "/home/<user>/project", "/Users/${USER}/project", "C:/Users/%USERNAME%/project"
  ].join("\n"));
  f.git(["add", "README.md"]);
  f.git(["commit", "--quiet", "-m", "portable fixtures"]);
  assertClean(f.cli());
});

test("CLI safely skips binary, unsupported, and oversized tracked files", async (t) => {
  const f = await fixture(t);
  f.init();
  await writeFile(join(f.directory, "binary.txt"), Buffer.from(`\0${aliceProjectPath}`));
  await writeFile(join(f.directory, "data.bin"), aliceProjectPath);
  const oversized = Buffer.alloc(MAX_TEXT_FILE_BYTES + 1, 65);
  oversized.write(`${aliceProjectPath}\n`);
  await writeFile(join(f.directory, "oversized.txt"), oversized);
  f.git(["add", "."]);
  f.git(["commit", "--quiet", "-m", "skipped content fixtures"]);
  assertClean(f.cli());
});

test("CLI does not scan ignored or untracked text files", async (t) => {
  const f = await fixture(t);
  f.init();
  await writeFile(join(f.directory, ".gitignore"), "local.txt\n");
  f.git(["add", ".gitignore"]);
  f.git(["commit", "--quiet", "-m", "ignore fixture"]);
  await writeFile(join(f.directory, "local.txt"), ["/home", "alice", "private"].join("/"));
  assertClean(f.cli());
  await writeFile(join(f.directory, "untracked.txt"), ["/home", "bob", "private"].join("/"));
  const result = f.cli();
  assertDirty(result);
  assert.doesNotMatch(result.stdout, /developer-machine-path|alice|bob/);
});

test("CLI warns about tracked generated and compiled paths in deterministic order", async (t) => {
  const f = await fixture(t);
  f.init();
  const paths = [
    "node_modules/package/index.js", "coverage/lcov.info", ".next/server/app.js",
    "__pycache__/module.pyc", "obj/project.obj", "dist/app.js", "build/app.exe",
    "lib/native.DLL", "lib/native.so", "lib/native.dylib", "lib/Main.class",
    "packages/web/.nuxt/app.js", "crate/target/release/app"
  ];
  for (const path of paths) {
    const file = join(f.directory, ...path.split("/"));
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, "fixture\n");
  }
  f.git(["add", "."]);
  f.git(["commit", "--quiet", "-m", "generated paths fixture"]);
  const result = f.cli();
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /\n13 findings:\r?\n/);
  assert.equal(result.stdout.match(/\[WARNING\] suspicious-build-output/g)?.length, paths.length);
  assert.deepEqual(
    result.stdout.split(/\r?\n/).filter((line) => line.startsWith("Path: ")).map((line) => line.slice(6)),
    paths.toSorted()
  );
  assert.doesNotMatch(result.stdout, /git-cleanliness|risky-tracked-file|developer-machine-path/);
  assert.equal(f.cli().stdout, result.stdout);
});

test("CLI accepts ordinary source paths, archives, documents, and media", async (t) => {
  const f = await fixture(t);
  f.init();
  for (const path of [
    "src/build.ts", "docs/coverage.md", "config/dist-config.json", "examples/target.ts",
    "tests/build.ts", "fixtures/build.ts", "assets/coverage.md", "release.zip",
    "assets/release.tar", "assets/release.gz", "assets/library.jar", "docs/guide.pdf",
    "assets/image.png", "assets/audio.mp3", "assets/video.mp4"
  ]) {
    const file = join(f.directory, ...path.split("/"));
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, "dist/app.js\n"); // Suspicious paths in contents do not trigger this rule.
  }
  f.git(["add", "."]);
  f.git(["commit", "--quiet", "-m", "ordinary paths fixture"]);
  assertClean(f.cli());
});

test("CLI excludes ignored and untracked generated paths but detects force-tracked output", async (t) => {
  const f = await fixture(t);
  f.init();
  await writeFile(join(f.directory, ".gitignore"), "dist/\n");
  f.git(["add", ".gitignore"]);
  f.git(["commit", "--quiet", "-m", "ignore fixture"]);
  await mkdir(join(f.directory, "dist"));
  await writeFile(join(f.directory, "dist", "app.js"), "fixture\n");
  assertClean(f.cli());
  await mkdir(join(f.directory, "build"));
  await writeFile(join(f.directory, "build", "app.exe"), "fixture\n");
  const untracked = f.cli();
  assertDirty(untracked);
  assert.doesNotMatch(untracked.stdout, /suspicious-build-output/);
  f.git(["add", "--force", "dist/app.js"]);
  const tracked = f.cli();
  assert.equal(tracked.status, 1);
  assert.equal(tracked.stderr, "");
  assert.match(tracked.stdout, /\n2 findings:\r?\n/);
  assert.equal(tracked.stdout.match(/\[WARNING\] suspicious-build-output/g)?.length, 1);
  assert.match(tracked.stdout, /\nPath: dist\/app\.js\r?\n/);
  assert.doesNotMatch(tracked.stdout, /Path: build\/app\.exe/);
});
