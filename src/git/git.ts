import { execFile, type ChildProcess } from "node:child_process";
import { isUtf8 } from "node:buffer";
import { access, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { devNull } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, sep } from "node:path";

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

const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
const COMMAND_TIMEOUT_MS = 10_000;
const INSPECTION_TIMEOUT_MS = 60_000;

// Callers supply only fixed diagnostics, never Git output or configuration values.
export function refuseGit(cwd: string, message: string): never {
  throw new GitCommandError(message, [], cwd, "", null);
}

function isWithin(root: string, path: string): boolean {
  const difference = relative(root, path);
  return difference === "" ||
    (!isAbsolute(difference) && difference !== ".." &&
      !difference.startsWith(`..${sep}`));
}

async function resolveSearchDirectories(root: string, searchPath: string): Promise<string[]> {
  const directories: string[] = [];
  for (const entry of searchPath.split(delimiter)) {
    // Never search the current directory, a relative PATH entry, or the target.
    if (!isAbsolute(entry)) continue;
    try {
      const directory = await realpath(entry);
      if (!isWithin(root, directory) && (await stat(directory)).isDirectory()) {
        directories.push(directory);
      }
    } catch {
      // Unavailable optional PATH entries cannot supply trusted child tools.
    }
  }
  return directories;
}

async function resolveGit(root: string, directories: readonly string[]): Promise<string> {
  for (const directory of directories) {
    try {
      const executable = await realpath(join(directory,
        process.platform === "win32" ? "git.exe" : "git"));
      if (isWithin(root, executable)) continue;
      await access(executable, constants.X_OK);
      return executable;
    } catch {
      // Continue searching ordinary absolute PATH entries.
    }
  }
  return refuseGit(root, "A trusted Git executable was not found on PATH.");
}

export interface GitClient {
  tryRun(cwd: string, args: readonly string[], input?: string): Promise<GitCommandResult>;
  run(cwd: string, args: readonly string[], input?: string): Promise<string>;
}

export async function createGitClient(root: string): Promise<GitClient> {
  // Direct callers may supply a short path or directory alias. All containment
  // comparisons must use filesystem-resolved paths, including the root.
  const canonicalRoot = await realpath(root).catch(() =>
    refuseGit(root, "The Git inspection root could not be resolved safely."));
  const env: NodeJS.ProcessEnv = {};
  let searchPath = "";
  for (const [key, value] of Object.entries(process.env)) {
    if (key.toUpperCase() === "PATH") {
      searchPath = value ?? "";
    } else if (!/^GIT_/i.test(key) && !/^SUDO_UID$/i.test(key)) {
      env[key] = value;
    }
  }
  const directories = await resolveSearchDirectories(canonicalRoot, searchPath);
  const executable = await resolveGit(canonicalRoot, directories);
  // Child Git commands (notably submodule status) use the same trusted install.
  env.PATH = [dirname(executable), ...directories].join(delimiter);
  Object.assign(env, {
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "",
    SSH_ASKPASS: "",
    GCM_INTERACTIVE: "never",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_NO_LAZY_FETCH: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_PROTOCOL_FROM_USER: "0",
    GIT_ALLOW_PROTOCOL: "",
    LC_ALL: "C"
  });
  const deadline = Date.now() + INSPECTION_TIMEOUT_MS;
  let commands = 0;

  const tryRun: GitClient["tryRun"] = async (cwd, args, input) => {
    const timeout = Math.min(COMMAND_TIMEOUT_MS, deadline - Date.now());
    if (timeout <= 0 || ++commands > 512 ||
        (input !== undefined && Buffer.byteLength(input) > MAX_OUTPUT_BYTES)) {
      refuseGit(cwd, "Git inspection exceeded its execution budget.");
    }
    return new Promise((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = execFile(executable, [
          "--no-pager",
          "-c", `core.hooksPath=${devNull}`,
          "-c", "core.fsmonitor=false",
          "-c", "core.untrackedCache=false",
          "-c", "protocol.allow=never",
          ...args
        ], {
          cwd, env, encoding: "buffer", windowsHide: true,
          maxBuffer: MAX_OUTPUT_BYTES, timeout, killSignal: "SIGKILL"
        }, (error, stdout) => {
          // Validate the original bytes before decoding any paths. Replacement
          // decoding could make attribute preflight inspect a different filename
          // from the one Git status later inspects. Literal UTF-8 U+FFFD is valid.
          if (!isUtf8(stdout)) {
            reject(new GitCommandError(
              "Git output is not valid UTF-8; inspection cannot continue safely.",
              args, cwd, "", null
            ));
            return;
          }
          const exitCode = error === null ? 0 : error.killed ? null :
            typeof error.code === "number" || typeof error.code === "string"
              ? error.code : null;
          // Git diagnostics may contain private configuration or paths. Do not
          // propagate them to the CLI, including on output overflow or timeout.
          resolve({ ok: error === null, stdout: stdout.toString("utf8"), stderr: "", exitCode });
        });
      } catch {
        // Process creation can throw before the callback (for example, an
        // invalid executable on Windows). Never propagate the raw Node error.
        reject(new GitCommandError(
          "Git inspection failed or exceeded its execution limits.",
          [], cwd, "", null
        ));
        return;
      }
      // These commands never accept interactive input. EPIPE is reported by
      // the command result if Git exits before consuming the supplied paths.
      child.stdin?.on("error", () => {});
      child.stdin?.end(input);
    });
  };
  const run: GitClient["run"] = async (cwd, args, input) => {
    const result = await tryRun(cwd, args, input);
    if (!result.ok) {
      throw new GitCommandError(
        "Git inspection failed or exceeded its execution limits.",
        args, cwd, "", result.exitCode
      );
    }
    return result.stdout;
  };

  // Older versions can interpret fsmonitor=false as the name of a hook.
  // Check before any repository/index operation, even read-only ones.
  const version = await run(canonicalRoot, ["--version"]);
  const match = /^git version (\d+)\.(\d+)(?:\.|\s)/.exec(version);
  if (match === null || Number(match[1]) < 2 ||
      (Number(match[1]) === 2 && Number(match[2]) < 36)) {
    refuseGit(root, "Git 2.36 or newer is required for safe inspection.");
  }
  return { tryRun, run };
}
