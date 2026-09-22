import { posix } from "node:path";

import type { Finding } from "../core/types.js";
import { getTrackedFileSize } from "../files/tracked-file-size.js";
import type { AuditRule } from "./rule.js";

export const LARGE_TRACKED_FILE_BYTES = 50 * 1024 * 1024;

export const largeTrackedFileRule: AuditRule = {
  id: "large-tracked-file",

  run({ repository }) {
    const findings: Finding[] = [];
    const paths = [...new Set(repository.trackedFiles.map((path) => posix.normalize(path)))].sort();
    for (const path of paths) {
      const size = getTrackedFileSize(repository.root, path);
      if (size === null || size < LARGE_TRACKED_FILE_BYTES) continue;
      findings.push({
        ruleId: "large-tracked-file",
        category: "repository",
        severity: "warning",
        title: "Large tracked file",
        message:
          "This worktree file is at least 50 MiB. Large files can increase repository clone size and history weight, but may be intentionally versioned.",
        path,
        evidence: `${size} bytes`,
        remediation:
          "Verify whether this file belongs in Git. Consider external artifact storage or Git LFS where appropriate."
      });
    }
    return findings;
  }
};
