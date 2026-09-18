import assert from "node:assert/strict";
import test from "node:test";

import { findingsMeetThreshold } from "../src/core/exit-policy.js";
import type { Finding } from "../src/core/types.js";

function finding(severity: Finding["severity"]): Finding {
  return {
    ruleId: "test-rule",
    category: "test",
    severity,
    title: "Test",
    message: "Test finding"
  };
}

test("warning meets warning threshold", () => {
  assert.equal(
    findingsMeetThreshold([finding("warning")], "warning"),
    true
  );
});

test("info does not meet warning threshold", () => {
  assert.equal(
    findingsMeetThreshold([finding("info")], "warning"),
    false
  );
});

test("error meets warning threshold", () => {
  assert.equal(
    findingsMeetThreshold([finding("error")], "warning"),
    true
  );
});

test("empty findings never meet a threshold", () => {
  for (const threshold of ["info", "warning", "error"] as const) {
    assert.equal(findingsMeetThreshold([], threshold), false);
  }
});

test("info threshold accepts every severity", () => {
  for (const severity of ["info", "warning", "error"] as const) {
    assert.equal(findingsMeetThreshold([finding(severity)], "info"), true);
  }
});

test("error threshold accepts only errors", () => {
  assert.equal(findingsMeetThreshold([finding("info"), finding("warning")], "error"), false);
  assert.equal(findingsMeetThreshold([finding("error")], "error"), true);
});

test("a qualifying finding meets the threshold regardless of order", () => {
  const findings = [finding("info"), finding("warning"), finding("error")];
  assert.equal(findingsMeetThreshold(findings, "error"), true);
  assert.equal(findingsMeetThreshold(findings.toReversed(), "error"), true);
});
