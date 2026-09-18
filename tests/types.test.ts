import assert from "node:assert/strict";
import test from "node:test";

import type { Finding } from "../src/core/types.js";

test("finding model represents a repository hygiene finding", () => {
  const finding: Finding = {
    ruleId: "example-rule",
    category: "repository",
    severity: "warning",
    title: "Example finding",
    message: "Example message"
  };

  assert.equal(finding.ruleId, "example-rule");
  assert.equal(finding.severity, "warning");
});
