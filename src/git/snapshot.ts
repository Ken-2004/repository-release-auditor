import { runGit, tryGit } from "./git.js";

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
  const rootOutput = await runGit(cwd, [
    "rev-parse",
    "--show-toplevel"
  ]);

  const root = rootOutput.trim();

  const branchOutput = await runGit(root, [
    "branch",
    "--show-current"
  ]);

  const branch = branchOutput.trim() || null;

  const headResult = await tryGit(root, [
    "rev-parse",
    "--verify",
    "HEAD"
  ]);

  const head =
    headResult.ok && headResult.stdout.trim().length > 0
      ? headResult.stdout.trim()
      : null;

  const trackedOutput = await runGit(root, [
    "ls-files",
    "-z"
  ]);

  const trackedFiles = splitNullDelimited(trackedOutput);

  const statusOutput = await runGit(root, [
    "status",
    "--porcelain=v1",
    "-z",
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
