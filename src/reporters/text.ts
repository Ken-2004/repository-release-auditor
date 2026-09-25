import type { Finding } from "../core/types.js";
import { escapeTextDisplay } from "./escape.js";

export function formatTextReport(
  repositoryRoot: string,
  findings: readonly Finding[]
): string {
  const lines = [
    "Repository Release Auditor",
    `Repository: ${escapeTextDisplay(repositoryRoot)}`,
    ""
  ];

  if (findings.length === 0) {
    lines.push("No findings.");
    return lines.join("\n");
  }

  lines.push(
    `${findings.length} finding${findings.length === 1 ? "" : "s"}:`,
    ""
  );

  for (const finding of findings) {
    lines.push(
      `[${escapeTextDisplay(finding.severity.toUpperCase())}] ${escapeTextDisplay(finding.ruleId)}`,
      escapeTextDisplay(finding.title),
      escapeTextDisplay(finding.message)
    );

    if (finding.path !== undefined) {
      lines.push(`Path: ${escapeTextDisplay(finding.path)}`);
    }

    if (finding.evidence !== undefined) {
      lines.push(`Evidence: ${escapeTextDisplay(finding.evidence)}`);
    }

    if (finding.remediation !== undefined) {
      lines.push(`Remediation: ${escapeTextDisplay(finding.remediation)}`);
    }

    lines.push("");
  }

  return lines.slice(0, -1).join("\n");
}
