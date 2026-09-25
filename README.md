# Repository Release Auditor

Repository Release Auditor is a local command-line tool for evidence-based Git repository release-hygiene checks.

Version 0.1.0 is an initial release candidate. The source repository is public
and open source under MIT. The package is not yet published to npm;
`package.json` retains `"private": true` pending separate npm publication approval.

## Goal

Help developers identify accidental publication and release-hygiene risks before making a repository public or shipping a release.

The tool reports evidence and warnings. It does not claim that a repository is secure, legally compliant, or safe to publish.

## Implemented checks

- Git working-tree cleanliness
- risky tracked files and credential-bearing configuration files
- developer-machine absolute paths
- suspicious tracked build outputs and binaries
- unusually large tracked files
- configurable forbidden patterns

Configurable allowlists and ignores remain future ideas and are not implemented.

## Output

Supported output formats:

- human-readable terminal report (default, or `--format text`)
- structured JSON (`--format json`, or `--json`)

For example, after building:

```text
node dist/src/cli.js --format text .
node dist/src/cli.js --format json .
node dist/src/cli.js --json .
```

Format values are exactly `text` and `json`. Unknown values, missing values,
`--json` combined with `--format text`, or conflicting repeated formats fail
with exit `2`. `--json --format json` is valid.

Text reports escape untrusted repository roots and printed finding fields using
visible `\uXXXX` notation with lowercase hexadecimal digits (for example,
`\u001b`). The finite set is C0 controls U+0000–U+001F, DEL and C1 controls
U+007F–U+009F, U+061C, U+200E–U+200F, U+2028–U+202E, and U+2066–U+2069.
This covers control characters, line/paragraph separators, and bidi formatting
controls; report-owned newlines remain separate. Other Unicode, including emoji,
combining characters, and genuine U+FFFD, is preserved. Escaping does not change
the files inspected, findings, ordering, or exit code.

A completed JSON scan writes exactly one pretty-printed JSON document to stdout.
For example, an empty, clean repository could produce:

```json
{
  "schemaVersion": 1,
  "tool": {
    "name": "repository-release-auditor",
    "version": "0.1.0"
  },
  "repository": {
    "root": "/repository",
    "branch": "main",
    "head": null
  },
  "summary": {
    "findingCount": 0,
    "bySeverity": { "info": 0, "warning": 0, "error": 0 }
  },
  "findings": []
}
```

`schemaVersion` is numeric and currently `1`; consumers should check it because
the schema may evolve. `repository.root` is the absolute Git repository root,
`branch` is a string or `null` for detached HEAD, and `head` is a commit ID or
`null` for an unborn repository. Summary counts describe the entire findings
array. Findings retain rule-pipeline order and contain `ruleId`, `category`,
`severity` (`info`, `warning`, or `error`), `title`, and `message`. Optional
`path`, `evidence`, and `remediation` strings are omitted when undefined.

JSON contains report metadata and findings, without adding source excerpts,
configured forbidden text, timestamps, hostnames, or environment variables.
Matched values remain redacted in evidence; metadata such as paths and public
policy IDs remains visible. No ANSI formatting is added. Identical snapshots
and findings produce identical JSON.

JSON strings use standard JSON escaping for C0 controls, with legal `\uXXXX`
escapes for the remaining controls listed above. This is serialization escaping,
not text-display escaping applied to the values: `JSON.parse` recovers the
original metadata and finding strings. Pretty-printing newlines remain intact.
Consumers must escape parsed values for their own display context; parsing does
not make strings safe to render in a terminal, HTML, or a shell.

Exit codes are unchanged: completed clean scans exit `0`; findings meeting the
fixed warning threshold exit `1`. Argument, configuration, runtime, and tooling
failures exit `2`, write bounded, intentionally authored diagnostics to stderr,
and emit no partial report on stdout. Unknown failures receive fixed generic
messages; raw errors, stacks, Git stderr, argument contents, and configuration
values are not printed. Errors are text diagnostics even when JSON was requested.
`--help` and `--version` remain informational text commands rather than scan reports.

