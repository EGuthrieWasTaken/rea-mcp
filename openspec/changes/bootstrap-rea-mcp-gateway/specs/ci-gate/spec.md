# Spec Delta

## Purpose

Defines the continuous-integration gate that every change must pass before it
reaches `main`, and the branch protection that makes the gate binding.

## ADDED Requirements

### Requirement: Pull-request gate
Continuous integration SHALL run on every pull request and on every push to
`main`. Workflows SHALL be triggered by `pull_request`, never
`pull_request_target`, and SHALL declare read-only default token permissions,
granting more only to the specific job that needs it.

#### Scenario: Pull request from a fork
- **WHEN** a pull request is opened from a fork
- **THEN** the checks run without access to repository secrets or a write-scoped token

#### Scenario: Workflow using pull_request_target
- **WHEN** a change adds a workflow triggered by `pull_request_target`
- **THEN** the change violates this requirement

### Requirement: Pinned third-party actions and tools
Every third-party GitHub Action SHALL be referenced by full commit SHA, with
the version in a trailing comment. Every tool downloaded during a workflow
SHALL be pinned to an exact version and, when fetched as a binary, verified
against a SHA-256 recorded in the workflow before it is executed.

#### Scenario: Action referenced by tag
- **WHEN** a workflow references an action by a tag or branch name
- **THEN** the change violates this requirement and must pin the commit SHA instead

#### Scenario: Downloaded tool fails verification
- **WHEN** a downloaded tool's SHA-256 does not match the recorded value
- **THEN** the job fails before the tool runs

### Requirement: Branch protection and the gate job
`main` SHALL be protected so that changes land only through pull requests,
with strict required status checks, linear history, squash merging only, no
force-push, no deletion, and no bypass for administrators. Approving reviews
MAY be waived while the project has a single maintainer; the checks SHALL NOT
be. One always-running `gate` job SHALL depend on every required job and
assert that each finished `success` or `skipped`; `gate` SHALL be the required
status check.

#### Scenario: A required job fails
- **WHEN** any job that `gate` depends on fails or is cancelled
- **THEN** `gate` fails and the pull request cannot be merged

#### Scenario: A required job is skipped by a path filter
- **WHEN** a job that `gate` depends on is skipped
- **THEN** `gate` succeeds if every other job succeeded

#### Scenario: Direct push to main
- **WHEN** anyone, including an administrator, pushes a commit directly to `main`
- **THEN** the push is rejected

#### Scenario: New job not wired into the gate
- **WHEN** a required job is added to the workflow without being added to the `gate` job's dependencies
- **THEN** the change violates this requirement

### Requirement: Protection is reproducible from the repository
The repository SHALL carry the branch protection for `main` as an importable
ruleset definition at `.github/rulesets/main.json`, so the protection can be
reviewed, re-applied, and kept in step with the workflow's job names.

#### Scenario: Required check name matches the workflow
- **WHEN** the ruleset's required status check contexts are compared with the workflow's job names
- **THEN** every required context names a job that exists
