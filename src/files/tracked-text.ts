import { isUtf8 } from "node:buffer";
import {
  closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync
} from "node:fs";
import { isAbsolute, join, posix, relative, sep } from "node:path";

export const MAX_TEXT_FILE_BYTES = 1024 * 1024;

const textExtensions = new Set([
  ".txt", ".md", ".mdx", ".rst", ".adoc", ".json", ".jsonc", ".yaml", ".yml",
  ".toml", ".ini", ".cfg", ".conf", ".properties", ".xml", ".html", ".htm",
  ".css", ".scss", ".less", ".js", ".mjs", ".cjs", ".jsx", ".ts", ".mts",
  ".cts", ".tsx", ".py", ".rb", ".go", ".rs", ".java", ".c", ".h", ".cpp",
  ".hpp", ".cs", ".sh", ".bash", ".zsh", ".ps1", ".psm1", ".bat", ".cmd",
  ".sql", ".tf", ".tfvars"
]);
const textFilenames = new Set([
  "readme", "dockerfile", "makefile", "gemfile", "rakefile", "jenkinsfile",
  ".gitignore", ".gitattributes", ".gitmodules", ".editorconfig", ".npmrc",
  ".pypirc", ".netrc", "_netrc", ".env"
]);

function isInside(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return suffix !== "" && !isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`);
}

/** Read a supported worktree text file, or return null for safely skipped files. */
export function readTrackedTextFile(root: string, gitPath: string): string | null {
  const parts = gitPath.split("/");
  // Reject traversal and Windows aliases/alternate streams before touching disk.
  if (parts.some((part) => part === "" || part === "." || part === ".." || part.includes("\0")) ||
      (process.platform === "win32" && parts.some((part) => /[\\:]|[. ]$/.test(part)))) {
    return null;
  }
  const filename = posix.basename(gitPath).toLowerCase();
  if (!textExtensions.has(posix.extname(filename)) && !textFilenames.has(filename) &&
      !filename.startsWith(".env.")) {
    return null;
  }

  let descriptor: number | undefined;
  try {
    const realRoot = realpathSync(root);
    let path = realRoot;
    for (const part of parts) {
      path = join(path, part);
      if (!isInside(realRoot, path) || lstatSync(path).isSymbolicLink()) return null;
    }
    const before = lstatSync(path);
    if (!before.isFile() || before.size > MAX_TEXT_FILE_BYTES ||
        !isInside(realRoot, realpathSync(path))) return null;

    // O_NOFOLLOW protects the final component where supported; O_NONBLOCK avoids
    // blocking on a FIFO substituted between lstat and open on POSIX systems.
    descriptor = openSync(path, constants.O_RDONLY |
      (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.size > MAX_TEXT_FILE_BYTES ||
        opened.dev !== before.dev || opened.ino !== before.ino ||
        !isInside(realRoot, realpathSync(path))) return null;

    // Bound the actual read as well as the stat check, in case the file grows.
    const buffer = Buffer.alloc(opened.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(descriptor, buffer, length, buffer.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length === buffer.length) return null; // Oversized or grew since fstat.
    const bytes = buffer.subarray(0, length);
    // Validate bytes before decoding. UTF-16 and other encodings are unsupported.
    if (!isUtf8(bytes) || bytes.some((byte) =>
      (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) || byte === 127
    )) return null;
    return bytes.toString("utf8");
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error &&
        ["ENOENT", "ENOTDIR", "ELOOP"].includes(String(error.code))) return null;
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}