## Privacy and safety

Version 1 is designed to operate locally.

It will not:

- upload repository contents
- use telemetry
- call AI services
- automatically delete or rewrite files
- follow symlinks outside the repository

Matched-value redaction, display escaping, and anonymity are different. Content
rules redact matched values in evidence, and display escaping prevents the
listed controls from acting as terminal instructions or injected report lines.
Neither removes identifying metadata. Reports still disclose the repository
root, tracked filenames, branch/commit metadata, and public policy IDs as
applicable. These can contain personal, client, or project information, including
sensitive text embedded in names that the tool does not recognize or redact.
Review reports before sharing; they are not automatically safe to post publicly.
See [SECURITY.md](SECURITY.md) for assumptions, limitations, and how to report a
vulnerability privately.

### Git inspection boundary

Auditing requires Git **2.36 or newer** from a trusted installation. The CLI
resolves Git through absolute `PATH` entries outside the target repository; it
does not use the target's executables or relative `PATH` entries. The target
root, executable candidates, and retained child `PATH` directories are resolved
through the filesystem before containment checks; aliases into the target are
excluded. Unavailable optional `PATH` entries are skipped, while an unresolved
target root is refused. The caller's
runtime, `PATH`, home/configuration locations, and installed Git are trusted.
This is not a sandbox for arbitrary Git installations or a repository being
changed concurrently during inspection.

Inherited `GIT_*` variables and `SUDO_UID` are discarded so they cannot redirect
the scan through alternate repositories, worktrees, indexes, objects, or injected
configuration. Ordinary system/global configuration and Git's ownership and
`safe.directory` protections remain in effect. A configured worktree redirect
outside the repository discovered from the requested location is refused;
ordinary subdirectory invocation and linked worktrees remain supported.

Git stdout is captured as bytes and must be valid UTF-8 before any decoding or
filename preflight. Unsupported encodings refuse the entire inspection with
exit `2`; filenames are never silently skipped or replacement-decoded. This
also applies inside initialized submodules. Valid Unicode, including a literal
U+FFFD replacement character, is preserved without normalization. Raw Git stderr
is discarded rather than decoded or printed.

Each Git command disables hooks, fsmonitor, the untracked cache, pagers, prompts,
optional index writes, replacement refs, lazy fetching, and transport access.
Before status inspection, the CLI checks effective configuration and tracked
attributes, including included and worktree configuration. Any tracked `filter`
attribute is refused, including unset or boolean attributes; installed but
unused filter configuration alone is allowed. Repositories using active Git LFS
attributes therefore cannot currently be audited.

Sparse checkouts/indexes, assume-unchanged or skip-worktree entries,
`core.ignoreStat`, and partial-clone/promisor configuration are also refused.
The auditor does not alter repository configuration or index flags to enable a
scan. Initialized tracked submodules receive the same recursive safety checks
before their dirty state is inspected; their file contents are not scanned by
the audit rules.

Git commands have a 10-second time limit and a 10 MiB limit per output stream.
Git execution has a 60-second budget per inspection and at most 512 commands,
with submodule traversal bounded to depth 16 and 128 repositories including the
root. Unsafe, unsupported, failed, or
incomplete Git inspection exits `2`, emits a concise diagnostic without raw Git
output, and produces no partial report. These budgets do not provide process-tree
isolation for an untrusted Git installation.

The cleanliness result follows Git's status semantics, including stat caching
and content normalization. A clean status does not prove that worktree and index
bytes are identical. These checks assume the target and its configuration remain
stable during the scan.

## Architecture

The processing flow is:

```text
CLI
-> Git adapter
-> repository snapshot
-> repository configuration
-> rule engine
-> findings
-> reporters
-> exit policy
```

