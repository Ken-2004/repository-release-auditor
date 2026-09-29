import assert from "node:assert/strict";
import { lstat, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import test from "node:test";

import { checkInstalledPackage } from "../scripts/check-installed-package.mjs";
import { inspectArchive, isolatedEnvironment, npmCli, packageRoot, run } from "../scripts/package-support.mjs";

const createArchive = `
import io, sys, tarfile
kind, path = sys.argv[1:]
with tarfile.open(path, "w:gz") as archive:
    item = tarfile.TarInfo("package/README.md")
    if kind == "traversal": item.name = "package/../outside"
    if kind == "absolute": item.name = "/outside"
    if kind == "drive": item.name = "C:" + "/outside"
    if kind == "backslash": item.name = "package" + chr(92) + "outside"
    if kind == "control": item.name = "package/name" + chr(10) + "outside"
    if kind == "symlink": item.type = tarfile.SYMTYPE; item.linkname = "../outside"
    if kind == "hardlink": item.type = tarfile.LNKTYPE; item.linkname = "package/README.md"
    if kind == "fifo": item.type = tarfile.FIFOTYPE
    if kind == "mode": item.mode = 0o4755
    if kind == "directory": item.name = "package/unneeded"; item.type = tarfile.DIRTYPE
    if item.isfile():
        item.size = 7
        archive.addfile(item, io.BytesIO(b"fixture"))
    else: archive.addfile(item)
    if kind == "duplicate": archive.addfile(item, io.BytesIO(b"fixture"))
`;

const createMetadataArchive = `
import io, sys, tarfile
path, manifest = sys.argv[1:]
data = manifest.encode("utf-8")
with tarfile.open(path, "w:gz") as archive:
    item = tarfile.TarInfo("package/package.json")
    item.size = len(data)
    item.mode = 0o644
    archive.addfile(item, io.BytesIO(data))
`;

test("archive inspection accepts an ordinary package entry without extracting it", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "auditor-archive-check-"));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 3 }));
  const archive = join(directory, "fixture.tgz");
  const result = run(process.platform === "win32" ? "python" : "python3",
    ["-I", "-B", "-c", createArchive, "ordinary", archive]);
  assert.equal(result.status, 0, "synthetic archive creation must succeed");
  const inspected = inspectArchive(archive);
  assert.deepEqual(inspected.files.map(({ path, size }) => ({ path, size })),
    [{ path: "package/README.md", size: 7 }]);
  assert.equal(Buffer.from(inspected.files[0].data, "base64").toString(), "fixture");
});

test("archive inspection refuses unsafe entry paths, aliases, links and special types", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "auditor-archive-check-"));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 3 }));
  for (const kind of ["traversal", "absolute", "drive", "backslash", "control", "symlink",
    "hardlink", "fifo", "mode", "directory", "duplicate"]) {
    const archive = join(directory, `${kind}.tgz`);
    const result = run(process.platform === "win32" ? "python" : "python3",
      ["-I", "-B", "-c", createArchive, kind, archive]);
    assert.equal(result.status, 0, "synthetic archive creation must succeed");
    assert.throws(() => inspectArchive(archive),
      { message: "Archive inspection failed; Python 3 is required." }, kind);
  }
});

for (const [description, changes] of [
  ["private true", { private: true }],
  ["private false", { private: false }],
  ["private string", { private: "SYNTHETIC_PRIVATE_METADATA" }],
  ["private null", { private: null }],
  ["wrong version", { version: "9.9.9" }]
]) {
  test(`installed package refuses ${description} at its metadata gate`, async (t) => {
    const temporaryParent = await realpath(tmpdir());
    const directory = await mkdtemp(join(temporaryParent, "auditor-installed-metadata-"));
    t.after(async () => {
      assert.equal(dirname(resolve(directory)), temporaryParent);
      assert.ok(basename(directory).startsWith("auditor-installed-metadata-"));
      assert.equal((await lstat(directory)).isSymbolicLink(), false);
      await rm(directory, { recursive: true, force: true, maxRetries: 3 });
    });
    const metadata = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
    assert.equal(Object.hasOwn(metadata, "private"), false);
    Object.assign(metadata, changes);
    const archive = join(directory, "metadata.tgz");
    const result = run(process.platform === "win32" ? "python" : "python3",
      ["-I", "-B", "-c", createMetadataArchive, archive, JSON.stringify(metadata)]);
    assert.equal(result.status, 0, "synthetic metadata archive creation must succeed");
    const inspected = inspectArchive(archive);
    assert.equal(inspected.files.length, 1);
    assert.equal(inspected.files[0].path, "package/package.json");
    assert.deepEqual(JSON.parse(Buffer.from(inspected.files[0].data, "base64").toString()), metadata);

    const parentManifest = '{"name":"synthetic-metadata-parent","private":true}\n';
    await writeFile(join(directory, "package.json"), parentManifest);
    const consumer = join(directory, "consumer");
    const env = await isolatedEnvironment(join(directory, "environment"));
    assert.ok(npmCli);
    // This archive deliberately omits runtime and documentation: the exact
    // refusal must come from metadata validation before those later checks.
    await assert.rejects(checkInstalledPackage({ archive, directory: consumer, env, npmCli }), {
      message: "Installed package check failed: installed metadata and absence of consumer compilation hooks."
    });
    assert.deepEqual(JSON.parse(await readFile(join(consumer, "node_modules",
      "repository-release-auditor", "package.json"), "utf8")), metadata);
    assert.equal(await readFile(join(directory, "package.json"), "utf8"), parentManifest);
    assert.deepEqual(JSON.parse(await readFile(join(consumer, "package.json"), "utf8")), {
      name: "synthetic-package-consumer", version: "0.0.0", private: true
    });
    await assert.rejects(lstat(join(directory, "node_modules")), { code: "ENOENT" });
  });
}
