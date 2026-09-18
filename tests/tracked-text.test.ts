import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { MAX_TEXT_FILE_BYTES, readTrackedTextFile } from "../src/files/tracked-text.js";

const aliceProjectPath = ["/home", "alice", "project"].join("/");
const alicePrivatePath = ["/home", "alice", "private"].join("/");

async function fixture(t: TestContext) {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "auditor-text-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true, maxRetries: 3 }));
  const root = join(temporaryRoot, "repository");
  await mkdir(root);
  return { root, temporaryRoot };
}

test("reads supported UTF-8 text, BOMs, empty files, and POSIX Git paths", async (t) => {
  const { root } = await fixture(t);
  await mkdir(join(root, "nested"));
  const content = "\ufeffhello é 🌍\r\n\ttest\n";
  await writeFile(join(root, "nested", "note.MD"), content);
  await writeFile(join(root, ".env.local"), "");
  await writeFile(join(root, "Dockerfile"), "FROM scratch\n");
  assert.equal(readTrackedTextFile(root, "nested/note.MD"), content);
  assert.equal(readTrackedTextFile(root, ".env.local"), "");
  assert.equal(readTrackedTextFile(root, "Dockerfile"), "FROM scratch\n");
});

test("skips binary bytes before decoding even with a text extension", async (t) => {
  const { root } = await fixture(t);
  for (const bytes of [
    Buffer.from(`\0${aliceProjectPath}`),
    Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(aliceProjectPath)]),
    Buffer.from(aliceProjectPath, "utf16le"),
    Buffer.from(`\x01${aliceProjectPath}`)
  ]) {
    await writeFile(join(root, "binary.txt"), bytes);
    assert.equal(readTrackedTextFile(root, "binary.txt"), null);
  }
});

test("skips unsupported files even if their bytes happen to be valid UTF-8", async (t) => {
  const { root } = await fixture(t);
  for (const name of ["image.bin", "document.pdf", "custom.unknown"]) {
    await writeFile(join(root, name), aliceProjectPath);
    assert.equal(readTrackedTextFile(root, name), null);
  }
});

test("enforces the 1 MiB limit and accepts a file exactly at the limit", async (t) => {
  const { root } = await fixture(t);
  await writeFile(join(root, "large.txt"), Buffer.alloc(MAX_TEXT_FILE_BYTES + 1, 65));
  assert.equal(readTrackedTextFile(root, "large.txt"), null);
  await writeFile(join(root, "large.txt"), Buffer.alloc(MAX_TEXT_FILE_BYTES, 65));
  assert.equal(readTrackedTextFile(root, "large.txt")?.length, MAX_TEXT_FILE_BYTES);
});

test("skips missing files, directories, and unsafe Git paths", async (t) => {
  const { root, temporaryRoot } = await fixture(t);
  await writeFile(join(temporaryRoot, "outside.txt"), alicePrivatePath);
  await mkdir(join(root, "directory.txt"));
  for (const path of [
    "missing.txt", "directory.txt", "../outside.txt", "/outside.txt", "./missing.txt",
    "nested/../../outside.txt", "nested//file.txt", "bad\0name.txt"
  ]) {
    assert.equal(readTrackedTextFile(root, path), null, path);
  }
  if (process.platform === "win32") {
    assert.equal(readTrackedTextFile(root, "..\\outside.txt"), null);
    assert.equal(readTrackedTextFile(root, "file.txt:stream.txt"), null);
  }
});

test("does not traverse directory symlinks or Windows junctions outside the repository", async (t) => {
  const { root, temporaryRoot } = await fixture(t);
  const outside = join(temporaryRoot, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "private.txt"), alicePrivatePath);
  await symlink(outside, join(root, "link"), process.platform === "win32" ? "junction" : "dir");
  assert.equal(readTrackedTextFile(root, "link/private.txt"), null);
});

test("does not read file symlinks, including links to files inside the repository", async (t) => {
  const { root } = await fixture(t);
  await writeFile(join(root, "target.txt"), alicePrivatePath);
  try {
    await symlink(join(root, "target.txt"), join(root, "link.txt"), "file");
  } catch (error: unknown) {
    if (process.platform === "win32" && error instanceof Error && "code" in error && error.code === "EPERM") {
      t.skip("Windows file symlinks require Developer Mode or symlink privileges");
      return;
    }
    throw error;
  }
  assert.equal(readTrackedTextFile(root, "link.txt"), null);
});