Git is the source of truth for repository state and tracked-file discovery.

## Local package use

Requires Node.js **24** (`>=24 <25`), npm, and Git **2.36 or newer** on `PATH`.
There are no runtime dependencies. The package and command name is
`repository-release-auditor`;
npm name availability must be rechecked immediately before npm publication.

From a checkout with development dependencies installed, inspect the package:

```text
npm run pack:check
```

`npm pack` and its dry run first clean this package's fixed `dist` directory,
resolved from the checkout build helper's location. The helper does not select
output from the caller's working directory, scan arguments, or environment. It
refuses a linked output root or nested symlink/junction, then compiles only
runtime JavaScript with LF line endings, a CLI shebang, and no source maps or
declarations. A failed clean or compile fails packaging. This assumes a stable
checkout filesystem; normal development build/test commands remain unchanged.

The whitelist includes only `dist/src/**/*.js`, `README.md`, `SECURITY.md`,
`LICENSE`, and `docs/DEPENDENCIES.md`, plus npm's required `package.json`. Source,
compiled tests, type declarations, source maps, CI files, build helpers, and
development artifacts are excluded. The MIT license and linked security
documentation are included in every package.

For actual archive and installed-command verification, run:

```text
npm run pack:verify
```

This requires Python 3 (`python` on Windows, `python3` on Unix) for standard-library
archive inspection, in addition to the checkout's supported Node/npm/Git and
installed development dependencies. Python is not required for ordinary
`npm pack` or installed CLI use. The command checks stale/deleted-source output,
cleaning boundaries, and compile failures in disposable copies; creates and
inspects a real tarball; then installs that same artifact offline in an isolated
temporary consumer with installation scripts disabled. It exercises the actual
Windows `.cmd` or Unix `.bin` launcher, including exit codes, JSON, privacy, and
safe-inspection refusal. It reports the archive manifest, SHA-256, sizes, and
check results, retaining the tarball and `verification.json` beneath the OS
temporary directory in `auditor-package-*/artifacts` for review.

