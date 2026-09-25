import { spawnSync } from "node:child_process";
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const packageName = "repository-release-auditor";
const displayControls = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/u;

class CheckFailure extends Error {}

function requireCheck(condition, description) {
  if (!condition) throw new CheckFailure(`Installed package check failed: ${description}.`);
}

function within(root, target) {
  const difference = relative(root, target);
  return difference !== "" && !isAbsolute(difference) && difference !== ".." &&
    !difference.startsWith(`..${sep}`);
}

function run(executable, args, cwd, env, options = {}) {
  const result = spawnSync(executable, args, {
    cwd, env, encoding: "utf8", windowsHide: true,
    timeout: 90_000, maxBuffer: 2 * 1024 * 1024, ...options
  });
  requireCheck(!result.error && result.signal === null && result.status !== null,
    "bounded child execution");
  return result;
}

function diagnostic(result, expected) {
  requireCheck(result.status === 2 && result.stdout === "" &&
    result.stderr.replaceAll("\r\n", "\n") === expected,
  "fixed failure diagnostic, exit 2 and empty stdout");
}

/** Install only the previously inspected archive in an owned temporary consumer. */
export async function checkInstalledPackage({ archive, directory, env, npmCli }) {
  try {
    return await verifyInstallation({ archive, directory, env, npmCli });
  } catch (error) {
    // Never include npm/Git output, filesystem paths, or arbitrary error values.
    if (error instanceof CheckFailure) throw error;
    throw new CheckFailure("Installed package verification could not be completed.");
  }
}

