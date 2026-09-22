import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { ConfigurationError, loadConfig, parseConfig } from "../src/config/load-config.js";
import { CONFIG_FILENAME } from "../src/config/types.js";
import { MAX_TEXT_FILE_BYTES } from "../src/files/tracked-text.js";

const privateValue = ["POLICY", "PRIVATE", "FIXTURE"].join("_");

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "auditor-config-"));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 3 }));
  const root = join(directory, "repository");
  await mkdir(root);
  return { directory, root, path: join(root, CONFIG_FILENAME) };
}

test("configuration defaults and explicit case sensitivity", () => {
  assert.deepEqual(parseConfig("{}"), { forbiddenPatterns: [] });
  assert.deepEqual(parseConfig('{"forbiddenPatterns":[]}'), { forbiddenPatterns: [] });
  assert.deepEqual(parseConfig(JSON.stringify({ forbiddenPatterns: [
    { id: "default", text: privateValue },
    { id: "explicit", text: privateValue, caseSensitive: false }
  ] })), { forbiddenPatterns: [
    { id: "default", text: privateValue, caseSensitive: true },
    { id: "explicit", text: privateValue, caseSensitive: false }
  ] });
});

test("validation rejects invalid entries without echoing values or unknown keys", () => {
  const entry = { id: "valid", text: privateValue };
  const invalid = [
    null, [], true, privateValue,
    { [privateValue]: true }, { forbiddenPatterns: {} },
    ...[null, [], privateValue, {},
      { ...entry, [privateValue]: true },
      { ...entry, id: "" }, { ...entry, id: "-leading" },
      { ...entry, id: "trailing\n" }, { ...entry, id: "has space" },
      { ...entry, id: "x".repeat(129) }, { ...entry, id: 1 },
      { id: "valid" }, { ...entry, text: "" }, { ...entry, text: null },
      { ...entry, text: `${privateValue}\0` }, { ...entry, text: "x".repeat(1025) },
      { ...entry, caseSensitive: "false" }, { ...entry, caseSensitive: null }
    ].map((value) => ({ forbiddenPatterns: [value] })),
    { forbiddenPatterns: [entry, entry] },
    { forbiddenPatterns: Array.from({ length: 101 }, (_, i) => ({ ...entry, id: `id-${i}` })) }
  ];
  for (const value of invalid) {
    assert.throws(() => parseConfig(JSON.stringify(value)), (error: unknown) => {
      assert.ok(error instanceof ConfigurationError);
      assert.equal(error.message.includes(privateValue), false);
      return true;
    });
  }
  assert.throws(() => parseConfig(`{"text":"${privateValue}"`), (error: unknown) => {
    assert.ok(error instanceof ConfigurationError);
    assert.equal(error.message.includes(privateValue), false);
    return true;
  });
});

test("validation accepts exact count, text, and identifier limits", () => {
  const forbiddenPatterns = Array.from({ length: 100 }, (_, i) => ({
    id: `${i}`.padEnd(128, "x"), text: "x".repeat(1024)
  }));
  assert.equal(parseConfig(JSON.stringify({ forbiddenPatterns })).forbiddenPatterns.length, 100);
  assert.equal(parseConfig(JSON.stringify({ forbiddenPatterns: [
    { id: "A-z_1.2", text: " \r\n\t" }
  ] })).forbiddenPatterns[0]?.text, " \r\n\t");
});

test("loader uses only the fixed root path and accepts a missing configuration", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.directory, CONFIG_FILENAME), "not JSON");
  assert.deepEqual(loadConfig(f.root), { forbiddenPatterns: [] });
  await writeFile(f.path, JSON.stringify({ forbiddenPatterns: [{ id: "one", text: privateValue }] }));
  assert.equal(loadConfig(f.root).forbiddenPatterns[0]?.text, privateValue);
});

test("loader refuses binary, oversized, and directory configurations", async (t) => {
  const f = await fixture(t);
  for (const data of [Buffer.from([0xff]), Buffer.from([0]), " ".repeat(MAX_TEXT_FILE_BYTES + 1)]) {
    await writeFile(f.path, data);
    assert.throws(() => loadConfig(f.root), ConfigurationError);
  }
  await rm(f.path);
  await mkdir(f.path);
  assert.throws(() => loadConfig(f.root), ConfigurationError);
});

test("loader refuses an outside junction or directory symlink", async (t) => {
  const f = await fixture(t);
  const outside = join(f.directory, "outside");
  await mkdir(outside);
  await symlink(outside, f.path, process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => loadConfig(f.root), ConfigurationError);
});

test("loader refuses outside and dangling file symlinks", async (t) => {
  const f = await fixture(t);
  const outside = join(f.directory, "outside.json");
  await writeFile(outside, "{}");
  try {
    await symlink(outside, f.path, "file");
  } catch (error: unknown) {
    if (process.platform === "win32" && error instanceof Error && "code" in error && error.code === "EPERM") {
      t.skip("Creating file symlinks requires Windows Developer Mode or elevation.");
      return;
    }
    throw error;
  }
  assert.throws(() => loadConfig(f.root), ConfigurationError);
  await rm(outside);
  assert.throws(() => loadConfig(f.root), ConfigurationError);
});
