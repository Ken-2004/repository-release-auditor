import { lstatSync } from "node:fs";
import { join } from "node:path";

import { readTrackedTextFile } from "../files/tracked-text.js";
import { CONFIG_FILENAME, type ForbiddenPattern, type RepositoryConfig } from "./types.js";

export const MAX_FORBIDDEN_PATTERNS = 100;
export const MAX_PATTERN_TEXT_LENGTH = 1024;
export const MAX_PATTERN_ID_LENGTH = 128;

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(`${CONFIG_FILENAME}: ${message}`);
    this.name = "ConfigurationError";
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validate without including user-provided keys or values in diagnostics. */
export function parseConfig(source: string): RepositoryConfig {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new ConfigurationError("invalid JSON.");
  }
  if (!isObject(value)) throw new ConfigurationError("root must be an object.");
  if (Object.keys(value).some((key) => key !== "forbiddenPatterns")) {
    throw new ConfigurationError("unknown root field.");
  }
  if (!Object.hasOwn(value, "forbiddenPatterns")) return { forbiddenPatterns: [] };
  if (!Array.isArray(value.forbiddenPatterns)) {
    throw new ConfigurationError("forbiddenPatterns must be an array.");
  }
  if (value.forbiddenPatterns.length > MAX_FORBIDDEN_PATTERNS) {
    throw new ConfigurationError(`forbiddenPatterns exceeds ${MAX_FORBIDDEN_PATTERNS} entries.`);
  }
  const ids = new Set<string>();
  const forbiddenPatterns: ForbiddenPattern[] = value.forbiddenPatterns.map((entry: unknown, index) => {
    const field = `forbiddenPatterns[${index}]`;
    if (!isObject(entry)) throw new ConfigurationError(`${field} must be an object.`);
    if (Object.keys(entry).some((key) => !["id", "text", "caseSensitive"].includes(key))) {
      throw new ConfigurationError(`${field} has an unknown field.`);
    }
    if (typeof entry.id !== "string" || entry.id.length > MAX_PATTERN_ID_LENGTH ||
        !/^[A-Za-z0-9]/.test(entry.id) || /[^A-Za-z0-9._-]/.test(entry.id)) {
      throw new ConfigurationError(`${field}.id must be a safe identifier of 1–${MAX_PATTERN_ID_LENGTH} characters.`);
    }
    if (ids.has(entry.id)) throw new ConfigurationError(`${field}.id is duplicated.`);
    ids.add(entry.id);
    if (typeof entry.text !== "string" || entry.text.length === 0 ||
        entry.text.length > MAX_PATTERN_TEXT_LENGTH || entry.text.includes("\0")) {
      throw new ConfigurationError(`${field}.text must contain 1–${MAX_PATTERN_TEXT_LENGTH} UTF-16 code units and no NUL.`);
    }
    if (Object.hasOwn(entry, "caseSensitive") && typeof entry.caseSensitive !== "boolean") {
      throw new ConfigurationError(`${field}.caseSensitive must be boolean.`);
    }
    return { id: entry.id, text: entry.text,
      caseSensitive: typeof entry.caseSensitive === "boolean" ? entry.caseSensitive : true };
  });
  return { forbiddenPatterns };
}

/** Load only the fixed root file, using the bounded reader's boundary/link checks. */
export function loadConfig(root: string): RepositoryConfig {
  try {
    lstatSync(join(root, CONFIG_FILENAME));
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { forbiddenPatterns: [] };
    }
    throw new ConfigurationError("could not inspect configuration file.");
  }
  let source: string | null;
  try {
    source = readTrackedTextFile(root, CONFIG_FILENAME);
  } catch {
    throw new ConfigurationError("could not read configuration file.");
  }
  if (source === null) {
    throw new ConfigurationError("must be a regular UTF-8 text file within the repository, at most 1 MiB, without symlinks.");
  }
  return parseConfig(source);
}
