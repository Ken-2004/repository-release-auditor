import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";

function isInside(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return suffix !== "" && !isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`);
}

/** Measure a regular worktree file without reading contents or following links. */
export function getTrackedFileSize(root: string, gitPath: string): number | null {
  const parts = gitPath.split("/");
  if (parts.some((part) => part === "" || part === "." || part === ".." || part.includes("\0")) ||
      (process.platform === "win32" && parts.some((part) => /[\\:]|[. ]$/.test(part)))) {
    return null;
  }

  try {
    const realRoot = realpathSync(root);
    let path = realRoot;
    for (const [index, part] of parts.entries()) {
      path = join(path, part);
      if (!isInside(realRoot, path)) return null;
      const metadata = lstatSync(path);
      // Check every component: a parent directory may be a symlink or junction.
      if (metadata.isSymbolicLink()) return null;
      if (index === parts.length - 1) {
        return metadata.isFile() && isInside(realRoot, realpathSync(path))
          ? metadata.size
          : null;
      }
      if (!metadata.isDirectory()) return null;
    }
    return null;
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error &&
        ["ENOENT", "ENOTDIR", "ELOOP"].includes(String(error.code))) return null;
    throw error;
  }
}
