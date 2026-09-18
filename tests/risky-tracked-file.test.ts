import assert from "node:assert/strict";
import test from "node:test";

import { isRiskyTrackedPath, riskyTrackedFileRule } from "../src/rules/risky-tracked-file.js";
import type { GitRepositorySnapshot } from "../src/git/snapshot.js";

const riskyPaths = [
  ".env", ".env.local", ".env.production", ".env.development", ".env.test",
  ".npmrc", ".pypirc", ".netrc", "_netrc",
  "credentials.json", "service-account.json", "service-account-key.json",
  "account-key.json", "secrets.json", "secrets.yml", "secrets.yaml",
  "id_rsa", "id_ed25519", "id_dsa", "id_ecdsa", "private-key.pem",
  "client.p12", "client.pfx", "client.key",
  ".aws/credentials", ".aws/config", "deploy/.aws/credentials", "deploy/.aws/config",
  "deploy/.ENV.Production", "keys/ID_ED25519", "keys/CLIENT.PFX",
  "deploy/.AWS/CONFIG", "nested directory/credentials.json",
  ".env.examples", ".env.sampled"
];

test("matches explicit risky filenames, extensions, and AWS paths", () => {
  for (const path of riskyPaths) {
    assert.equal(isRiskyTrackedPath(path), true, path);
  }
});

test("exempts documented env templates, including qualified and mixed-case names", () => {
  for (const path of [
    ".env.example", ".env.sample", ".env.template", ".env.dist",
    ".env.production.example", ".env.example.production",
    "nested/.ENV.TEST.TEMPLATE", "nested/.env.sample.local"
  ]) {
    assert.equal(isRiskyTrackedPath(path), false, path);
  }
});

test("does not match public certificates, vague names, or directory names alone", () => {
  for (const path of [
    "README.md", "src/auth.ts", "config.json", "settings.yml", "auth.json",
    "public.crt", "public.cer", "public.pem", "id_rsa.pub", "id_ed25519.pub",
    "credentials.json.example", "secrets.yaml.template", "client.key.sample",
    "private-key.pem.txt", "mycredentials.json", "aws/config", "credentials",
    ".aws/config.example", ".aws/backup/config", ".aws-config",
    ".env/README.md", "private.key/README.md", "examples/config.json"
  ]) {
    assert.equal(isRiskyTrackedPath(path), false, path);
  }
});

test("normalizes Git paths consistently without interpreting literal backslashes", () => {
  assert.equal(isRiskyTrackedPath("./nested//.aws/./credentials"), true);
  assert.equal(isRiskyTrackedPath("nested/../.env"), true);
  assert.equal(isRiskyTrackedPath("nested\\.env"), false);
  assert.equal(isRiskyTrackedPath("nested\\.aws/config"), false);
});

function snapshot(trackedFiles: string[]): GitRepositorySnapshot {
  return {
    root: "/nonexistent-repository",
    branch: "main",
    head: null,
    trackedFiles,
    statusEntries: [],
    isDirty: false
  };
}

test("reports unique sorted paths as warnings without mutating the snapshot", () => {
  const trackedFiles = ["z/private-key.pem", ".env", "./nested/.ENV", ".env", "README.md"];
  const before = [...trackedFiles];
  const findings = riskyTrackedFileRule.run({ repository: snapshot(trackedFiles) });
  assert.deepEqual(findings.map((finding) => finding.path), [".env", "nested/.ENV", "z/private-key.pem"]);
  assert.deepEqual(
    riskyTrackedFileRule.run({ repository: snapshot(trackedFiles.toReversed()) }),
    findings
  );
  assert.deepEqual(trackedFiles, before);
  for (const finding of findings) {
    assert.equal(finding.ruleId, "risky-tracked-file");
    assert.equal(finding.severity, "warning");
    assert.equal(finding.evidence, undefined);
    assert.match(finding.remediation ?? "", /Verify.*version control and Git history/);
  }
});

test("only considers tracked paths, independent of worktree cleanliness", () => {
  const repository = snapshot(["README.md", ".env.example"]);
  repository.isDirty = true;
  repository.statusEntries = ["?? .env"];
  assert.deepEqual(riskyTrackedFileRule.run({ repository }), []);
  assert.deepEqual(riskyTrackedFileRule.run({ repository: snapshot([]) }), []);
});
