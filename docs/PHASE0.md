# Phase 0 Decisions

## Product boundary

Repository Release Auditor is a local, deterministic repository-hygiene scanner.

It reports evidence-based findings without claiming comprehensive security, legal, or compliance certification.

## Architecture

The v1 processing flow is:

CLI
-> Git adapter
-> repository snapshot
-> rule engine
-> findings
-> reporters
-> exit policy

Git is authoritative for repository state and tracked-file discovery.

Git commands must be executed using argument-array subprocess calls rather than interpolated shell commands.

## Initial rule families

1. Git cleanliness
2. Risky tracked files and credential-bearing configuration
3. Developer-machine absolute paths
4. Suspicious build outputs and binary artifacts
5. Large tracked files
6. User-configured forbidden patterns

## Exit codes

- 0: scan completed and no finding met the configured failure threshold
- 1: scan completed and one or more findings met the threshold
- 2: runtime, configuration, or tooling failure

## Security and privacy

- no network calls or telemetry in v1
- secret-like evidence must be redacted before reporting
- symlinks must not be followed outside the repository
- arbitrary binary files must not be decoded as text
- repository modifications and destructive fixes are outside v1

## Implementation baseline

- Node.js 24
- TypeScript
- npm
- Node built-in APIs where practical
- Node built-in test runner
- minimal runtime dependency surface

## Naming

`Repository Release Auditor` is the current project and development name.

The final npm package and CLI brand will be checked again before public publication.

## Licensing

No license has been selected for the project yet.

Public release requires a deliberate license decision.
