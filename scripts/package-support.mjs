import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const packageRoot = realpathSync(fileURLToPath(new URL("../", import.meta.url)));
export const npmCli = [
  process.env.npm_execpath,
  join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"),
  join(dirname(process.execPath), "../lib/node_modules/npm/bin/npm-cli.js")
].find((path) => path && existsSync(path));

export function run(command, args, options = {}) {
  return spawnSync(command, args, {
    encoding: "utf8", windowsHide: true, timeout: 120_000,
    maxBuffer: 32 * 1024 * 1024, ...options
  });
}

export async function isolatedEnvironment(directory) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(npm_|git_|node_options$|node_auth_token$|npm_token$|init_cwd$)/i.test(key)
  ));
  const home = join(directory, "home");
  const xdg = join(directory, "xdg");
  const cache = join(directory, "npm-cache");
  const userConfig = join(directory, "user.npmrc");
  const globalConfig = join(directory, "global.npmrc");
  await Promise.all([home, xdg, cache].map((path) => mkdir(path, { recursive: true })));
  await Promise.all([userConfig, globalConfig].map((path) => writeFile(path, "")));
  return Object.assign(env, {
    HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: xdg,
    NPM_CONFIG_USERCONFIG: userConfig, NPM_CONFIG_GLOBALCONFIG: globalConfig,
    NPM_CONFIG_CACHE: cache, NPM_CONFIG_UPDATE_NOTIFIER: "false",
    NPM_CONFIG_OFFLINE: "true", NPM_CONFIG_AUDIT: "false", NPM_CONFIG_FUND: "false",
    GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C"
  });
}

export function inspectArchive(archive) {
  // Python's standard-library tarfile inspects structured entry metadata; no
  // archive parser or dependency is shipped with the application.
  const result = run(process.platform === "win32" ? "python" : "python3", [
    "-I", "-B", join(packageRoot, "scripts/inspect-package.py"), archive
  ]);
  if (result.error || result.status !== 0) {
    throw new Error("Archive inspection failed; Python 3 is required.");
  }
  return JSON.parse(result.stdout);
}
