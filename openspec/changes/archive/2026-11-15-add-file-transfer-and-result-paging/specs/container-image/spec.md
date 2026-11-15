# Spec Delta

## MODIFIED Requirements

### Requirement: Volumes and working directory
The image SHALL declare `/samples` and `/work` as volumes and use `/work` as
its working directory. The gateway SHALL NOT write to `/samples` and SHALL
operate correctly when `/samples` is mounted read-only. All persistent output
(Ghidra projects, REA output, per-session working directories, the inbox for
uploaded files at `/work/inbox`, stored results at `/work/results`, and the
optional checkpoint root) SHALL be written under `/work`, and the runtime user's
`HOME` SHALL be a writable directory under `/work`. The entrypoint SHALL create
`/work/inbox` and `/work/results` when they are missing, as it does the other
directories under `/work`.

#### Scenario: Read-only samples
- **WHEN** `/samples` is mounted read-only and an analysis is run on a file in it
- **THEN** the analysis completes and its output appears under `/work`

#### Scenario: Uploads with read-only samples
- **WHEN** `/samples` is mounted read-only and a file is uploaded through a ticket
- **THEN** the file is created under `/work/inbox` and nothing is written under `/samples`

#### Scenario: Unwritable work directory
- **WHEN** `/work` is not writable by uid 99
- **THEN** the gateway reports a clear error identifying `/work` rather than failing obscurely during analysis

#### Scenario: Unwritable directory under the work directory
- **WHEN** `/work` is writable but `/work/home`, `/work/sessions`, `/work/inbox` or `/work/results` exists and is not writable by uid 99
- **THEN** the container reports a clear error identifying that directory rather than failing obscurely during analysis

#### Scenario: Empty work directory
- **WHEN** an empty directory is mounted over `/work`
- **THEN** the entrypoint creates `/work/inbox` and `/work/results` along with the other directories it needs
