#!/usr/bin/env node

import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { GitCommandError } from "./git/git.js";
import { getRepositorySnapshot } from "./git/snapshot.js";

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

  const requestedPath = positionals[0] ?? process.cwd();
  const repositoryPath = resolve(requestedPath);

  try {
    const snapshot = await getRepositorySnapshot(repositoryPath);

    console.log(`Repository Release Auditor ${VERSION}`);
    console.log(`Repository: ${snapshot.root}`);
    console.log(`Branch: ${snapshot.branch ?? "(detached)"}`);
    console.log(`HEAD: ${snapshot.head ?? "(no commits)"}`);
    console.log(`Tracked files: ${snapshot.trackedFiles.length}`);
    console.log(`Working tree: ${snapshot.isDirty ? "dirty" : "clean"}`);
    console.log("No audit rules are implemented yet.");
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

    throw error;
  }
}

main().catch((error: unknown) => {
  console.error("Unexpected runtime error.");
  console.error(error);
  process.exitCode = 2;
});
