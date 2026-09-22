import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

import { refuseGit, type GitClient } from "./git.js";

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function hasGitMarker(root: string): Promise<boolean> {
  try {
    const marker = await lstat(join(root, ".git"));
    if (marker.isSymbolicLink() || (!marker.isFile() && !marker.isDirectory())) {
      refuseGit(root, "Unsupported Git metadata boundary.");
    }
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    return refuseGit(root, "Git metadata could not be inspected safely.");
  }
}

// Discover the requested worktree independently of Git environment/config.
// A .git file is allowed for ordinary linked worktrees and submodules.
export async function findRepositoryRoot(cwd: string): Promise<string> {
  try {
    let directory = await realpath(cwd);
    if (!(await lstat(directory)).isDirectory()) {
      return refuseGit(cwd, "The scan target must be a Git worktree directory.");
    }
    for (;;) {
      if (await hasGitMarker(directory)) return directory;
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  } catch {
    return refuseGit(cwd, "The scan target could not be inspected safely.");
  }
  return refuseGit(cwd, "The scan target is not inside a Git worktree.");
}

async function verifyRoot(git: GitClient, root: string): Promise<string> {
  const output = await git.run(root, ["rev-parse", "--show-toplevel"]);
  // Remove only Git's line terminator; spaces may be part of a directory name.
  const reported = output.replace(/\r?\n$/, "");
  try {
    if (await realpath(reported) === root) return reported;
  } catch {
    // Treat a missing or inaccessible redirected root as an unsafe boundary.
  }
  return refuseGit(root, "Git worktree redirection is not supported during inspection.");
}

async function checkConfiguration(git: GitClient, root: string): Promise<void> {
  const result = await git.tryRun(root, [
    "config", "--includes", "--null", "--get-regexp",
    "^(core\\.(sparsecheckout|ignorestat)|index\\.sparse|extensions\\.partialclone|remote\\..*\\.promisor)$"
  ]);
  if (!result.ok && result.exitCode !== 1) {
    refuseGit(root, "Git configuration could not be inspected safely.");
  }
  for (const entry of result.stdout.split("\0").filter(Boolean)) {
    const separator = entry.indexOf("\n");
    const key = (separator < 0 ? entry : entry.slice(0, separator)).toLowerCase();
    const value = separator < 0 ? "true" : entry.slice(separator + 1).toLowerCase();
    if (key === "extensions.partialclone" ||
        !["", "false", "no", "off", "0"].includes(value)) {
      refuseGit(root,
        "Sparse, ignoreStat, and partial-clone configurations are not supported during inspection.");
    }
  }
}

function validGitPath(path: string): boolean {
  return path.length > 0 && !isAbsolute(path) && path.split("/").every((part) =>
    part !== "" && part !== "." && part !== ".." && part.toLowerCase() !== ".git" &&
      (process.platform !== "win32" || !/[\\:]|[. ]$/.test(part)));
}

async function submoduleRoot(root: string, path: string): Promise<string | null> {
  let directory = root;
  for (const part of path.split("/")) {
    directory = join(directory, part);
    try {
      const stat = await lstat(directory);
      if (stat.isSymbolicLink() || !stat.isDirectory() ||
          await realpath(directory) !== directory) {
        refuseGit(root, "Unsupported submodule worktree boundary.");
      }
    } catch (error) {
      if (isMissing(error)) return null; // Uninitialized/deleted submodule.
      return refuseGit(root, "Submodule worktree could not be inspected safely.");
    }
  }
  return await hasGitMarker(directory) ? directory : null;
}

export async function inspectRepository(
  git: GitClient,
  root: string
): Promise<{ root: string; head: string | null; trackedFiles: string[] }> {
  const visited = new Set<string>();
  const inspect = async (directory: string, depth: number): Promise<{
    root: string; head: string | null; trackedFiles: string[];
  }> => {
    if (depth > 16 || visited.size >= 128 || visited.has(directory)) {
      refuseGit(root, "Submodule inspection exceeded its supported limits.");
    }
    visited.add(directory);
    const reportedRoot = await verifyRoot(git, directory);
    await checkConfiguration(git, directory);
    const head = await readHead(git, directory);

    // -v exposes flags which otherwise make status skip worktree comparisons.
    const output = await git.run(directory, ["ls-files", "--stage", "-v", "-z"]);
    const paths = new Set<string>();
    const submodules = new Set<string>();
    for (const record of output.split("\0").filter(Boolean)) {
      const match = /^([A-Za-z?]) ([0-7]{6}) [0-9a-f]+ ([0-3])\t([\s\S]+)$/.exec(record);
      if (match === null || !validGitPath(match[4]!)) {
        refuseGit(directory, "Unsupported Git index entry.");
      }
      const [, flag, mode, stage, path] = match;
      if (flag === flag!.toLowerCase() || flag === "S" || mode === "040000") {
        refuseGit(directory,
          "Assume-unchanged, skip-worktree, and sparse index entries prevent complete inspection.");
      }
      paths.add(path!);
      if (mode === "160000") {
        if (stage !== "0") {
          refuseGit(directory, "Conflicted submodule entries prevent safe inspection.");
        }
        submodules.add(path!);
      }
    }
    const trackedFiles = [...paths];
    if (trackedFiles.length > 0) {
      const attributes = await git.run(directory,
        ["check-attr", "--all", "-z", "--stdin"], trackedFiles.join("\0") + "\0");
      const fields = attributes.split("\0");
      if (fields.pop() !== "" || fields.length % 3 !== 0) {
        refuseGit(directory, "Git attributes could not be inspected safely.");
      }
      for (let i = 1; i < fields.length; i += 3) {
        // --all distinguishes absent attributes from drivers literally named
        // "unspecified" or "unset". Even explicit -filter is refused so this
        // preflight never has to infer executable-driver semantics.
        if (fields[i] === "filter") {
          refuseGit(directory, "Tracked filter attributes are not supported during safe inspection.");
        }
      }
    }
    for (const path of submodules) {
      const child = await submoduleRoot(directory, path);
      if (child !== null) await inspect(child, depth + 1);
    }
    return { root: reportedRoot, head, trackedFiles };
  };
  return inspect(root, 0);
}

async function readHead(git: GitClient, root: string): Promise<string | null> {
  const head = await git.tryRun(root, ["rev-parse", "--verify", "HEAD^{commit}"]);
  if (head.ok && /^[0-9a-f]{40,64}\r?\n$/.test(head.stdout)) {
    return head.stdout.trim();
  }
  // Only a missing branch ref is an unborn repository. Failed object reads,
  // invalid HEAD, timeouts, and detached/corrupt refs must not become null.
  if (typeof head.exitCode !== "number" || head.exitCode === 0) {
    return refuseGit(root, "Git HEAD could not be inspected completely.");
  }
  const symbolic = await git.tryRun(root, ["symbolic-ref", "--quiet", "HEAD"]);
  const ref = symbolic.stdout.replace(/\r?\n$/, "");
  if (symbolic.ok && ref.startsWith("refs/heads/")) {
    const present = await git.tryRun(root, ["show-ref", "--verify", "--quiet", ref]);
    if (present.exitCode === 1) return null;
  }
  return refuseGit(root, "Git HEAD could not be inspected completely.");
}
