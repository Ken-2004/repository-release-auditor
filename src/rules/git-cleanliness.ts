import type { Finding } from "../core/types.js";
import type { AuditRule } from "./rule.js";

export const gitCleanlinessRule: AuditRule = {
  id: "git-cleanliness",

  run(context) {
    const repository = context.repository;

    if (!repository.isDirty) {
      return [];
    }

    return [
      {
        ruleId: "git-cleanliness",
        category: "git",
        severity: "warning",
        title: "Working tree is not clean",
        message:
          "The repository contains staged, modified, deleted, or untracked files.",
        remediation:
          "Review `git status` and commit, discard, or intentionally ignore changes before release."
      }
    ];
  }
};
