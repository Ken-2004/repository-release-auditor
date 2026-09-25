#!/usr/bin/env node

import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { loadConfig } from "./config/load-config.js";
import { runAudit } from "./core/audit.js";
import { findingsMeetThreshold } from "./core/exit-policy.js";
import { ArgumentError, formatDiagnostic } from "./diagnostics.js";
import { getRepositorySnapshot } from "./git/snapshot.js";
import { formatTextReport } from "./reporters/text.js";
import { formatJsonReport } from "./reporters/json.js";
import { gitCleanlinessRule } from "./rules/git-cleanliness.js";
import { riskyTrackedFileRule } from "./rules/risky-tracked-file.js";
import { developerMachinePathRule } from "./rules/developer-machine-path.js";
import { suspiciousBuildOutputRule } from "./rules/suspicious-build-output.js";
import { largeTrackedFileRule } from "./rules/large-tracked-file.js";
import { createForbiddenPatternRule } from "./rules/forbidden-pattern.js";

const VERSION = "0.1.0";

function printHelp(): void {
  console.log(`
Repository Release Auditor

Usage:
  repository-release-auditor [options] [path]

Options:
  --help, -h       Show help
  --version, -v    Show version
  --format <text|json>  Report format (default: text)
  --json           Equivalent to --format json

Arguments:
  path             Repository to inspect (default: current directory)
`.trim());
}

function parseCommandLine() {
  try {
    return parseArgs({
      allowPositionals: true,
      options: {
        help: {
          type: "boolean",
          short: "h"
        },
        version: {
          type: "boolean",
          short: "v"
        },
        format: {
          type: "string",
          multiple: true
        },
        json: {
          type: "boolean"
        }
      }
    });
  } catch {
    // Node's parser errors may echo arguments; never forward their messages.
    throw new ArgumentError("syntax");
  }
}

async function main(): Promise<void> {
  const { values, positionals } = parseCommandLine();

  const formats = values.format ?? [];
  if (formats.some((format) => format !== "text" && format !== "json")) {
    throw new ArgumentError("format");
  }
  if (new Set(formats).size > 1 || (values.json && formats.includes("text"))) {
    throw new ArgumentError("conflict");
  }
  const format = values.json ? "json" : (formats[0] ?? "text");

  if (values.help) {
    printHelp();
    return;
  }

  if (values.version) {
    console.log(VERSION);
    return;
  }

  if (positionals.length > 1) {
    throw new ArgumentError("paths");
  }

  const requestedPath = positionals[0] ?? process.cwd();
  const repositoryPath = resolve(requestedPath);

  const repository = await getRepositorySnapshot(repositoryPath);
  const config = loadConfig(repository.root);

  const findings = runAudit(
    { repository },
    [gitCleanlinessRule, riskyTrackedFileRule, developerMachinePathRule, suspiciousBuildOutputRule,
      largeTrackedFileRule, createForbiddenPatternRule(config.forbiddenPatterns)]
  );

  const report = format === "json"
    ? formatJsonReport(repository, findings, { version: VERSION })
    : formatTextReport(repository.root, findings);
  const hasWarnings = findingsMeetThreshold(findings, "warning");
  console.log(report);

  if (hasWarnings) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(formatDiagnostic(error));
  process.exitCode = 2;
});
