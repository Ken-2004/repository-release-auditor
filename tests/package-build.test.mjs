import assert from "node:assert/strict";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import test from "node:test";

import {
  inspectArchive, isolatedEnvironment, npmCli, packageRoot, run
} from "../scripts/package-support.mjs";

const marker = "SYNTHETIC_DELETED_SOURCE_PACKAGE_CANARY";
const staleMarker = "SYNTHETIC_STALE_OUTPUT_PACKAGE_CANARY";
const sourceCanary = "synthetic-deleted-source.ts";
const compiledCanary = "dist/src/synthetic-deleted-source.js";
const helper = "scripts/build-release.mjs";

async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function fixture(t) {
  const temporaryParent = await realpath(tmpdir());
  const directory = await mkdtemp(join(temporaryParent, "auditor-package-build-"));
  t.after(async () => {
    // Fixture cleanup is restricted to the particular temporary child we created.
    assert.equal(dirname(resolve(directory)), temporaryParent);
    assert.ok(basename(directory).startsWith("auditor-package-build-"));
    assert.equal((await lstat(directory)).isSymbolicLink(), false);
    await rm(directory, { recursive: true, force: true, maxRetries: 3 });
  });
  const root = join(directory, "package");
  await mkdir(root);
  for (const name of [
    "src", "tests", "scripts", "docs", "package.json", "package-lock.json",
    "tsconfig.json", "tsconfig.release.json", "README.md", "LICENSE", "SECURITY.md"
  ]) {
    await cp(join(packageRoot, name), join(root, name), { recursive: true });
  }
  // Reuse only the installed development tools. Generated files belong to this
  // disposable package, and the package allowlist excludes node_modules.
  await symlink(join(packageRoot, "node_modules"), join(root, "node_modules"),
    process.platform === "win32" ? "junction" : "dir");
  const env = await isolatedEnvironment(join(directory, "environment"));
  return { directory, root, env };
}

function command(f, args, options = {}) {
  return run(process.execPath, args, {
    cwd: f.root, env: f.env, timeout: 120_000, ...options
  });
}

function assertSuccess(result) {
  assert.equal(Boolean(result.error), false, "Synthetic subprocess could not start.");
  assert.equal(result.signal, null, "Synthetic subprocess exceeded its limits.");
  assert.equal(result.status, 0, "Synthetic subprocess failed.");
}

function assertFailure(result) {
  assert.equal(Boolean(result.error), false, "Synthetic subprocess could not start.");
  assert.equal(result.signal, null, "Synthetic subprocess exceeded its limits.");
  assert.notEqual(result.status, 0, "Unsafe synthetic package construction succeeded.");
}

async function pack(f, destinationName) {
  const destination = join(f.directory, destinationName);
  await mkdir(destination);
  const result = command(f, [npmCli, "pack", "--json", "--pack-destination", destination]);
  const archives = (await readdir(destination)).filter((name) => name.endsWith(".tgz"));
  return { destination, result, archives };
}

async function unpackedFiles(packed) {
  assertSuccess(packed.result);
  assert.equal(packed.archives.length, 1);
  const archive = await inspectArchive(join(packed.destination, packed.archives[0]));
  return archive.files;
}

function containsMarker(files, value) {
  return files.some((file) => Buffer.from(file.data, "base64").includes(Buffer.from(value)));
}

function paths(files) {
  return files.map((file) => file.path).sort();
}

async function addDeletedSource(f) {
  const source = join(f.root, "src", sourceCanary);
  await writeFile(source, `export const canary = ${JSON.stringify(marker)};\n`);
  assertSuccess(command(f, [npmCli, "run", "build"]));
  assert.equal(await exists(join(f.root, compiledCanary)), true);
  assert.equal((await readFile(join(f.root, compiledCanary), "utf8")).includes(marker), true);
  await rm(source);
}

