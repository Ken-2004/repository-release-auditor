import type { Finding, Severity } from "../core/types.js";
import type { GitRepositorySnapshot } from "../git/snapshot.js";
import { escapeSerializedJson } from "./escape.js";

export function formatJsonReport(
  repository: Pick<GitRepositorySnapshot, "root" | "branch" | "head">,
  findings: readonly Finding[],
  metadata: { version: string }
): string {
  const bySeverity: Record<Severity, number> = { info: 0, warning: 0, error: 0 };
  for (const finding of findings) bySeverity[finding.severity] += 1;

  // Project only report fields; never serialize configuration or the full snapshot.
  return escapeSerializedJson(JSON.stringify({
    schemaVersion: 1,
    tool: { name: "repository-release-auditor", version: metadata.version },
    repository: { root: repository.root, branch: repository.branch, head: repository.head },
    summary: { findingCount: findings.length, bySeverity },
    findings: findings.map((finding) => ({
      ruleId: finding.ruleId,
      category: finding.category,
      severity: finding.severity,
      title: finding.title,
      message: finding.message,
      path: finding.path,
      evidence: finding.evidence,
      remediation: finding.remediation
    }))
  }, null, 2));
}
