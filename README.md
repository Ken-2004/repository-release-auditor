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

Phase 2: Git cleanliness and risky tracked-file path auditing.

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
