# Repository Release Auditor

Repository Release Auditor is a local command-line tool for evidence-based Git repository release-hygiene checks.

The project is currently in early development.

## Goal

Help developers identify accidental publication and release-hygiene risks before making a repository public or shipping a release.

The tool reports evidence and warnings. It does not claim that a repository is secure, legally compliant, or safe to publish.

## Planned v1 checks

- Git working-tree cleanliness
- risky tracked files and credential-bearing configuration files
- developer-machine absolute paths
- suspicious tracked build outputs and binaries
- unusually large tracked files
- configurable forbidden patterns
- configurable allowlists and ignores

## Output

Planned v1 output formats:

- human-readable terminal report
- structured JSON

CI-friendly exit codes will distinguish findings from runtime or configuration errors.

## Privacy and safety

Version 1 is designed to operate locally.

It will not:

- upload repository contents
- use telemetry
- call AI services
- automatically delete or rewrite files
- follow symlinks outside the repository
- print complete secret-like values

## Architecture

The initial processing flow is:

```text
CLI
-> Git adapter
-> repository snapshot
-> rule engine
-> findings
-> reporters
-> exit policy
```

Git is the source of truth for repository state and tracked-file discovery.

## Development

Requirements:

- Node.js 24
- npm
- Git

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

Phase 3: Git cleanliness, risky tracked files, and developer-machine paths.

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
path using a locale-independent order. No file contents or secret values are
printed. Verify flagged files and, if needed, remove sensitive material from
version control and history and rotate exposed credentials.

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
`.env` variants; the full list is in `src/files/tracked-text.ts`. It validates
UTF-8 (including ASCII and UTF-8 BOMs) and rejects binary control bytes before
decoding. Unsupported extensions/encodings, binary-looking data, oversized
files, missing worktree files, directories, and symlinks (including paths below
linked directories) are skipped without a finding or runtime failure. Other
read failures remain runtime errors. Files inside submodules are not scanned.

Evidence contains only the first matching line number and path category, with
the value fully redacted. No embedded usernames, drive letters, directory names,
or surrounding lines are printed. Replace flagged paths with relative paths,
environment variables, configuration, or documented placeholders. Filename and
byte checks are conservative heuristics; a clean report does not establish that
all files are portable or free of sensitive information.

The current CLI uses a fixed warning threshold: repositories with no findings
exit `0`, any warning (including a risky file in a clean worktree) results in
exit `1`, and runtime, argument, or tooling failures exit `2`.
Completed reports go to stdout; failures go to stderr.

## Documentation

- `docs/PHASE0.md` — initial product and architecture decisions
- `docs/DEPENDENCIES.md` — direct dependency and license record

## License

No project license has been selected yet.

A license decision will be made deliberately before public release.
