import { ConfigurationError, MAX_FORBIDDEN_PATTERNS, MAX_PATTERN_ID_LENGTH,
  MAX_PATTERN_TEXT_LENGTH } from "./config/load-config.js";
import { CONFIG_FILENAME } from "./config/types.js";
import { GitCommandError } from "./git/git.js";

const argumentMessages = {
  syntax: "Invalid command-line arguments. Use --help for usage.",
  format: "Expected --format text or --format json.",
  conflict: "Conflicting output formats; choose text or json.",
  paths: "Expected at most one repository path."
} as const;

export class ArgumentError extends Error {
  constructor(reason: keyof typeof argumentMessages) {
    super(argumentMessages[reason]);
    this.name = "ArgumentError";
  }
}

// Only these authored messages may cross the CLI boundary. Error.message alone
// is not trusted, even on a known error type; an unknown detail fails closed.
const gitMessages = new Set([
  "A trusted Git executable was not found on PATH.",
  "The Git inspection root could not be resolved safely.",
  "Git inspection exceeded its execution budget.",
  "Git output is not valid UTF-8; inspection cannot continue safely.",
  "Git inspection failed or exceeded its execution limits.",
  "Git 2.36 or newer is required for safe inspection.",
  "Unsupported Git metadata boundary.",
  "Git metadata could not be inspected safely.",
  "The scan target must be a Git worktree directory.",
  "The scan target could not be inspected safely.",
  "The scan target is not inside a Git worktree.",
  "Git worktree redirection is not supported during inspection.",
  "Git configuration could not be inspected safely.",
  "Sparse, ignoreStat, and partial-clone configurations are not supported during inspection.",
  "Unsupported submodule worktree boundary.",
  "Submodule worktree could not be inspected safely.",
  "Submodule inspection exceeded its supported limits.",
  "Unsupported Git index entry.",
  "Assume-unchanged, skip-worktree, and sparse index entries prevent complete inspection.",
  "Conflicted submodule entries prevent safe inspection.",
  "Git attributes could not be inspected safely.",
  "Tracked filter attributes are not supported during safe inspection.",
  "Git HEAD could not be inspected completely."
]);

const configurationMessages = new Set([
  "invalid JSON.",
  "root must be an object.",
  "unknown root field.",
  "forbiddenPatterns must be an array.",
  `forbiddenPatterns exceeds ${MAX_FORBIDDEN_PATTERNS} entries.`,
  "could not inspect configuration file.",
  "could not read configuration file.",
  "must be a regular UTF-8 text file within the repository, at most 1 MiB, without symlinks.",
  ...Array.from({ length: MAX_FORBIDDEN_PATTERNS }, (_, index) => [
    " must be an object.",
    " has an unknown field.",
    `.id must be a safe identifier of 1–${MAX_PATTERN_ID_LENGTH} characters.`,
    ".id is duplicated.",
    `.text must contain 1–${MAX_PATTERN_TEXT_LENGTH} UTF-16 code units and no NUL.`,
    ".caseSensitive must be boolean."
  ].map((suffix) => `forbiddenPatterns[${index}]${suffix}`)).flat()
].map((message) => `${CONFIG_FILENAME}: ${message}`));

function knownMessage(error: object, messages: ReadonlySet<string>, fallback: string): string {
  // Do not call getters, inspect custom properties, or convert thrown objects.
  const message: unknown = Object.getOwnPropertyDescriptor(error, "message")?.value;
  return typeof message === "string" && message.length <= 256 && messages.has(message)
    ? message : fallback;
}

/** Bounded, authored diagnostics only; no stacks, causes, stderr or values. */
export function formatDiagnostic(error: unknown): string {
  try {
    if (error instanceof ArgumentError) {
      return knownMessage(error, new Set(Object.values(argumentMessages)), argumentMessages.syntax);
    }
    if (error instanceof ConfigurationError) {
      return "Configuration error: " + knownMessage(error, configurationMessages,
        `${CONFIG_FILENAME}: could not load a valid configuration.`);
    }
    if (error instanceof GitCommandError) {
      return "Repository scan could not start.\n" + knownMessage(error, gitMessages,
        "Git inspection could not be completed safely.");
    }
  } catch {
    // Even prototype/descriptor traps on an unknown thrown object may throw.
  }
  return "Repository scan failed because of an unexpected runtime or filesystem error.";
}
