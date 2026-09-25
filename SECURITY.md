# Security and privacy

Repository Release Auditor 0.1.0 is an initial release candidate under active
development. The source is public under MIT; the npm package is not published
and remains marked `private`. This document does not establish support for
historical releases or certify a repository as secure or safe to publish.

## Reporting a concern

A private vulnerability-reporting route has not been verified for this project.
Do not post exploit details, credentials, private repository contents, or
sensitive reports in public issues. You may [open an issue requesting a private
security contact](https://github.com/Ken-2004/repository-release-auditor/issues)
without including technical details or sensitive data. Wait for a verified
private channel before sharing them. No response time or bounty is promised.
Verifying a private reporting route remains a maintainer action; this document
does not configure one.

## Supported environment and trust boundary

The supported runtime is Node.js 24 (`>=24 <25`) with Git 2.36 or newer. The
caller must trust Node, the installed Git executable, executable search paths,
home/configuration locations, and ordinary system/global Git configuration.
The repository, its configuration, and the surrounding filesystem must remain
stable during inspection. This is not a sandbox for an arbitrary Git
installation or a repository being changed concurrently.

Git inspection discards inherited Git environment overrides, excludes executable
paths resolving inside the target, disables hooks and fsmonitor, and retains
Git ownership/`safe.directory` protections. It refuses tracked filter attributes
(including active Git LFS), sparse checkouts/indexes, assume-unchanged or
skip-worktree entries, `core.ignoreStat`, partial-clone/promisor configuration,
unsupported worktree boundaries, and invalid UTF-8 Git output. Unsupported
filenames are not silently skipped or replacement-decoded. The auditor does not
change repository configuration or index flags to make a scan possible.

Git subprocesses and submodule traversal have finite time, output, command-count,
depth, and repository-count limits. Unsafe or incomplete inspection exits `2`
without a report. See the [README Git inspection boundary](README.md#git-inspection-boundary)
for the exact limits and supported worktree/submodule behavior. These limits
do not provide process-tree isolation. A clean Git status does not prove
worktree/index byte equality because Git uses stat caching and normalization.

## Report privacy

Content findings redact matched values in evidence rather than quoting source
lines. Text reports visibly escape C0 controls U+0000–U+001F, DEL/C1 controls
U+007F–U+009F, U+061C, U+200E–U+200F, U+2028–U+202E, and U+2066–U+2069 with
lowercase hexadecimal `\uXXXX` notation. Other Unicode remains unchanged.
Reporter-owned formatting is separate from these untrusted fields.

Schema version 1 JSON retains original metadata and finding values: standard
JSON escapes handle C0 controls, and additional legal Unicode escapes handle the
remaining listed controls in the serialized document. `JSON.parse` restores the
original strings, including controls. Downstream consumers must escape these
values for their own terminal, HTML, or other output context.

Neither redaction nor escaping makes a report anonymous. Repository roots,
filenames, branch/commit metadata, and public policy IDs remain visible where
applicable. Names may contain personal, client, project, or sensitive data that
is not detected or redacted. Review reports before sharing them publicly.

Failed scans emit bounded diagnostics on stderr and no report stdout. Known
failures use intentionally authored messages; unknown failures use fixed generic
messages. Raw errors, stacks, causes, Git stderr, arbitrary argument/configuration
values, and source contents are not diagnostic output. There is no automatic
debug dump. The tool does not upload repository contents or use telemetry.

## Scope and omissions

The rules inspect tracked paths and current worktree data, not Git history or
staged/index blob contents. Content rules accept only supported UTF-8 text files
up to 1 MiB. Unsupported extensions/encodings, binary-looking data, oversized
files, missing files, directories, and symlinks are skipped by content scanning.
Ignored/untracked files and submodule contents are not scanned by the content
rules; initialized submodules still receive Git safety/dirty-state inspection.
The optional root policy file can supply configuration even when untracked.

Path and content matching are conservative heuristics with false positives and
false negatives. This is repository-hygiene detection, not a comprehensive
secret scanner, malware scanner, DLP system, security certification, or guarantee
that publication is safe. It does not scan full history, automatically remove
data, rotate credentials, or prove worktree/index byte equality. Checkout tests
and CI do not establish the contents or behavior of a separately built npm
artifact; installed-package validation is a separate release check.
