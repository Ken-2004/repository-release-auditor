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

The planned v1 contract is:

- `0` — scan completed and no finding met the configured failure threshold
- `1` — scan completed and one or more findings met the failure threshold
- `2` — runtime, configuration, or tooling failure

## Project status

Phase 0: architecture and project foundation.

The current implementation can:

- locate the Git repository root
- detect the current branch
- read the current HEAD when one exists
- enumerate tracked files
- detect a dirty working tree
- distinguish a non-Git directory as a runtime error

Audit rules are not implemented yet.

## Documentation

- `docs/PHASE0.md` — initial product and architecture decisions
- `docs/DEPENDENCIES.md` — direct dependency and license record

## License

No project license has been selected yet.

A license decision will be made deliberately before public release.
