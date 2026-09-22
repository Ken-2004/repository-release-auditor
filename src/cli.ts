#!/usr/bin/env node

import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { ConfigurationError, loadConfig } from "./config/load-config.js";
import { runAudit } from "./core/audit.js";
import { findingsMeetThreshold } from "./core/exit-policy.js";
import { GitCommandError } from "./git/git.js";
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

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
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

  const formats = values.format ?? [];
  if (formats.some((format) => format !== "text" && format !== "json")) {
    throw new Error("Expected --format text or --format json.");
  }
  if (new Set(formats).size > 1 || (values.json && formats.includes("text"))) {
    throw new Error("Conflicting output formats; choose text or json.");
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
    console.error("Expected at most one repository path.");
    process.exitCode = 2;
    return;
  }

  const requestedPath = positionals[0] ?? process.cwd();
  const repositoryPath = resolve(requestedPath);

  try {
    const repository = await getRepositorySnapshot(repositoryPath);
    const config = loadConfig(repository.root);

    const findings = runAudit(
      { repository },
      [gitCleanlinessRule, riskyTrackedFileRule, developerMachinePathRule, suspiciousBuildOutputRule,
        largeTrackedFileRule, createForbiddenPatternRule(config.forbiddenPatterns)]
    );

    console.log(
      format === "json"
        ? formatJsonReport(repository, findings, { version: VERSION })
        : formatTextReport(repository.root, findings)
    );

    if (findingsMeetThreshold(findings, "warning")) {
      process.exitCode = 1;
    }
  } catch (error: unknown) {
    if (error instanceof ConfigurationError) {
      console.error(`Configuration error: ${error.message}`);
      process.exitCode = 2;
      return;
    }
    if (error instanceof GitCommandError) {
      console.error("Repository scan could not start.");
      console.error(error.message);

      if (error.stderr.length > 0) {
        console.error(error.stderr);
      }

      process.exitCode = 2;
      return;
    }

    console.error("Unexpected runtime error.");
    console.error(error);
    process.exitCode = 2;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
});
