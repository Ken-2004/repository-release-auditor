import assert from "node:assert/strict";
import test from "node:test";

import { gitCleanlinessRule } from "../src/rules/git-cleanliness.js";
import type { GitRepositorySnapshot } from "../src/git/snapshot.js";

function snapshot(
  overrides: Partial<GitRepositorySnapshot> = {}
): GitRepositorySnapshot {
  return {
    root: "/repo",
    branch: "main",
    head: "0123456789012345678901234567890123456789",
    trackedFiles: [],
    statusEntries: [],
    isDirty: false,
    ...overrides
  };
}

test("git cleanliness rule returns no finding for a clean repository", () => {
  const findings = gitCleanlinessRule.run({
    repository: snapshot()
  });

  assert.deepEqual(findings, []);
});

test("git cleanliness rule reports a dirty repository", () => {
  const findings = gitCleanlinessRule.run({
    repository: snapshot({
      statusEntries: [" M README.md"],
      isDirty: true
    })
  });

  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.ruleId, "git-cleanliness");
  assert.equal(findings[0]?.severity, "warning");
});
