import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, posix, relative, sep } from "node:path";

import { checkInstalledPackage } from "./check-installed-package.mjs";
import { inspectArchive, isolatedEnvironment, npmCli, packageRoot, run } from "./package-support.mjs";

let stage = "prerequisites";
try {
  assert.equal(process.argv.length, 2);
  assert.ok(npmCli);
  const temporary = await mkdtemp(join(tmpdir(), "auditor-package-"));
  const boundary = relative(packageRoot, realpathSync(temporary));
  assert.ok(isAbsolute(boundary) || boundary === ".." || boundary.startsWith(`..${sep}`));
  const env = await isolatedEnvironment(temporary);
  const npmVersion = run(process.execPath, [npmCli, "--version"], { cwd: temporary, env });
  assert.equal(npmVersion.status, 0);

  stage = "package construction regressions";
  const regressions = run(process.execPath, [
    "--test", "--test-reporter=tap", "tests/package-build.test.mjs", "tests/package-archive.test.mjs"
  ], { cwd: packageRoot, env: { ...env, npm_execpath: npmCli }, timeout: 300_000 });
  assert.equal(regressions.status, 0);
  const counts = Object.fromEntries(["tests", "pass", "fail", "skipped"].map((key) => {
    const match = new RegExp(`^# ${key} (\\d+)$`, "m").exec(regressions.stdout);
    assert.ok(match);
    return [key, Number(match[1])];
  }));
  console.log("Package construction and archive-boundary regressions passed.");

  stage = "fresh local package construction";
  const artifacts = join(temporary, "artifacts");
  await mkdir(artifacts);
  const packed = run(process.execPath, [npmCli, "pack", "--json", "--pack-destination", artifacts], {
    cwd: packageRoot, env
  });
  assert.equal(packed.status, 0);
  const archive = join(artifacts, "repository-release-auditor-0.1.0.tgz");
  const archiveBytes = await readFile(archive);
  const sha256 = createHash("sha256").update(archiveBytes).digest("hex");
  const [packInfo] = JSON.parse(packed.stdout);
  assert.equal(packInfo.filename, basename(archive));
  assert.equal(packInfo.shasum, createHash("sha1").update(archiveBytes).digest("hex"));
  assert.equal(packInfo.integrity, "sha512-" + createHash("sha512").update(archiveBytes).digest("base64"));

  stage = "actual archive manifest and contents";
  const { files } = inspectArchive(archive);
  assert.equal(packInfo.entryCount, files.length);
  assert.equal(packInfo.size, archiveBytes.length);
  assert.equal(packInfo.unpackedSize, files.reduce((sum, file) => sum + file.size, 0));
  const contents = new Map(files.map(({ path, data }) => [path, Buffer.from(data, "base64")]));
  const sourceFiles = [];
  function collectSources(directory) {
    for (const entry of readdirSync(join(packageRoot, directory), { withFileTypes: true })) {
      assert.equal(entry.isSymbolicLink(), false);
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) collectSources(path);
      else if (entry.isFile() && path.endsWith(".ts") && !path.endsWith(".d.ts")) sourceFiles.push(path);
    }
  }
  collectSources("src");
  const runtimeFiles = sourceFiles.map((path) => `dist/${path.slice(0, -3)}.js`).sort();
  const documents = ["README.md", "SECURITY.md", "LICENSE", "docs/DEPENDENCIES.md"];
  const expected = [...runtimeFiles, ...documents, "package.json"].map((path) => `package/${path}`).sort();
  assert.deepEqual([...contents.keys()].sort(), expected);

  const { findDeveloperMachinePath } = await import("../dist/src/rules/developer-machine-path.js");
  for (const [path, bytes] of contents) {
    assert.equal(findDeveloperMachinePath(bytes.toString("utf8")), null);
    for (const localPath of [packageRoot, temporary]) {
      assert.equal(bytes.includes(Buffer.from(localPath)), false);
      assert.equal(bytes.includes(Buffer.from(localPath.replaceAll("\\", "/"))), false);
    }
    for (const marker of ["SYNTHETIC_DELETED_SOURCE_PACKAGE_CANARY", "SYNTHETIC_STALE_OUTPUT_PACKAGE_CANARY"]) {
      assert.equal(bytes.includes(Buffer.from(marker)), false);
    }
    if (path.endsWith(".js")) {
      assert.equal(bytes.includes(13), false);
      assert.equal(bytes.includes(Buffer.from("sourceMappingURL")), false);
      const freshFile = join(packageRoot, path.slice("package/".length));
      assert.equal(lstatSync(freshFile).isFile(), true);
      assert.deepEqual(bytes, readFileSync(freshFile));
    }
  }
  for (const document of documents) {
    const path = `package/${document}`;
    assert.deepEqual(contents.get(path), readFileSync(join(packageRoot, document)));
    const text = contents.get(path).toString("utf8");
    for (const match of text.matchAll(/\]\(([^)]+)\)/g)) {
      const target = match[1].split("#")[0];
      if (!target || /^[a-z]+:/i.test(target)) continue;
      assert.ok(contents.has(posix.join(posix.dirname(path), target)));
    }
  }
  const metadata = JSON.parse(contents.get("package/package.json").toString("utf8"));
  assert.deepEqual(metadata, JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")));
  assert.equal(metadata.name, "repository-release-auditor");
  assert.equal(metadata.version, "0.1.0");
  assert.equal(metadata.private, true);
  assert.equal(metadata.license, "MIT");
  assert.equal(metadata.author, "Harsh Prajapati");
  assert.deepEqual(metadata.engines, { node: ">=24 <25" });
  assert.deepEqual(metadata.bin, { "repository-release-auditor": "dist/src/cli.js" });
  assert.equal(metadata.dependencies, undefined);
  for (const hook of ["prepare", "install", "postinstall"]) assert.equal(metadata.scripts[hook], undefined);
  assert.ok(contents.get("package/dist/src/cli.js").toString("utf8").startsWith("#!/usr/bin/env node\n"));

  stage = "isolated installed-bin checks";
  // Exercise npm's ancestor-prefix hazard: the consumer must remain isolated
  // even when a parent happens to contain a package manifest.
  const parentManifest = '{"name":"synthetic-parent-package","private":true}\n';
  await writeFile(join(temporary, "package.json"), parentManifest);
  const installed = await checkInstalledPackage({
    archive, directory: join(temporary, "consumer"), env, npmCli
  });
  assert.equal(await readFile(join(temporary, "package.json"), "utf8"), parentManifest);
  assert.equal(existsSync(join(temporary, "node_modules")), false);
  assert.equal(createHash("sha256").update(await readFile(archive)).digest("hex"), sha256);
  const summary = {
    platform: process.platform, node: process.version, npm: npmVersion.stdout.trim(),
    artifactDirectory: `${basename(temporary)}/artifacts`,
    archive: basename(archive), sha256, npmIntegrity: packInfo.integrity, fileCount: files.length,
    compressedBytes: archiveBytes.length,
    unpackedBytes: files.reduce((sum, file) => sum + file.size, 0),
    manifest: expected, regressions: counts, installed
  };
  await writeFile(join(artifacts, "verification.json"), JSON.stringify(summary, null, 2) + "\n");
  console.log(JSON.stringify(summary, null, 2));
  console.log("Artifacts retained beneath the OS temporary directory for local review.");
} catch {
  console.error(`Package verification failed during ${stage}; no artifact is approved by this run.`);
  process.exitCode = 1;
}