`pack:check` remains a dry run; it does not replace these artifact checks.
The Windows and Ubuntu hosted packaging checkpoint passed in
[run 36106852087](https://github.com/Ken-2004/repository-release-auditor/actions/runs/36106852087)
for commit `7cfc72f965b2cc75cb01a94f7db33d2b83b6144b`, covering archive
construction and inspection, isolated installed launchers, and development tests
after packaging. Future release artifacts must be built and verified separately.
Neither artifact checks nor checkout tests establish that all sensitive
information has been found or that publication is safe.

For a local install, first create a package in an existing directory outside the
checkout, then install that tarball into a separate test directory:

```text
npm pack --pack-destination ../package-output
```

From the separate test directory (adjust the tarball path as needed):

```text
npm install --prefix . --offline --ignore-scripts --no-audit --no-fund --no-save --package-lock=false --omit=dev ../package-output/repository-release-auditor-0.1.0.tgz
npm exec --offline -- repository-release-auditor --help
npm exec --offline -- repository-release-auditor --version
npm exec --offline -- repository-release-auditor --format json ../repository-to-scan
```

The installed command is `repository-release-auditor [options] [path]`; omitted
paths default to the current directory. Installing the tarball requires no
TypeScript build or global installation. Keep packaging/install artifacts outside
the repository being audited so they do not trigger the cleanliness rule.
These instructions use a local tarball; no public npm release is available.

Publishing the source on GitHub does not publish the npm package. Before npm
publication, recheck npm name availability and obtain explicit approval to remove
`"private": true` and publish to npm. Creating tags or GitHub releases also requires
separate approval. Local packaging does not authorize those actions.

## Development

Requirements:

- Node.js 24
- npm
- Git 2.36 or newer

Install dependencies:

```text
npm install
```

Type-check:

```text
npm run check
```

Build:

```text
npm run build
```

Run tests:

```text
npm test
```

The GitHub Actions workflow in `.github/workflows/ci.yml` is configured for
Node.js 24 on `windows-latest` and `ubuntu-latest` for pushes and pull requests
to `main`. It sets up Python 3.12 for verification and checks the interpreter
used by the package inspector (`python` on Windows, `python3` on Ubuntu).
After `npm ci` and type-checking, it runs `npm run pack:verify` for actual archive
and isolated installed-bin checks, then the complete `npm test` to rebuild and
test development output after packaging. It retains `npm audit`, the final
build, the clean-tree assertion, and text/JSON self-audits. Jobs have a 20-minute
limit; the package-verification step has a 10-minute limit. Failures fail CI.
This workflow remains configured to repeat these checks. The completed hosted
checkpoint above does not validate artifacts built from later changes.

`.gitattributes` explicitly keeps `.mjs` and `.py` helper/test files at LF on
checkout, alongside the existing source/documentation rules. This policy is
separate from the release compiler's LF JavaScript output.

Run the current development CLI:

```text
node dist/src/cli.js .
```

## Exit codes

The exit-code contract is:

- `0` — scan completed and no finding met the configured failure threshold
- `1` — scan completed and one or more findings met the failure threshold
- `2` — runtime, configuration, or tooling failure

## Project status

Initial release candidate 0.1.0: all six intended rule families and text/JSON
reporting are implemented. Local packaging is supported under MIT. GitHub source
publication and npm package publication are separate steps, as described above.

The current implementation can:

- locate the Git repository root
- detect the current branch
- read the current HEAD when one exists
- enumerate tracked files
- detect a dirty working tree
- distinguish a non-Git directory as a runtime error

The `git-cleanliness` rule reports one warning when the repository has staged,
modified, deleted, renamed, or untracked files, including dirty submodules.
Intentionally ignored untracked files do not produce findings.

The `risky-tracked-file` rule reports one warning per matching tracked path,
including staged files. It only checks paths from Git's index; it does not read
file contents, scan Git history, or inspect files inside submodules. This is
repository-hygiene detection, not a comprehensive secret scanner or security
certification. A warning means the filename warrants review, not that a secret
has been confirmed.

Matching is case-insensitive and uses normalized Git paths (`/` separators) at
any directory depth:

- `.env` and `.env.*`, except names with a dot-separated `example`, `sample`,
  `template`, or `dist` segment after `.env` (for example `.env.example`,
  `.env.production.sample`, and `.env.template.local`).
- Exact filenames: `.npmrc`, `.pypirc`, `.netrc`, `_netrc`, `credentials.json`,
  `service-account.json`, `service-account-key.json`, `account-key.json`,
  `secrets.json`, `secrets.yml`, `secrets.yaml`, `id_rsa`, `id_ed25519`, `id_dsa`,
  `id_ecdsa`, and `private-key.pem`.
- Files ending in `.p12`, `.pfx`, or `.key`.
- `credentials` or `config` directly inside a `.aws` directory, including
  nested locations such as `deploy/.aws/credentials`.

Public `.crt`, `.cer`, `.pub`, and generic `.pem` files are not automatically
flagged. Generic `auth`, `config`, or `settings` names do not match. Ignored,
untracked files are excluded; tracked files still match even if an ignore rule
would otherwise exclude them. Findings retain path casing and are sorted by
path using a locale-independent order. This rule does not read or quote file
contents; reported paths are not redacted. Verify flagged files and, if needed,
remove sensitive material from version control and history and rotate exposed
credentials.

The `developer-machine-path` rule examines the current worktree contents of
tracked text files (including staged files, but not historical or staged blob
contents). It reports one warning per affected file, sorted by Git path:

- Windows drive-rooted paths using `/` or `\`, including escaped backslashes
  in JSON or source strings. Common `Windows`, `Program Files`,
  `Program Files (x86)`, `ProgramData`, and `Temp` roots are excluded.
- Unix/macOS home paths under `/home/<user>` or `/Users/<user>`.
- WSL home paths under `/mnt/<drive>/Users/<user>` or `/mnt/<drive>/home/<user>`.

Here, `<user>` denotes a concrete username. Literal placeholders such as
`<user>`, `${USER}`, `%USERNAME%`, `{username}`, `[username]`, and `__USER__`
are excluded. Relative paths, URLs (including `file://` URLs), and unrelated
absolute system paths such as `/usr/bin`, `/var/log`, and `/tmp` do not match.
Matching is case-insensitive and conservative; it is not a complete parser of
every language or path representation.

Content scanning is limited to **1 MiB (1,048,576 bytes) per file**. The reader
accepts common source, documentation, and configuration text extensions plus
explicit text filenames such as `README`, `Dockerfile`, `.gitignore`, and
`.env` variants; the full list is in `src/files/tracked-text.ts` in the repository
(packaged as `dist/src/files/tracked-text.js`). It validates
UTF-8 (including ASCII and UTF-8 BOMs) and rejects binary control bytes before
decoding. Unsupported extensions/encodings, binary-looking data, oversized
files, missing worktree files, directories, and symlinks (including paths below
linked directories) are skipped without a finding or runtime failure. Other
read failures remain runtime errors. Files inside submodules are not scanned.

Evidence contains only the first matching line number and path category, with
the matched value fully redacted. Matched path values and surrounding source
lines are not printed; tracked filenames remain visible. Replace flagged paths
with relative paths, environment variables, configuration, or documented
placeholders. Filename and byte checks are conservative heuristics; a clean
report does not establish that all files are portable or free of sensitive
information.

The `suspicious-build-output` rule checks tracked Git paths only and reports one
warning per matching path. It does not read file contents or determine whether a
file is actually binary, generated, or malicious. Generated and compiled files
may be intentionally versioned; this is a repository-hygiene check, not malware
detection or a claim that binaries are inherently unsafe.

Matching uses normalized POSIX Git paths and case-insensitive comparisons:

- Exact directory segments at any depth: `node_modules`, `coverage`, `.next`,
  `.nuxt`, `__pycache__`, `obj`, `dist`, and `build`.
- Files below `target/debug/` or `target/release/`, including nested Cargo
  projects. A bare `target` directory does not qualify by itself.
- Exact final filename extensions: `.o`, `.obj`, `.class`, `.pyc`, `.pyo`,
  `.exe`, `.dll`, `.so`, and `.dylib`.

Words in filenames such as `src/build.ts`, `docs/coverage.md`, or
`config/dist-config.json` do not match. Archives (including `.jar`), documents,
and media do not match solely by extension, but can match a generated directory
such as `dist/manual.pdf`. `.git` metadata paths are excluded. Untracked files
are excluded, including ignored output; tracked files still qualify even if an
ignore rule matches them. Findings retain path casing, are deduplicated, and
use locale-independent path ordering. Verify whether each artifact is
intentionally versioned; otherwise remove it from Git and add an appropriate
ignore rule. Custom output folders, Cargo profiles, and unlisted extensions
(including versioned suffixes such as `.so.1`) are not inferred.

The `large-tracked-file` rule warns about tracked regular files whose current
worktree size is **at least 50 MiB** (`50 * 1024 * 1024 = 52,428,800 bytes`).
Exactly 50 MiB qualifies; one byte below does not. This v1 threshold is fixed.
The rule uses filesystem metadata only, regardless of filename or extension;
it does not read file contents or launch a Git process for each file.

Git determines which paths are tracked, including staged additions. Size means
the current worktree file's logical byte length, not its disk allocation,
compressed size, staged/index blob size, or historical Git blob size. Repository
history is not scanned. Missing files, directories (including submodules), and
symlinks are skipped, as are paths beneath symlinked directories or junctions.
Repository-boundary checks prevent resolving tracked paths outside the root.
Untracked and ignored-untracked files are not considered. Unexpected metadata
errors remain runtime failures.

Findings preserve Git path casing and have deterministic order, with one warning
per qualifying path. Evidence contains only the measured size, such as
`52428800 bytes`, never file contents. Large files may be appropriate to version;
review whether they belong in Git. External artifact storage or Git LFS are
optional alternatives, not requirements.

The current CLI uses a fixed warning threshold: repositories with no findings
exit `0`, any warning (including a risky file in a clean worktree) results in
exit `1`, and runtime, configuration, argument, or tooling failures exit `2`.
Completed reports go to stdout; failures go to stderr.

## Repository policy: forbidden patterns

Place optional configuration in `.repository-release-auditor.json` at the Git
repository root. The CLI loads this fixed local file, even when invoked from a
subdirectory. A missing file, `{}`, or an empty `forbiddenPatterns` array leaves
forbidden-pattern scanning inactive; all other rules continue to run.

```json
{
  "forbiddenPatterns": [
    {
      "id": "internal-domain",
      "text": "internal.example.com",
      "caseSensitive": false
    },
    {
      "id": "temporary-marker",
      "text": "DO_NOT_RELEASE"
    }
  ]
}
```

The root must be an object with only the optional `forbiddenPatterns` array.
Each entry requires `id` and `text`, and may include `caseSensitive`:

- `id`: a unique, case-sensitive identifier matching
  `[A-Za-z0-9][A-Za-z0-9._-]*`, at most 128 characters. IDs are public report
  labels; do not put sensitive values in them.
- `text`: a nonempty literal string, at most 1,024 UTF-16 code units, without
  NUL. At most 100 patterns are allowed.
- `caseSensitive`: a boolean, defaulting to `true`. With `false`, both strings
  use JavaScript's locale-independent Unicode `toLowerCase()` before substring
  matching. This is not full Unicode case folding or Unicode normalization.

Unknown fields, invalid types, duplicates, invalid JSON, and exceeded limits
are configuration failures (exit `2`, diagnostics on stderr). Diagnostics name
fields or entry indexes without echoing configured text or unknown field names.
Configuration must be a regular UTF-8 JSON text file of at most 1 MiB; symlinks,
junctions, binary data, and paths resolving outside the repository are refused.
The file need not be tracked to supply policy. No parent-directory search,
environment interpolation, JavaScript execution, or network access occurs.

The `forbidden-pattern` rule uses literal substring matching only: no regex,
globs, replacements, or automatic fixes. It reads current worktree contents of
Git-tracked text files through the same 1 MiB bounded reader described above.
Binary, unsupported, oversized, missing, directory, and symlinked files are
skipped. It does not scan Git history, staged blob contents, submodules, or
ignored/untracked files. The root config file itself is excluded from this rule
to avoid self-matches; other rules still inspect it. Nested files with the same
name receive no exemption.

Each matching file/pattern-ID pair produces one warning, ordered by path then
ID using locale-independent ordering. Evidence reports the first matching line
(supporting LF, CRLF, and CR), the pattern ID, and `value redacted`; neither the
configured value nor surrounding source content is printed. Multiline strings
match literally, without line-ending normalization. Warnings exit `1`. Review
the location and remove or replace the prohibited text, or intentionally revise
the repository policy.

This feature expresses local repository-hygiene policy. It is not a secret
scanner, DLP product, malware detector, or security certification; a clean
result is not a security guarantee. Regex support, allowlists, ignore settings,
severity settings, and threshold configuration are not implemented.

## Documentation

- `docs/PHASE0.md` (repository only) — initial product and architecture decisions
- `docs/DEPENDENCIES.md` — direct dependency and license record

## License

MIT — see [LICENSE](LICENSE).

Copyright (c) 2026 Harsh Prajapati.
