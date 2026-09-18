import { posix } from "node:path";

import type { AuditRule } from "./rule.js";

const generatedDirectories = new Set([
  "node_modules", "coverage", ".next", ".nuxt", "__pycache__", "obj", "dist", "build"
]);
const compiledExtensions = new Set([
  ".o", ".obj", ".class", ".pyc", ".pyo", ".exe", ".dll", ".so", ".dylib"
]);

export function isSuspiciousBuildPath(path: string): boolean {
  // Git uses POSIX separators on every platform; backslashes remain literal.
  const normalized = posix.normalize(path).toLowerCase();
  const parts = normalized.split("/");
  if (parts.includes(".git")) return false;

  const directories = parts.slice(0, -1);
  if (directories.some((part) => generatedDirectories.has(part))) return true;

  // A bare "target" directory is ambiguous; recognize Cargo's common profiles.
  if (directories.some((part, index) => part === "target" &&
    (directories[index + 1] === "debug" || directories[index + 1] === "release")
  )) return true;

  return compiledExtensions.has(posix.extname(normalized));
}

export const suspiciousBuildOutputRule: AuditRule = {
  id: "suspicious-build-output",

  run({ repository }) {
    const paths = [...new Set(repository.trackedFiles.map((path) => posix.normalize(path)))];
    return paths.filter(isSuspiciousBuildPath).sort().map((path) => ({
      ruleId: "suspicious-build-output",
      category: "repository",
      severity: "warning",
      title: "Possible generated or compiled output is tracked",
      message:
        "This path resembles generated or compiled output that is often excluded from source repositories. It may be intentionally versioned.",
      path,
      remediation:
        "Verify whether this artifact is intentionally versioned. If not, remove it from Git and add an appropriate ignore rule."
    }));
  }
};
