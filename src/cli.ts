#!/usr/bin/env node

import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { runAudit } from "./core/audit.js";
import { findingsMeetThreshold } from "./core/exit-policy.js";
import { GitCommandError } from "./git/git.js";
import { getRepositorySnapshot } from "./git/snapshot.js";
import { formatTextReport } from "./reporters/text.js";
import { gitCleanlinessRule } from "./rules/git-cleanliness.js";

const VERSION = "0.1.0";

function printHelp(): void {
  console.log(`
Repository Release Auditor

Usage:
  repository-release-auditor [options] [path]

Options:
  --help, -h       Show help
  --version, -v    Show version

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
      }
    }
  });

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

    const findings = runAudit(
      { repository },
      [gitCleanlinessRule]
    );

    console.log(
      formatTextReport(repository.root, findings)
    );

    if (findingsMeetThreshold(findings, "warning")) {
      process.exitCode = 1;
    }
  } catch (error: unknown) {
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
