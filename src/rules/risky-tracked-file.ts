import { posix } from "node:path";

import type { AuditRule } from "./rule.js";

const riskyFilenames = new Set([
  ".npmrc",
  ".pypirc",
  ".netrc",
  "_netrc",
  "credentials.json",
  "service-account.json",
  "service-account-key.json",
  "account-key.json",
  "secrets.json",
  "secrets.yml",
  "secrets.yaml",
  "id_rsa",
  "id_ed25519",
  "id_dsa",
  "id_ecdsa",
  "private-key.pem"
]);

const envTemplateMarkers = new Set(["example", "sample", "template", "dist"]);
const privateKeyExtensions = new Set([".p12", ".pfx", ".key"]);

export function isRiskyTrackedPath(path: string): boolean {
  // Git paths use '/', even on Windows. A literal backslash is not a separator.
  const normalized = posix.normalize(path).toLowerCase();
  const filename = posix.basename(normalized);

  if (filename === ".env") {
    return true;
  }

  if (filename.startsWith(".env.")) {
    return !filename.slice(5).split(".").some((part) => envTemplateMarkers.has(part));
  }

  if (riskyFilenames.has(filename) || privateKeyExtensions.has(posix.extname(filename))) {
    return true;
  }

  return posix.basename(posix.dirname(normalized)) === ".aws" &&
    (filename === "credentials" || filename === "config");
}

export const riskyTrackedFileRule: AuditRule = {
  id: "risky-tracked-file",

  run({ repository }) {
    // Unmerged index entries can repeat a path; report each path only once.
    const paths = [...new Set(repository.trackedFiles.map((path) => posix.normalize(path)))];

    return paths.filter(isRiskyTrackedPath).sort().map((path) => ({
      ruleId: "risky-tracked-file",
      category: "repository",
      severity: "warning",
      title: "Potentially sensitive file is tracked",
      message:
        "This tracked path commonly holds credentials or private key material. Its contents have not been inspected.",
      path,
      remediation:
        "Verify whether this file contains sensitive information. If necessary, remove it from version control and Git history, and rotate any exposed credentials."
    }));
  }
};
