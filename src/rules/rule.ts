import type { Finding } from "../core/types.js";
import type { GitRepositorySnapshot } from "../git/snapshot.js";

export interface AuditContext {
  repository: GitRepositorySnapshot;
}

export interface AuditRule {
  id: string;
  run(context: AuditContext): Finding[];
}
