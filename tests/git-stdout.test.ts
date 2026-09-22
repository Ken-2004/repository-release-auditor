import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { createGitClient, GitCommandError } from "../src/git/git.js";

async function fixture(t: TestContext) {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "auditor-git-stdout-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true, maxRetries: 3 }));
  const directory = join(temporaryRoot, "repository");
  const syntheticHome = join(temporaryRoot, "home");
  const xdg = join(temporaryRoot, "xdg");
  await Promise.all([directory, syntheticHome, xdg].map((path) => mkdir(path)));
  const savedEnvironment = process.env;
  process.env = {
    ...Object.fromEntries(Object.entries(savedEnvironment).filter(([key]) => !/^GIT_/i.test(key))),
    HOME: syntheticHome,
    USERPROFILE: syntheticHome,
    XDG_CONFIG_HOME: xdg,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C"
  };
  t.after(() => { process.env = savedEnvironment; });
  function git(args: string[], input?: Buffer): Buffer {
    return execFileSync("git", args, {
      cwd: directory, env: process.env, input,
      windowsHide: true, stdio: "pipe", timeout: 10_000
    });
  }
  git(["init", "--quiet", "--template=", "-b", "main"]);
  const client = await createGitClient(directory);
  function blob(bytes: Buffer): string[] {
    const oid = git(["hash-object", "-w", "--stdin"], bytes).toString("ascii").trim();
    const args = ["cat-file", "blob", oid];
    // Verify Git emits the exact bytes through a real child-process pipe.
    assert.deepEqual(git(args), bytes);
    return args;
  }
  return { directory, client, blob };
}

const malformed: readonly [string, readonly number[]][] = [
  ["standalone FF", [0xff]],
  ["lone continuation byte", [0x80]],
  ["overlong encoding", [0xc0, 0xaf]],
  ["truncated multibyte encoding", [0xf0, 0x90, 0x80]],
  ["encoded surrogate", [0xed, 0xa0, 0x80]],
  ["code point above U+10FFFF", [0xf4, 0x90, 0x80, 0x80]]
];

for (const [description, sequence] of malformed) {
  test(`Git run and tryRun reject ${description} before decoding stdout`, async (t) => {
    const f = await fixture(t);
    const privateText = "SYNTHETIC_PRIVATE_STDOUT_SENTINEL";
    const args = f.blob(Buffer.concat([
      Buffer.from(`${privateText}\0before-`), Buffer.from(sequence), Buffer.from("-after\0")
    ]));
    for (const method of ["run", "tryRun"] as const) {
      await assert.rejects(() => f.client[method](f.directory, args), (error: unknown) => {
        assert.ok(error instanceof GitCommandError);
        assert.equal(error.message, "Git output is not valid UTF-8; inspection cannot continue safely.");
        assert.equal(error.stderr, "");
        assert.equal(error.exitCode, null);
        assert.equal(String(error).includes(privateText), false);
        assert.equal(JSON.stringify(error).includes(privateText), false);
        return true;
      });
    }
  });
}

test("Git stdout preserves valid Unicode, literal U+FFFD, BOM, and NUL exactly", async (t) => {
  const f = await fixture(t);
  const output = "\uFEFF\0café-日本語-😀-e\u0301-\uFFFD\0tail\n";
  const bytes = Buffer.from(output, "utf8");
  const args = f.blob(bytes);
  const result = await f.client.tryRun(f.directory, args);
  assert.equal(result.ok, true);
  assert.equal(result.stdout, output);
  assert.equal(result.stderr, "");
  assert.deepEqual(Buffer.from(result.stdout, "utf8"), bytes);
  assert.equal(await f.client.run(f.directory, args), output);
});
