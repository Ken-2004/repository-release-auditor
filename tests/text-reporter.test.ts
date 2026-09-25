import assert from "node:assert/strict";
import test from "node:test";

import type { Finding } from "../src/core/types.js";
import { escapeTextDisplay } from "../src/reporters/escape.js";
import { formatTextReport } from "../src/reporters/text.js";

const displayControlPoints = [
  ...Array.from({ length: 32 }, (_, index) => index),
  ...Array.from({ length: 33 }, (_, index) => 0x7f + index),
  0x061c, 0x200e, 0x200f, 0x2028, 0x2029,
  0x202a, 0x202b, 0x202c, 0x202d, 0x202e,
  0x2066, 0x2067, 0x2068, 0x2069
];
const controls = String.fromCodePoint(...displayControlPoints);
const escapedControls = displayControlPoints
  .map((point) => `\\u${point.toString(16).padStart(4, "0")}`).join("");

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    ruleId: "test-rule", category: "repository", severity: "warning",
    title: "Test title", message: "Test message", ...overrides
  };
}

test("text display escaping covers every declared control with visible lowercase Unicode notation", () => {
  assert.equal(escapeTextDisplay(controls), escapedControls);
  assert.equal(escapeTextDisplay(controls), escapedControls);
});

test("text display escaping preserves ordinary Unicode, replacement characters and path spelling", () => {
  const printable = "nested/\u65e5\u672c\u8a9e/caf\u00e9/e\u0301/\ud83d\udd0e/\ufffd/quoted\"/back\\slash.txt";
  assert.equal(escapeTextDisplay(printable), printable);
  // Nearby characters outside the documented finite set remain unchanged.
  const outsidePolicy = String.fromCodePoint(0x20, 0x7e, 0xa0, 0x061b, 0x061d, 0x200d, 0x2010, 0x2027, 0x202f, 0x2065, 0x206a);
  assert.equal(escapeTextDisplay(outsidePolicy), outsidePolicy);
});

test("text reporter escapes a clean repository root without changing report-owned newlines", () => {
  assert.equal(formatTextReport(`/repository/${controls}`, []), [
    "Repository Release Auditor", `Repository: /repository/${escapedControls}`, "", "No findings."
  ].join("\n"));
});

test("text reporter escapes all printed finding fields without mutating or truncating findings", () => {
  const entry = Object.freeze(finding({
    ruleId: `rule${controls}`, title: `title${controls}`, message: `message${controls}`,
    path: `nested/${controls}.txt`, evidence: `policy${controls}`,
    remediation: `remediation${controls}`
  }));
  const findings = Object.freeze([entry, Object.freeze(finding({ ruleId: "second-rule" }))]);
  const output = formatTextReport(`/repository/${controls}`, findings);
  assert.equal(output, [
    "Repository Release Auditor", `Repository: /repository/${escapedControls}`, "", "2 findings:", "",
    `[WARNING] rule${escapedControls}`, `title${escapedControls}`, `message${escapedControls}`,
    `Path: nested/${escapedControls}.txt`, `Evidence: policy${escapedControls}`,
    `Remediation: remediation${escapedControls}`, "", "[WARNING] second-rule", "Test title", "Test message"
  ].join("\n"));
  assert.equal(entry.path, `nested/${controls}.txt`);
  assert.equal(entry.severity, "warning");
  assert.equal(findings.length, 2);
});

test("text reporter also escapes severity display data", () => {
  const entry = finding();
  // Exercise the display boundary even if a future producer violates the type.
  Object.defineProperty(entry, "severity", { value: `warning${controls}` });
  assert.equal(formatTextReport("/repository", [entry]), [
    "Repository Release Auditor", "Repository: /repository", "", "1 finding:", "",
    `[WARNING${escapedControls}] test-rule`, "Test title", "Test message"
  ].join("\n"));
});

test("text reporter preserves ordinary output and all printable Unicode fields", () => {
  const ordinary = "\u65e5\u672c\u8a9e caf\u00e9 e\u0301 \ud83d\udd0e \ufffd";
  const entry = finding({
    ruleId: ordinary, title: ordinary, message: ordinary,
    path: `nested/${ordinary}.txt`, evidence: ordinary, remediation: ordinary
  });
  assert.equal(formatTextReport(`/repository/${ordinary}`, [entry]), [
    "Repository Release Auditor", `Repository: /repository/${ordinary}`, "", "1 finding:", "",
    `[WARNING] ${ordinary}`, ordinary, ordinary, `Path: nested/${ordinary}.txt`,
    `Evidence: ${ordinary}`, `Remediation: ${ordinary}`
  ].join("\n"));
  assert.equal(formatTextReport("/repository", []), "Repository Release Auditor\nRepository: /repository\n\nNo findings.");
});

test("text reporter removes only its own final separator instead of trimming field contents", () => {
  const remediation = "Review this location. \u00a0\u202f";
  const output = formatTextReport("/repository", [finding({ remediation })]);
  assert.equal(output, [
    "Repository Release Auditor", "Repository: /repository", "", "1 finding:", "",
    "[WARNING] test-rule", "Test title", "Test message", `Remediation: ${remediation}`
  ].join("\n"));
});
