import type { Finding } from "./types.js";
import type { AuditContext, AuditRule } from "../rules/rule.js";

export function runAudit(
  context: AuditContext,
  rules: readonly AuditRule[]
): Finding[] {
  return rules.flatMap((rule) => rule.run(context));
}
