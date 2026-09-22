import assert from "node:assert/strict";
import { mkdir, mkdtemp, open, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";

import { getTrackedFileSize } from "../src/files/tracked-file-size.js";
import { LARGE_TRACKED_FILE_BYTES, largeTrackedFileRule } from "../src/rules/large-tracked-file.js";
import type { GitRepositorySnapshot } from "../src/git/snapshot.js";

async function fixture(t: TestContext) {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "auditor-large-file-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true, maxRetries: 3 }));
  const root = join(temporaryRoot, "repository");
  await mkdir(root);
  const repository: GitRepositorySnapshot = {
    root, branch: "main", head: null, trackedFiles: [], statusEntries: [], isDirty: false
  };
  return { temporaryRoot, root, repository };
}

async function sizedFile(path: string, size: number) {
  await mkdir(dirname(path), { recursive: true });
  const handle = await open(path, "w");
  try {
    await handle.truncate(size);
  } finally {
    await handle.close();
  }
}

for (const [size, expectedCount] of [
  [50 * 1024 * 1024 - 1, 0], [50 * 1024 * 1024, 1], [50 * 1024 * 1024 + 1, 1]
] as const) {
  test(`large file threshold: ${size} bytes produces ${expectedCount} finding`, async (t) => {
    const f = await fixture(t);
    assert.equal(LARGE_TRACKED_FILE_BYTES, 52_428_800);
    await sizedFile(join(f.root, "data.bin"), size);
    f.repository.trackedFiles = ["data.bin"];
    assert.equal(getTrackedFileSize(f.root, "data.bin"), size);
    const findings = largeTrackedFileRule.run({ repository: f.repository });
    assert.equal(findings.length, expectedCount);
    if (expectedCount === 1) assert.equal(findings[0]?.evidence, `${size} bytes`);
  });
}

test("large files are unique, sorted, case-preserving, and independent of filename or extension", async (t) => {
  const f = await fixture(t);
  const paths = ["z.txt", "nested/Photo.JPG", "Dataset", "a.custom"];
  for (const path of paths) await sizedFile(join(f.root, ...path.split("/")), LARGE_TRACKED_FILE_BYTES);
  const trackedFiles = [...paths, "nested/Photo.JPG", "./nested/Photo.JPG"];
  f.repository.trackedFiles = trackedFiles;
  const before = [...trackedFiles];
  const findings = largeTrackedFileRule.run({ repository: f.repository });
  assert.deepEqual(findings.map((finding) => finding.path), paths.toSorted());
  assert.deepEqual(largeTrackedFileRule.run({ repository: {
    ...f.repository, trackedFiles: trackedFiles.toReversed()
  } }), findings);
  assert.deepEqual(trackedFiles, before);
  for (const finding of findings) {
    assert.equal(finding.ruleId, "large-tracked-file");
    assert.equal(finding.category, "repository");
    assert.equal(finding.severity, "warning");
    assert.equal(finding.evidence, "52428800 bytes");
  }
});

test("only tracked paths are measured, including an empty ordinary file", async (t) => {
  const f = await fixture(t);
  await sizedFile(join(f.root, "untracked.bin"), LARGE_TRACKED_FILE_BYTES + 1);
  await writeFile(join(f.root, "empty.txt"), "");
  f.repository.trackedFiles = ["empty.txt"];
  assert.equal(getTrackedFileSize(f.root, "empty.txt"), 0);
  assert.deepEqual(largeTrackedFileRule.run({ repository: f.repository }), []);
});

test("missing paths and directories, including submodule-like directories, are skipped", async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.root, "submodule"));
  await writeFile(join(f.root, "submodule", ".git"), "gitdir: elsewhere\n");
  await sizedFile(join(f.root, "submodule", "large.bin"), LARGE_TRACKED_FILE_BYTES);
  f.repository.trackedFiles = ["missing.bin", "submodule"];
  assert.equal(getTrackedFileSize(f.root, "missing.bin"), null);
  assert.equal(getTrackedFileSize(f.root, "submodule"), null);
  assert.deepEqual(largeTrackedFileRule.run({ repository: f.repository }), []);
});

test("unsafe paths cannot escape the repository or access Windows path aliases", async (t) => {
  const f = await fixture(t);
  await sizedFile(join(f.temporaryRoot, "outside.bin"), LARGE_TRACKED_FILE_BYTES);
  for (const path of ["../outside.bin", "/outside.bin", "nested/../../outside.bin", "bad\0name", ""]) {
    assert.equal(getTrackedFileSize(f.root, path), null, path);
  }
  if (process.platform === "win32") {
    for (const path of ["..\\outside.bin", "file.bin:stream", ".. /outside.bin"]) {
      assert.equal(getTrackedFileSize(f.root, path), null, path);
    }
  }
});

test("directory symlinks and Windows junctions are not traversed", async (t) => {
  const f = await fixture(t);
  const outside = join(f.temporaryRoot, "outside");
  await sizedFile(join(outside, "large.bin"), LARGE_TRACKED_FILE_BYTES);
  await symlink(outside, join(f.root, "linked"), process.platform === "win32" ? "junction" : "dir");
  f.repository.trackedFiles = ["linked/large.bin"];
  assert.equal(getTrackedFileSize(f.root, "linked/large.bin"), null);
  assert.deepEqual(largeTrackedFileRule.run({ repository: f.repository }), []);
});

test("file symlinks to large files inside and outside the repository are skipped", async (t) => {
  const f = await fixture(t);
  await sizedFile(join(f.root, "inside.bin"), LARGE_TRACKED_FILE_BYTES);
  await sizedFile(join(f.temporaryRoot, "outside.bin"), LARGE_TRACKED_FILE_BYTES);
  try {
    await symlink(join(f.root, "inside.bin"), join(f.root, "inside-link.bin"), "file");
    await symlink(join(f.temporaryRoot, "outside.bin"), join(f.root, "outside-link.bin"), "file");
  } catch (error: unknown) {
    if (process.platform === "win32" && error instanceof Error && "code" in error && error.code === "EPERM") {
      t.skip("Windows file symlinks require Developer Mode or symlink privileges");
      return;
    }
    throw error;
  }
  f.repository.trackedFiles = ["inside-link.bin", "outside-link.bin"];
  assert.equal(getTrackedFileSize(f.root, "inside-link.bin"), null);
  assert.equal(getTrackedFileSize(f.root, "outside-link.bin"), null);
  assert.deepEqual(largeTrackedFileRule.run({ repository: f.repository }), []);
});
