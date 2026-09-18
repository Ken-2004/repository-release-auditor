import type { Finding, Severity } from "./types.js";

const severityRank: Record<Severity, number> = {
  info: 0,
  warning: 1,
  error: 2
};

export function findingsMeetThreshold(
  findings: readonly Finding[],
  threshold: Severity
): boolean {
  const thresholdRank = severityRank[threshold];

  return findings.some(
    (finding) => severityRank[finding.severity] >= thresholdRank
  );
}
