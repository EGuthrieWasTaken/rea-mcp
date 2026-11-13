# Spec Delta

## Purpose

Guarantees that the repository and its history never contain secrets, analysis
samples, or third-party binaries, and defines how that guarantee is enforced.

## ADDED Requirements

### Requirement: No secrets in the repository
The repository's working tree and history SHALL NOT contain API keys, tokens,
credentials, or real deployment hostnames. Documentation, tests, and examples
SHALL use obvious placeholders (such as `<host>` and `<key>`) or values
generated at run time, and SHALL NOT include example keys that could be
mistaken for real ones.

#### Scenario: Placeholder-only documentation
- **WHEN** the documentation is searched for `x-api-key` usage examples
- **THEN** every example uses a placeholder rather than a literal key

#### Scenario: Tests generate their keys
- **WHEN** the test suite needs an API key
- **THEN** it generates a random key at run time instead of reading a committed literal

### Requirement: Empty environment example
The repository SHALL provide `.env.example` listing the supported variables,
in which `REA_MCP_API_KEY=` has an empty value.

#### Scenario: Example file carries no key
- **WHEN** `.env.example` is read
- **THEN** the `REA_MCP_API_KEY` line has nothing after the `=`

### Requirement: Ignore rules for secrets, samples, and third-party binaries
The repository's `.gitignore` SHALL exclude `.env`, `*.pcap`, `*.pcapng`,
`samples/`, `work/`, `*.gpr`, `*.rep`, `*.tns`, and TI installers and binaries.
Nothing under `samples/` or `work/` SHALL be committed.

#### Scenario: Sample file is ignored
- **WHEN** a file is created under `samples/` or `work/`
- **THEN** `git status` does not list it as untracked

#### Scenario: Environment file is ignored
- **WHEN** a `.env` file is created at the repository root
- **THEN** `git status` does not list it, while `.env.example` remains tracked

### Requirement: Automated secret scanning
The repository SHALL run gitleaks, configured by `.gitleaks.toml`, both as a
pre-commit hook (`.pre-commit-config.yaml`) and as a CI job that scans the full
git history. A finding SHALL fail the CI run. The gitleaks configuration SHALL
NOT allowlist paths or patterns broadly enough to hide a real key.

#### Scenario: Secret blocked in CI
- **WHEN** a commit introducing a credential-shaped string is pushed
- **THEN** the gitleaks CI job fails

#### Scenario: History is scanned
- **WHEN** the CI secret scan runs
- **THEN** it covers all commits reachable from the checked-out ref, not only the latest tree

### Requirement: No third-party software under analysis
The repository and the image build SHALL NOT bundle, download, or commit TI
software or any other third-party binaries intended as analysis targets.
Third-party tooling the product depends on (Ghidra, `rea-agents`, distribution
packages) SHALL be fetched at build time from pinned sources and SHALL NOT be
committed.

#### Scenario: No committed binaries
- **WHEN** the tracked files are listed
- **THEN** the only binary file is `unraid/icon.png`

#### Scenario: Build fetches only pinned tooling
- **WHEN** the Dockerfile's network fetches are enumerated
- **THEN** they consist only of distribution packages, the pinned `rea-agents` install, and the pinned, hash-verified Ghidra archive