async function seedOutput(f, relativePath, bytes = staleMarker) {
  const path = join(f.root, "dist", relativePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
  return path;
}

test("baseline prepack reproduces deleted-source JavaScript and canary bytes in an actual archive", async (t) => {
  const f = await fixture(t);
  const metadataPath = join(f.root, "package.json");
  const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
  // Reproduce only the recorded baseline construction path in the synthetic copy.
  metadata.scripts.prepack = "npm run build -- --sourceMap false --declaration false --newLine lf";
  await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
  await addDeletedSource(f);
  const files = await unpackedFiles(await pack(f, "baseline-artifact"));
  assert.equal(await exists(join(f.root, compiledCanary)), true);
  assert.equal(paths(files).includes(`package/${compiledCanary}`), true);
  assert.equal(containsMarker(files, marker), true);
});

test("candidate pack removes deleted-source and seeded development output before archiving", async (t) => {
  const f = await fixture(t);
  await addDeletedSource(f);
  const stalePaths = [
    "src/synthetic-stale.js", "src/synthetic-stale.js.map", "src/synthetic-stale.d.ts",
    "tests/synthetic-stale.test.js", "tests/synthetic-stale.test.js.map",
    "tests/synthetic-stale.test.d.ts"
  ];
  for (const path of stalePaths) await seedOutput(f, path);
  const files = await unpackedFiles(await pack(f, "candidate-artifact"));
  assert.equal(await exists(join(f.root, compiledCanary)), false);
  for (const path of stalePaths) assert.equal(await exists(join(f.root, "dist", path)), false);
  assert.equal(containsMarker(files, marker), false);
  assert.equal(containsMarker(files, staleMarker), false);
  assert.equal(paths(files).includes(`package/${compiledCanary}`), false);
  assert.equal(paths(files).some((path) => /(?:^|\/)(?:tests|node_modules)\//.test(path)), false);
  assert.equal(paths(files).some((path) => /\.(?:map|ts)$/.test(path)), false);
  assert.equal(await exists(join(f.root, "dist", "tests")), false);
});

test("real package construction works with missing output and repeats without stale state", async (t) => {
  const f = await fixture(t);
  assert.equal(await exists(join(f.root, "dist")), false);
  const first = await unpackedFiles(await pack(f, "first-artifact"));
  await seedOutput(f, "src/synthetic-between-packs.js");
  const second = await unpackedFiles(await pack(f, "second-artifact"));
  assert.equal(await exists(join(f.root, "dist", "src", "synthetic-between-packs.js")), false);
  assert.deepEqual(paths(second), paths(first));
  assert.deepEqual(second.map((file) => [file.path, file.data]).sort(),
    first.map((file) => [file.path, file.data]).sort());
  assert.equal(containsMarker(second, staleMarker), false);
});

test("release helper anchors cleanup to its package despite foreign cwd and INIT_CWD", async (t) => {
  const f = await fixture(t);
  const foreign = join(f.directory, "foreign-project");
  const sentinel = join(foreign, "dist", "sentinel.txt");
  await mkdir(dirname(sentinel), { recursive: true });
  await writeFile(sentinel, "SYNTHETIC_EXTERNAL_SENTINEL");
  const stale = await seedOutput(f, "src/synthetic-stale.js");
  assertSuccess(command(f, [join(f.root, helper)], {
    cwd: foreign, env: { ...f.env, INIT_CWD: foreign }
  }));
  assert.equal(await exists(stale), false);
  assert.equal(await exists(join(f.root, "dist", "src", "cli.js")), true);
  assert.equal(await readFile(sentinel, "utf8"), "SYNTHETIC_EXTERNAL_SENTINEL");

  // Caller-supplied paths are refused, rather than interpreted as clean targets.
  const retained = await seedOutput(f, "src/synthetic-retained.js");
  const refused = command(f, [join(f.root, helper), "--outDir", join(foreign, "dist")], {
    cwd: foreign, env: { ...f.env, INIT_CWD: foreign }
  });
  assertFailure(refused);
  assert.equal(refused.stdout, "");
  assert.equal(refused.stderr.trim(), "Release build failed: arguments are not supported.");
  assert.equal(await exists(retained), true);
  assert.equal(await readFile(sentinel, "utf8"), "SYNTHETIC_EXTERNAL_SENTINEL");
});

for (const nested of [false, true]) {
  test(`release pack refuses ${nested ? "nested" : "root"} output directory links without touching external bytes`, async (t) => {
    const f = await fixture(t);
    const external = join(f.directory, "external-data");
    await mkdir(external);
    const sentinel = join(external, "sentinel.txt");
    await writeFile(sentinel, "SYNTHETIC_EXTERNAL_SENTINEL");
    let retained;
    if (nested) retained = await seedOutput(f, "src/retained.js", "SYNTHETIC_RETAINED_OUTPUT");
    const link = nested ? join(f.root, "dist", "nested-link") : join(f.root, "dist");
    await symlink(external, link, process.platform === "win32" ? "junction" : "dir");
    const packed = await pack(f, "refused-link-artifact");
    assertFailure(packed.result);
    assert.deepEqual(packed.archives, []);
    assert.equal(await readFile(sentinel, "utf8"), "SYNTHETIC_EXTERNAL_SENTINEL");
    assert.equal((await lstat(link)).isSymbolicLink(), true);
    if (retained) assert.equal(await readFile(retained, "utf8"), "SYNTHETIC_RETAINED_OUTPUT");
    const direct = command(f, [join(f.root, helper)]);
    assertFailure(direct);
    assert.equal(direct.stdout, "");
    assert.equal(direct.stderr.trim(),
      "Release build failed: output boundary is unsafe or could not be inspected.");
  });
}

test("release helper refuses a regular file at the fixed output directory", async (t) => {
  const f = await fixture(t);
  const output = join(f.root, "dist");
  await writeFile(output, "SYNTHETIC_OUTPUT_FILE_SENTINEL");
  const result = command(f, [join(f.root, helper)]);
  assertFailure(result);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr.trim(),
    "Release build failed: output boundary is unsafe or could not be inspected.");
  assert.equal(await readFile(output, "utf8"), "SYNTHETIC_OUTPUT_FILE_SENTINEL");
});

test("failed compilation cannot package stale output into a fresh artifact destination", async (t) => {
  const f = await fixture(t);
  await seedOutput(f, "src/cli.js");
  await seedOutput(f, "src/synthetic-stale.js");
  await writeFile(join(f.root, "src", "synthetic-type-error.ts"),
    'export const syntheticCompileFailure: string = 123;\n');
  const packed = await pack(f, "failed-compile-artifact");
  assertFailure(packed.result);
  assert.deepEqual(await readdir(packed.destination), []);
  assert.equal(await exists(join(f.root, "dist", "src", "cli.js")), false);
  assert.equal(await exists(join(f.root, "dist", "src", "synthetic-stale.js")), false);
  assert.equal(await exists(join(f.root, "dist", "src", "synthetic-type-error.js")), false);
  const direct = command(f, [join(f.root, helper)]);
  assertFailure(direct);
  assert.equal(direct.stdout, "");
  assert.equal(direct.stderr.trim(),
    "Release build failed: compilation failed; run npm run check for diagnostics.");
});
