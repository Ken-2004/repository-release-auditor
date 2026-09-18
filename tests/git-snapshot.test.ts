import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtemp,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { GitCommandError } from "../src/git/git.js";
import { getRepositorySnapshot } from "../src/git/snapshot.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true
  });
}

test("captures repository state across an ordinary Git workflow", async (t) => {
  const directory = await mkdtemp(
    join(tmpdir(), "repository-release-auditor-")
  );

  t.after(async () => {
    await rm(directory, {
      recursive: true,
      force: true
    });
  });

  git(directory, ["init", "-b", "main"]);
  git(directory, ["config", "core.autocrlf", "false"]);

  const empty = await getRepositorySnapshot(directory);

  assert.equal(empty.branch, "main");
  assert.equal(empty.head, null);
  assert.deepEqual(empty.trackedFiles, []);
  assert.equal(empty.isDirty, false);

  await writeFile(
    join(directory, "example.txt"),
    "first version\n",
    "utf8"
  );

  const untracked = await getRepositorySnapshot(directory);

  assert.equal(untracked.isDirty, true);
  assert.equal(
    untracked.statusEntries.some((entry) =>
      entry.includes("example.txt")
    ),
    true
  );

  git(directory, ["config", "user.name", "Repository Auditor Test"]);
  git(directory, [
    "config",
    "user.email",
    "repository-auditor@example.invalid"
  ]);
  git(directory, ["add", "example.txt"]);
  git(directory, ["commit", "-m", "test fixture"]);

  const committed = await getRepositorySnapshot(directory);

  assert.equal(committed.branch, "main");
  assert.match(committed.head ?? "", /^[0-9a-f]{40}$/);
  assert.deepEqual(committed.trackedFiles, ["example.txt"]);
  assert.equal(committed.isDirty, false);

  await writeFile(
    join(directory, "example.txt"),
    "modified version\n",
    "utf8"
  );

  const modified = await getRepositorySnapshot(directory);

  assert.equal(modified.isDirty, true);
});

test("rejects a directory that is not inside a Git repository", async (t) => {
  const directory = await mkdtemp(
    join(tmpdir(), "repository-release-auditor-non-git-")
  );

  t.after(async () => {
    await rm(directory, {
      recursive: true,
      force: true
    });
  });

  await assert.rejects(
    () => getRepositorySnapshot(directory),
    GitCommandError
  );
});
