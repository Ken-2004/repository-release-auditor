import assert from "node:assert/strict";
import test from "node:test";

import { ConfigurationError, parseConfig } from "../src/config/load-config.js";
import { ArgumentError, formatDiagnostic } from "../src/diagnostics.js";
import { GitCommandError } from "../src/git/git.js";

const marker = "SYNTHETIC_PRIVATE_DIAGNOSTIC";
const unsafe = `${marker}\n\u001b[31m${"x".repeat(1024)}`;
const fallback = "Repository scan failed because of an unexpected runtime or filesystem error.";

test("diagnostics never convert unknown thrown values or inspect their details", () => {
  let accessed = 0;
  const conversion = () => { accessed++; throw new Error(unsafe); };
  const object = {
    toString: conversion, toJSON: conversion,
    [Symbol.toPrimitive]: conversion,
    [Symbol.for("nodejs.util.inspect.custom")]: conversion,
    get message() { return conversion(); },
    get stack() { return conversion(); },
    get cause() { return conversion(); },
    get code() { return conversion(); }
  };
  const filesystemError = Object.assign(new Error(unsafe, { cause: object }), {
    code: "EACCES", path: unsafe, syscall: unsafe
  });
  for (const value of [unsafe, null, undefined, 17, 17n, Symbol(marker), object,
    Object.create(null), new Error(unsafe), filesystemError]) {
    assert.equal(formatDiagnostic(value), fallback);
  }
  assert.equal(accessed, 0);
});

test("diagnostics contain even throwing proxy traps without rendering the object", () => {
  const proxy = new Proxy({}, { getPrototypeOf() { throw new Error(unsafe); } });
  assert.equal(formatDiagnostic(proxy), fallback);
  const descriptorProxy = new Proxy(new GitCommandError(unsafe, [], unsafe, unsafe, 1), {
    getOwnPropertyDescriptor() { throw unsafe; }
  });
  assert.equal(formatDiagnostic(descriptorProxy), fallback);
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  assert.equal(formatDiagnostic(revoked.proxy), fallback);
});

test("known error types do not grant permission to print arbitrary messages or properties", () => {
  const git = new GitCommandError(unsafe, [unsafe], unsafe, unsafe, unsafe);
  const config = new ConfigurationError(unsafe);
  const argument = new ArgumentError("syntax");
  argument.message = unsafe;
  const expected = [
    "Repository scan could not start.\nGit inspection could not be completed safely.",
    "Configuration error: .repository-release-auditor.json: could not load a valid configuration.",
    "Invalid command-line arguments. Use --help for usage."
  ];
  for (const [index, error] of [git, config, argument].entries()) {
    assert.equal(formatDiagnostic(error), expected[index]);
    Object.defineProperty(error, "message", { get() { throw new Error(unsafe); } });
    assert.equal(formatDiagnostic(error), expected[index]);
  }
});

test("authored argument diagnostics remain useful and bounded", () => {
  for (const [reason, message] of [
    ["syntax", "Invalid command-line arguments. Use --help for usage."],
    ["format", "Expected --format text or --format json."],
    ["conflict", "Conflicting output formats; choose text or json."],
    ["paths", "Expected at most one repository path."]
  ] as const) {
    assert.equal(formatDiagnostic(new ArgumentError(reason)), message);
  }
});

test("authored configuration validation details retain bounded field indexes", () => {
  const entries = Array.from({ length: 100 }, (_, i) => ({ id: `policy-${i}`, text: "synthetic" }));
  const cases = [
    ["{", "invalid JSON."],
    [JSON.stringify({ [marker]: unsafe }), "unknown root field."],
    [JSON.stringify({ forbiddenPatterns: [...entries.slice(0, 99), null] }),
      "forbiddenPatterns[99] must be an object."],
    [JSON.stringify({ forbiddenPatterns: [{ id: unsafe, text: "synthetic" }] }),
      "forbiddenPatterns[0].id must be a safe identifier of 1–128 characters."],
    [JSON.stringify({ forbiddenPatterns: [{ id: "public", text: "" }] }),
      "forbiddenPatterns[0].text must contain 1–1024 UTF-16 code units and no NUL."]
  ];
  for (const [source, detail] of cases) {
    assert.throws(() => parseConfig(source!), (error: unknown) => {
      const result = formatDiagnostic(error);
      assert.equal(result, `Configuration error: .repository-release-auditor.json: ${detail}`);
      assert.ok(result.length < 256);
      return true;
    });
  }
  for (const index of [-1, 100, marker]) {
    assert.equal(formatDiagnostic(new ConfigurationError(`forbiddenPatterns[${index}] must be an object.`)),
      "Configuration error: .repository-release-auditor.json: could not load a valid configuration.");
  }
});

test("authored Git refusals never render raw stderr, arguments, causes or paths", () => {
  const message = "Tracked filter attributes are not supported during safe inspection.";
  const error = new GitCommandError(message, [unsafe], unsafe, unsafe, unsafe);
  error.cause = new Error(unsafe);
  assert.equal(formatDiagnostic(error), `Repository scan could not start.\n${message}`);
});
