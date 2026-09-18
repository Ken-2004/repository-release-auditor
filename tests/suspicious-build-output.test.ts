import assert from "node:assert/strict";
import test from "node:test";

import type { GitRepositorySnapshot } from "../src/git/snapshot.js";
import { isSuspiciousBuildPath, suspiciousBuildOutputRule } from "../src/rules/suspicious-build-output.js";

test("matches exact generated directory segments, including nested directories", () => {
  for (const path of [
    "node_modules/package/index.js", "coverage/lcov.info", ".next/server/app.js",
    ".nuxt/app.js", "__pycache__/module.pyc", "obj/project.obj", "dist/app.js",
    "build/app.exe", "packages/web/dist/app.js", "nested/node_modules/pkg/index.js",
    "packages/web/.next/server/app.js", "packages/lib/obj/project.json",
    "packages/web/COVERAGE/lcov.info", "Dist/App.JS", "dist/manual.pdf",
    "build/release.zip", "coverage/chart.png"
  ]) assert.equal(isSuspiciousBuildPath(path), true, path);
});

test("matches only the explicit compiled extensions outside generated directories", () => {
  for (const extension of ["o", "obj", "class", "pyc", "pyo", "exe", "dll", "so", "dylib"]) {
    assert.equal(isSuspiciousBuildPath(`lib/module.${extension}`), true, extension);
    assert.equal(isSuspiciousBuildPath(`lib/module.${extension.toUpperCase()}`), true, extension);
    assert.equal(isSuspiciousBuildPath(`lib/module.${extension}.txt`), false, extension);
  }
});

test("recognizes Cargo target profiles without treating every target directory as output", () => {
  for (const path of ["target/debug/app", "target/release/app", "crate/TARGET/Release/deps/app"]) {
    assert.equal(isSuspiciousBuildPath(path), true, path);
  }
  for (const path of ["target/readme.md", "src/target/index.ts", "target/debug", "target/release-notes/readme.md"]) {
    assert.equal(isSuspiciousBuildPath(path), false, path);
  }
});

test("does not infer generated output from words in ordinary filenames or directory substrings", () => {
  for (const directory of ["src", "docs", "examples", "test", "tests", "fixtures", "assets", "config"]) {
    for (const filename of ["build.ts", "dist-config.json", "target.ts", "coverage.md"]) {
      assert.equal(isSuspiciousBuildPath(`${directory}/${filename}`), false);
    }
  }
  for (const path of ["rebuild/index.ts", "dist-tools/index.js", "coverage-reports/readme.md", "node_modules.md", "src/build"]) {
    assert.equal(isSuspiciousBuildPath(path), false, path);
  }
});

test("does not automatically flag archives, documents, or media", () => {
  for (const extension of ["zip", "tar", "gz", "jar", "pdf", "png", "jpg", "svg", "mp3", "wav", "mp4", "webm"]) {
    assert.equal(isSuspiciousBuildPath(`assets/release.${extension}`), false, extension);
  }
  assert.equal(isSuspiciousBuildPath("release.zip"), false);
});

test("ignores Git metadata even if it contains generated directory names or extensions", () => {
  for (const path of [".git", ".git/obj/file.obj", ".git/hooks/tool.exe", "nested/.GIT/dist/file.js", ".gitignore", ".gitmodules"]) {
    assert.equal(isSuspiciousBuildPath(path), false, path);
  }
});

test("normalizes POSIX Git paths without treating literal backslashes as separators", () => {
  assert.equal(isSuspiciousBuildPath("./nested//dist/./app.js"), true);
  assert.equal(isSuspiciousBuildPath("dist/../src/build.ts"), false);
  assert.equal(isSuspiciousBuildPath("nested\\dist/app.js"), false);
  assert.equal(isSuspiciousBuildPath("dist\\app.js"), false);
});

function snapshot(trackedFiles: string[]): GitRepositorySnapshot {
  return { root: "/nonexistent-repository", branch: "main", head: null, trackedFiles, statusEntries: [], isDirty: false };
}

test("reports one sorted warning per path, preserves casing, and leaves the snapshot unchanged", () => {
  const trackedFiles = ["z/module.so", "Dist/App.js", "./Dist/App.js", "z/module.so", "src/build.ts", "coverage/lcov.info"];
  const before = [...trackedFiles];
  const findings = suspiciousBuildOutputRule.run({ repository: snapshot(trackedFiles) });
  assert.deepEqual(findings.map((finding) => finding.path), ["Dist/App.js", "coverage/lcov.info", "z/module.so"]);
  assert.deepEqual(suspiciousBuildOutputRule.run({ repository: snapshot(trackedFiles.toReversed()) }), findings);
  assert.deepEqual(trackedFiles, before);
  for (const finding of findings) {
    assert.equal(finding.ruleId, "suspicious-build-output");
    assert.equal(finding.category, "repository");
    assert.equal(finding.severity, "warning");
    assert.match(finding.message, /may be intentionally versioned/);
    assert.match(finding.remediation ?? "", /remove it from Git.*ignore rule/);
    assert.equal(finding.evidence, undefined);
  }
});

test("only considers tracked paths and returns no findings for ordinary repositories", () => {
  const repository = snapshot(["README.md", "src/build.ts", "docs/coverage.md", "config/dist-config.json", "release.zip"]);
  repository.isDirty = true;
  repository.statusEntries = ["?? dist/app.js"];
  assert.deepEqual(suspiciousBuildOutputRule.run({ repository }), []);
  assert.deepEqual(suspiciousBuildOutputRule.run({ repository: snapshot([]) }), []);
});
