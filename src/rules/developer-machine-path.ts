import { readTrackedTextFile } from "../files/tracked-text.js";
import type { Finding } from "../core/types.js";
import type { AuditRule } from "./rule.js";

interface MachinePathMatch {
  line: number;
  kind: "Windows drive path" | "Unix home path" | "WSL home path";
}

function isConcreteComponent(value: string | undefined): boolean {
  return value !== undefined && /^[\p{L}\p{N}_.-]+$/u.test(value) &&
    !/^\.+$/.test(value) && !/^__.*__$/.test(value);
}

/** Return location/category only; never retain the matched path in evidence. */
export function findDeveloperMachinePath(text: string): MachinePathMatch | null {
  // Mask URLs without changing offsets or line numbers, including query values.
  const searchable = text.replace(/(?:\b[a-z][a-z0-9+.-]*:)?\/\/[^\s"'`<>]+/gi,
    (url) => " ".repeat(url.length));
  const candidates = /(?<![\p{L}\p{N}_./\\~:%$-])(?:[a-z]:[\\/]+|\/home\/|\/Users\/|\/mnt\/[a-z]\/(?:Users|home)\/)[^\s"'`]+/giu;

  for (const match of searchable.matchAll(candidates)) {
    const path = match[0].replace(/[),;:\]}]+$/, "");
    const windows = /^[a-z]:/i.test(path);
    const parts = path.split(/[\\/]+/);
    let kind: MachinePathMatch["kind"];
    let component: string | undefined;
    if (windows) {
      // Common system/runtime locations do not establish a developer path.
      if (/^[a-z]:[\\/]+(?:Windows|Program Files(?: \(x86\))?|ProgramData|Temp)(?=[\\/\s"'`),;]|$)/i
        .test(searchable.slice(match.index))) continue;
      kind = "Windows drive path";
      component = parts[1]?.toLowerCase() === "users" ? parts[2] : parts[1];
    } else if (/^\/mnt\//i.test(path)) {
      kind = "WSL home path";
      component = parts[4];
    } else {
      kind = "Unix home path";
      component = parts[2];
    }
    if (!isConcreteComponent(component)) continue;
    return { line: text.slice(0, match.index).split(/\r\n|\r|\n/).length, kind };
  }
  return null;
}

export const developerMachinePathRule: AuditRule = {
  id: "developer-machine-path",

  run({ repository }) {
    const findings: Finding[] = [];
    for (const path of [...new Set(repository.trackedFiles)].sort()) {
      const text = readTrackedTextFile(repository.root, path);
      if (text === null) continue;
      const match = findDeveloperMachinePath(text);
      if (match === null) continue;
      findings.push({
        ruleId: "developer-machine-path",
        category: "repository",
        severity: "warning",
        title: "Developer-machine absolute path in tracked text",
        message: "A machine-specific path may expose local details or make this file non-portable.",
        path,
        evidence: `Line ${match.line}: ${match.kind}; value redacted.`,
        remediation:
          "Replace machine-specific paths with relative paths, environment variables, configuration, or documented placeholders."
      });
    }
    return findings;
  }
};
