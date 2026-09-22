import { createGitClient } from "./git.js";
import { findRepositoryRoot, inspectRepository } from "./inspection.js";

export interface GitRepositorySnapshot {
  root: string;
  branch: string | null;
  head: string | null;
  trackedFiles: string[];
  statusEntries: string[];
  isDirty: boolean;
}

function splitNullDelimited(value: string): string[] {
  if (value.length === 0) {
    return [];
  }

  return value.split("\0").filter((entry) => entry.length > 0);
}

export async function getRepositorySnapshot(
  cwd: string
): Promise<GitRepositorySnapshot> {
  const requestedRoot = await findRepositoryRoot(cwd);
  const git = await createGitClient(requestedRoot);
  // Preflight the complete initialized submodule tree before status is allowed
  // to inspect it. Command overrides propagate to Git's child processes.
  const { root, head, trackedFiles } = await inspectRepository(git, requestedRoot);

  const branchOutput = await git.run(root, [
    "branch",
    "--show-current"
  ]);

  const branch = branchOutput.trim() || null;

  const statusOutput = await git.run(root, [
    "status",
    "--porcelain=v1",
    "-z",
    "--ignore-submodules=none",
    "--untracked-files=all"
  ]);

  const statusEntries = splitNullDelimited(statusOutput);

  return {
    root,
    branch,
    head,
    trackedFiles,
    statusEntries,
    isDirty: statusEntries.length > 0
  };
}
