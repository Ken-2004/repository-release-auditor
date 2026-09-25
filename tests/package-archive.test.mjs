import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { inspectArchive, run } from "../scripts/package-support.mjs";

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
