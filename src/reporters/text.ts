import type { Finding } from "../core/types.js";

export function formatTextReport(
  repositoryRoot: string,
  findings: readonly Finding[]
): string {
  const lines = [
    "Repository Release Auditor",
    `Repository: ${repositoryRoot}`,
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
      `[${finding.severity.toUpperCase()}] ${finding.ruleId}`,
      finding.title,
      finding.message
    );

    if (finding.path !== undefined) {
      lines.push(`Path: ${finding.path}`);
    }

    if (finding.evidence !== undefined) {
      lines.push(`Evidence: ${finding.evidence}`);
    }

    if (finding.remediation !== undefined) {
      lines.push(`Remediation: ${finding.remediation}`);
    }

    lines.push("");
  }

  return lines.join("\n").trimEnd();
}
