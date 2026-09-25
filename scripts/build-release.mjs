import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

// This is a checkout build helper, never an installed CLI operation. Its own
// location selects the package; arguments, CWD and INIT_CWD cannot select output.
let failureReason = "package root could not be verified.";

try {
  if (process.argv.length !== 2) {
    failureReason = "arguments are not supported.";
    throw new Error();
  }

  const packageRoot = realpathSync(dirname(dirname(realpathSync(fileURLToPath(import.meta.url)))));
  const metadata = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  if (metadata.name !== "repository-release-auditor" || metadata.private !== true) {
    throw new Error();
  }

  const output = join(packageRoot, "dist");
  const releaseConfig = join(packageRoot, "tsconfig.release.json");
  const compiler = join(packageRoot, "node_modules", "typescript", "bin", "tsc");
  if (!lstatSync(releaseConfig).isFile() || !lstatSync(compiler).isFile()) {
    throw new Error();
  }

  failureReason = "output boundary is unsafe or could not be inspected.";
  let outputExists = true;
  try {
    lstatSync(output);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    outputExists = false;
  }

  if (outputExists) {
    // Check the entire fixed tree before deleting anything. Refuse links even
    // when they currently point inward. This assumes a stable, trusted checkout
    // filesystem; it does not attempt to sandbox concurrent filesystem changes.
    const pending = [output];
    while (pending.length !== 0) {
      const current = pending.pop();
      const info = lstatSync(current);
      if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) {
        throw new Error();
      }
      const insideOutput = relative(output, realpathSync(current));
      if (isAbsolute(insideOutput) || insideOutput === ".." || insideOutput.startsWith(`..${sep}`)) {
        throw new Error();
      }
      if (current === output && !info.isDirectory()) throw new Error();
      if (info.isDirectory()) {
        for (const entry of readdirSync(current)) pending.push(join(current, entry));
      }
    }

    failureReason = "generated output could not be removed.";
    rmSync(output, { recursive: true });
  }

  failureReason = "compilation failed; run npm run check for diagnostics.";
  const result = spawnSync(process.execPath, [compiler, "-p", releaseConfig, "--outDir", output], {
    cwd: packageRoot,
    shell: false,
    stdio: "ignore",
    timeout: 120_000,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) throw new Error();
} catch {
  // Compiler and filesystem messages can contain source text or local paths.
  console.error(`Release build failed: ${failureReason}`);
  process.exitCode = 1;
}
