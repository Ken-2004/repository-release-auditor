import { CONFIG_FILENAME, type ForbiddenPattern } from "../config/types.js";
import type { Finding } from "../core/types.js";
import { readTrackedTextFile } from "../files/tracked-text.js";
import type { AuditRule } from "./rule.js";

function firstMatchLine(text: string, needle: string): number | null {
  const index = text.indexOf(needle);
  if (index < 0) return null;
  let line = 1;
  for (const ending of text.matchAll(/\r\n|\r|\n/g)) {
    if (ending.index + ending[0].length > index) break;
    line += 1;
  }
  return line;
}

export function createForbiddenPatternRule(patterns: readonly ForbiddenPattern[]): AuditRule {
  const prepared = patterns.map((pattern) => ({
    ...pattern,
    needle: pattern.caseSensitive ? pattern.text : pattern.text.toLowerCase()
  })).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

  return {
    id: "forbidden-pattern",
    run({ repository }) {
      const findings: Finding[] = [];
      if (prepared.length === 0) return findings;
      for (const path of [...new Set(repository.trackedFiles)].sort()) {
        if (path === CONFIG_FILENAME ||
            (process.platform === "win32" && path.toLowerCase() === CONFIG_FILENAME)) continue;
        const text = readTrackedTextFile(repository.root, path);
        if (text === null) continue;
        let lowercase: string | undefined;
        for (const pattern of prepared) {
          // Count lines in the searched text: Unicode lowercasing can expand
          // characters, but leaves line endings intact. No original offset needed.
          const searchable = pattern.caseSensitive ? text : (lowercase ??= text.toLowerCase());
          const line = firstMatchLine(searchable, pattern.needle);
          if (line === null) continue;
          findings.push({
            ruleId: "forbidden-pattern",
            category: "repository",
            severity: "warning",
            title: "Configured forbidden pattern in tracked text",
            message: "This file matches a literal pattern prohibited by repository policy.",
            path,
            evidence: `Line ${line}: matched configured pattern "${pattern.id}"; value redacted.`,
            remediation: "Review this location and remove or replace the prohibited text, or intentionally revise the repository policy."
          });
        }
      }
      return findings;
    }
  };
}