async function verifyInstallation({ archive, directory, env, npmCli }) {
  const checks = [];
  await mkdir(directory, { recursive: true });
  requireCheck((await lstat(directory)).isDirectory() && (await readdir(directory)).length === 0,
    "fresh temporary consumer directory");
  const consumer = await realpath(directory);
  const consumerMetadata = { name: "synthetic-package-consumer", version: "0.0.0", private: true };
  const consumerManifest = JSON.stringify(consumerMetadata, null, 2) + "\n";
  await writeFile(join(consumer, "package.json"), consumerManifest);
  // Both the manifest and explicit prefix keep npm from selecting an ancestor
  // package when this owned temporary directory has no existing dependencies.
  const installArgs = [npmCli, "install", "--prefix", consumer, "--offline", "--ignore-scripts", "--no-audit",
    "--no-fund", "--no-save", "--package-lock=false", "--omit=dev", resolve(archive)];
  const installed = run(process.execPath, installArgs, consumer, env);
  requireCheck(installed.status === 0, "offline local archive installation");
  requireCheck(await readFile(join(consumer, "package.json"), "utf8") === consumerManifest,
    "consumer metadata remains unchanged");
  checks.push("offline archive installation with lifecycle scripts disabled");

  const modules = await realpath(join(consumer, "node_modules"));
  const packageRoot = await realpath(join(modules, packageName));
  requireCheck(within(consumer, modules) && within(modules, packageRoot),
    "installed package containment");
  const packageJson = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  requireCheck(packageJson.name === packageName && packageJson.version === "0.1.0" &&
    packageJson.private === true && packageJson.license === "MIT" &&
    packageJson.author === "Harsh Prajapati" && packageJson.engines?.node === ">=24 <25" &&
    packageJson.bin?.[packageName] === "dist/src/cli.js" &&
    Object.keys(packageJson.dependencies ?? {}).length === 0 &&
    ["preinstall", "install", "postinstall", "prepare"].every((key) => !packageJson.scripts?.[key]),
  "installed metadata and absence of consumer compilation hooks");
  for (const path of ["README.md", "LICENSE", "SECURITY.md", "docs/DEPENDENCIES.md"]) {
    requireCheck((await lstat(join(packageRoot, path))).isFile(), "installed documentation");
  }
  const rootEntries = await readdir(packageRoot);
  requireCheck(["src", "tests", "scripts", "node_modules", ".github"].every((name) =>
    !rootEntries.includes(name)), "no consumer source, tests or build dependencies");
  requireCheck(!(await readdir(join(packageRoot, "dist"))).includes("tests"),
    "no installed compiled tests");
  requireCheck((await readdir(modules)).every((name) =>
    [packageName, ".bin", ".package-lock.json"].includes(name)),
  "no installed development dependencies");
  checks.push("installed metadata, documentation and runtime-only footprint");

  const launcherRelative = `node_modules/.bin/${packageName}${process.platform === "win32" ? ".cmd" : ""}`;
  const runtimeRelative = `node_modules/${packageName}/dist/src/cli.js`;
  const launcher = join(consumer, launcherRelative);
  const runtime = await realpath(join(consumer, runtimeRelative));
  const resolvedLauncher = await realpath(launcher);
  requireCheck(within(modules, resolvedLauncher) && within(packageRoot, runtime),
    "local launcher and runtime containment");
  if (process.platform !== "win32") {
    requireCheck(resolvedLauncher === runtime, "Unix launcher resolves to installed runtime");
  } else {
    const shim = await readFile(launcher, "utf8");
    requireCheck(shim.includes(`\\..\\${packageName}\\dist\\src\\cli.js`),
      "Windows command launcher targets installed runtime");
  }
  checks.push("local launcher and runtime containment");

  const home = join(consumer, "synthetic-home");
  const xdg = join(consumer, "synthetic-xdg");
  const repository = join(consumer, "synthetic-repository");
  const nonGit = join(consumer, "synthetic-non-git");
  await Promise.all([home, xdg, repository, nonGit].map((path) => mkdir(path)));
  const emptyConfig = join(consumer, "synthetic-empty-git-config");
  await writeFile(emptyConfig, "");
  const childEnv = Object.fromEntries(Object.entries(env).filter(([key]) => !/^GIT_/i.test(key)));
  Object.assign(childEnv, {
    HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: xdg,
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: emptyConfig,
    GIT_TERMINAL_PROMPT: "0", LC_ALL: "C"
  });
  function git(args) {
    const result = run("git", ["-c", "user.name=Synthetic Package Test",
      "-c", "user.email=synthetic@example.invalid", "-c", "commit.gpgSign=false", ...args],
    repository, childEnv);
    requireCheck(result.status === 0, "synthetic Git fixture preparation");
  }
  function cli(args, cwd = repository) {
    if (process.platform !== "win32") return run(launcher, args, cwd, childEnv);
    // Only fixed tokens enter cmd syntax. The quoted environment expansion
    // accommodates spaces in the owned temporary path without interpolating it.
    requireCheck(args.every((arg) => /^[A-Za-z0-9-]+$/.test(arg)), "fixed Windows launcher arguments");
    const systemRoot = childEnv.SystemRoot ?? childEnv.SYSTEMROOT;
    requireCheck(typeof systemRoot === "string" && isAbsolute(systemRoot), "Windows command interpreter");
    return run(join(systemRoot, "System32", "cmd.exe"), ["/d", "/v:off", "/s", "/c",
      `""%RRA_INSTALLED_BIN%" ${args.join(" ")}"`], cwd,
    { ...childEnv, RRA_INSTALLED_BIN: launcher }, { windowsVerbatimArguments: true });
  }

  const help = cli(["--help"], nonGit);
  requireCheck(help.status === 0 && help.stderr === "" &&
    help.stdout.includes("repository-release-auditor [options] [path]") &&
    help.stdout.includes("--format <text|json>"), "installed help");
  checks.push("installed help");
  const version = cli(["--version"], nonGit);
  requireCheck(version.status === 0 && version.stderr === "" && version.stdout === "0.1.0\n",
    "installed version");
  checks.push("installed version");

  git(["init", "--quiet", "--template=", "-b", "main"]);
  git(["config", "core.autocrlf", "false"]);
  git(["config", "core.excludesFile", emptyConfig]);
  git(["config", "core.attributesFile", emptyConfig]);
  await writeFile(join(repository, "ordinary.txt"), "Synthetic ordinary tracked text.\n");
  git(["add", "--all"]);
  git(["commit", "--quiet", "-m", "Synthetic package fixture"]);
  const cleanText = cli(["--format", "text"]);
  requireCheck(cleanText.status === 0 && cleanText.stderr === "" &&
    cleanText.stdout.endsWith("\nNo findings.\n"), "installed clean text scan");
  checks.push("clean text exit 0");
  const cleanJson = cli(["--format", "json"]);
  requireCheck(cleanJson.status === 0 && cleanJson.stderr === "", "installed clean JSON scan");
  const cleanReport = JSON.parse(cleanJson.stdout);
  requireCheck(cleanReport.schemaVersion === 1 && cleanReport.tool?.version === "0.1.0" &&
    cleanReport.repository?.root === (await realpath(repository)).replaceAll("\\", "/") &&
    cleanReport.repository?.branch === "main" && /^[a-f0-9]{40,64}$/.test(cleanReport.repository?.head) &&
    cleanReport.summary?.findingCount === 0 && cleanReport.findings?.length === 0,
  "installed clean JSON parsed semantics");
  checks.push("clean schemaVersion 1 JSON exit 0");

  const unicode = "caf\u00e9-\u65e5\u672c\u8a9e-\ud83d\ude00-e\u0301-\ufffd";
  const filename = `${unicode}-\u0085\u009b\u2028\u2029\u202e\u2066.key`;
  const displayed = `${unicode}-\\u0085\\u009b\\u2028\\u2029\\u202e\\u2066.key`;
  const contentMarker = "SYNTHETIC_PACKAGE_CONTENT_78254";
  await writeFile(join(repository, filename), `${contentMarker}\n`);
  git(["add", "--all"]);
  git(["commit", "--quiet", "-m", "Synthetic package privacy fixture"]);
  const warningText = cli(["--format", "text"]);
  requireCheck(warningText.status === 1 && warningText.stderr === "" &&
    warningText.stdout.includes(`Path: ${displayed}\n`) &&
    warningText.stdout.match(/^\[WARNING\] risky-tracked-file$/gm)?.length === 1 &&
    !displayControls.test(warningText.stdout) && !warningText.stdout.includes(contentMarker),
  "installed warning text and privacy escaping");
  checks.push("warning text exit 1 and Unicode display escaping");
  const warningJson = cli(["--format", "json"]);
  requireCheck(warningJson.status === 1 && warningJson.stderr === "" &&
    warningJson.stdout.includes(displayed) && !displayControls.test(warningJson.stdout) &&
    !warningJson.stdout.includes(contentMarker), "installed warning JSON serialization");
  const warningReport = JSON.parse(warningJson.stdout);
  requireCheck(warningReport.schemaVersion === 1 && warningReport.summary?.findingCount === 1 &&
    warningReport.summary?.bySeverity?.warning === 1 && warningReport.findings?.length === 1 &&
    warningReport.findings[0]?.ruleId === "risky-tracked-file" && warningReport.findings[0]?.path === filename,
  "installed JSON original Unicode parsed value");
  checks.push("warning JSON exit 1 with escaped serialization and original parsed filename");

  for (const format of ["text", "json"]) {
    diagnostic(cli(["--format", format], nonGit),
      "Repository scan could not start.\nThe scan target is not inside a Git worktree.\n");
    checks.push(`non-Git ${format} exit 2, empty stdout and fixed diagnostic`);
    diagnostic(cli(["--format", format, "--SYNTHETIC-PRIVATE-ARGUMENT-79162"], nonGit),
      "Invalid command-line arguments. Use --help for usage.\n");
    checks.push(`invalid-argument ${format} exit 2, empty stdout and fixed diagnostic`);
  }

  git(["update-index", "--assume-unchanged", "ordinary.txt"]);
  await writeFile(join(repository, "ordinary.txt"), "Synthetic hidden worktree mismatch.\n");
  const indexBefore = await readFile(join(repository, ".git", "index"));
  const configBefore = await readFile(join(repository, ".git", "config"));
  for (const format of ["text", "json"]) {
    diagnostic(cli(["--format", format]), "Repository scan could not start.\n" +
      "Assume-unchanged, skip-worktree, and sparse index entries prevent complete inspection.\n");
    checks.push(`unsafe-inspection ${format} exit 2, empty stdout and fixed diagnostic`);
  }
  requireCheck(indexBefore.equals(await readFile(join(repository, ".git", "index"))) &&
    configBefore.equals(await readFile(join(repository, ".git", "config"))),
  "unsafe inspection preserves the synthetic index and configuration");
  checks.push("unsafe inspection leaves index and configuration bytes unchanged");

  return {
    installCommand: "node <npm-cli.js> install --prefix <temporary-consumer> --offline --ignore-scripts --no-audit --no-fund --no-save --package-lock=false --omit=dev <verified-archive.tgz>",
    launcher: launcherRelative,
    runtime: runtimeRelative,
    invocation: process.platform === "win32" ? "Windows cmd.exe /d /v:off /s /c local .cmd launcher" : "Unix local .bin launcher",
    checks
  };
}
