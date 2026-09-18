export type Severity = "info" | "warning" | "error";

export interface Finding {
  ruleId: string;
  category: string;
  severity: Severity;
  title: string;
  message: string;
  path?: string;
  evidence?: string;
  remediation?: string;
}

export interface ScanResult {
  repositoryRoot: string;
  findings: Finding[];
}
