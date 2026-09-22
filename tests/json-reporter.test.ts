import assert from "node:assert/strict";
import test from "node:test";

import type { Finding } from "../src/core/types.js";
import { formatJsonReport } from "../src/reporters/json.js";

const repository = { root: "/repository", branch: "main", head: null };
const metadata = { version: "0.1.0" };

function finding(severity: Finding["severity"], ruleId = "test-rule"): Finding {
  return { ruleId, category: "repository", severity, title: "Test", message: "Test finding" };
}

test("JSON reporter emits the exact versioned clean-report shape", () => {
  assert.deepEqual(JSON.parse(formatJsonReport(repository, [], metadata)), {
    schemaVersion: 1,
    tool: { name: "repository-release-auditor", version: "0.1.0" },
    repository: { root: "/repository", branch: "main", head: null },
    summary: { findingCount: 0, bySeverity: { info: 0, warning: 0, error: 0 } },
    findings: []
  });
});

test("JSON reporter counts all severities and preserves pipeline order without mutation", () => {
  const findings = Object.freeze([
    Object.freeze(finding("warning", "z-rule")), Object.freeze(finding("info")),
    Object.freeze(finding("error")), Object.freeze(finding("warning", "a-rule"))
  ]);
  const report = JSON.parse(formatJsonReport(repository, findings, metadata));
  assert.deepEqual(report.summary, { findingCount: 4, bySeverity: { info: 1, warning: 2, error: 1 } });
  assert.deepEqual(report.findings, findings);
});

test("JSON reporter omits undefined optional fields and preserves provided finding fields", () => {
  const minimal = finding("info");
  Object.defineProperty(minimal, "path", { value: undefined, enumerable: true });
  const detailed = { ...finding("warning"), path: "nested/file.txt", evidence: "Line 2: value redacted.", remediation: "Review this location." };
  const report = JSON.parse(formatJsonReport(repository, [minimal, detailed], metadata));
  assert.deepEqual(Object.keys(report.findings[0]), ["ruleId", "category", "severity", "title", "message"]);
  assert.deepEqual(report.findings[1], detailed);
});

test("JSON reporter projects only public report fields, including nullable Git metadata", () => {
  const privateValue = ["private", "snapshot", "fixture"].join("_");
  const snapshot = { ...repository, branch: null, head: "a".repeat(40), trackedFiles: [privateValue],
    statusEntries: [privateValue], environment: privateValue, timestamp: privateValue };
  const extendedFinding = { ...finding("warning"), source: privateValue, text: privateValue };
  const output = formatJsonReport(snapshot, [extendedFinding], { ...metadata, ...{ hostname: privateValue } });
  const report = JSON.parse(output);
  assert.deepEqual(report.repository, { root: repository.root, branch: null, head: "a".repeat(40) });
  assert.deepEqual(Object.keys(report), ["schemaVersion", "tool", "repository", "summary", "findings"]);
  assert.deepEqual(report.tool, { name: "repository-release-auditor", version: metadata.version });
  assert.deepEqual(report.findings, [finding("warning")]);
  assert.equal(output.includes(privateValue), false);
});

test("JSON reporter escapes control characters and is deterministic across input property order", () => {
  const entry = { ...finding("warning"), path: 'nested/"quoted".txt', evidence: "Line 1: value redacted.\n\t\u001b" };
  const output = formatJsonReport(repository, [entry], metadata);
  assert.equal(output.includes("\u001b"), false);
  assert.deepEqual(JSON.parse(output).findings, [entry]);
  const reordered = { evidence: entry.evidence, path: entry.path, message: entry.message,
    title: entry.title, severity: entry.severity, category: entry.category, ruleId: entry.ruleId };
  assert.equal(formatJsonReport(repository, [reordered], metadata), output);
});
