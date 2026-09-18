import { execFile } from "node:child_process";

export interface GitCommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | string | null;
}

export class GitCommandError extends Error {
  constructor(
    message: string,
    public readonly args: readonly string[],
    public readonly cwd: string,
    public readonly stderr: string,
    public readonly exitCode: number | string | null
  ) {
    super(message);
    this.name = "GitCommandError";
  }
}

function executeGit(
  cwd: string,
  args: readonly string[]
): Promise<GitCommandResult> {
  return new Promise((resolve) => {
    execFile(
      "git",
      [...args],
      {
        cwd,
        encoding: "utf8",
        windowsHide: true,
        maxBuffer: 10 * 1024 * 1024
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({
            ok: true,
            stdout,
            stderr,
            exitCode: 0
          });
          return;
        }

        const code =
          "code" in error &&
          (typeof error.code === "number" || typeof error.code === "string")
            ? error.code
            : null;

        resolve({
          ok: false,
          stdout,
          stderr,
          exitCode: code
        });
      }
    );
  });
}

export async function tryGit(
  cwd: string,
  args: readonly string[]
): Promise<GitCommandResult> {
  return executeGit(cwd, args);
}

export async function runGit(
  cwd: string,
  args: readonly string[]
): Promise<string> {
  const result = await executeGit(cwd, args);

  if (!result.ok) {
    const command = ["git", ...args].join(" ");

    throw new GitCommandError(
      `Git command failed: ${command}`,
      args,
      cwd,
      result.stderr.trim(),
      result.exitCode
    );
  }

  return result.stdout;
}
