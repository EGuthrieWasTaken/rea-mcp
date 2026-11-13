# Spec Delta

## Purpose

Defines what the published Docker image contains and guarantees, so the gateway
and its analysis engines run reproducibly and with least privilege on unRAID.

## ADDED Requirements

### Requirement: Image platform and base
The image SHALL be built from `docker/Dockerfile` as a multi-stage build for
`linux/amd64` on a `node:24-bookworm-slim` runtime base. Build-only tools (such
as `curl` and `unzip`) SHALL NOT be present in the final stage.

#### Scenario: Build-only tools absent
- **WHEN** the final image is inspected
- **THEN** `curl` and `unzip` are not installed in it

### Requirement: Pinned, verified Ghidra
Ghidra SHALL be downloaded during the image build from the URL given by
`ARG GHIDRA_URL` for the release given by `ARG GHIDRA_VERSION`, verified
against `ARG GHIDRA_SHA256`, and extracted to `/opt/ghidra`. The build SHALL
fail if the SHA-256 does not match. Ghidra SHALL NOT be committed to the
repository.

#### Scenario: Hash matches
- **WHEN** the image is built with the pinned URL and hash
- **THEN** `/opt/ghidra` contains the Ghidra installation for the pinned version

#### Scenario: Hash mismatch
- **WHEN** the image is built with a `GHIDRA_SHA256` that does not match the downloaded archive
- **THEN** the build fails and no image is produced

### Requirement: Analysis toolchain present
The final image SHALL contain a full JDK of the major version required by the
pinned Ghidra release, a procps-compatible `ps`, `tshark` 4.x, and GNU binutils
(`objdump`), all resolvable on `PATH` for the runtime user. Rizin SHALL be
included when it is installable from the base distribution's package sources.

#### Scenario: Tools resolvable by the runtime user
- **WHEN** a shell is run in the container as the runtime user
- **THEN** `java`, `ps`, `tshark`, and `objdump` each run and report a version

#### Scenario: Headless Ghidra starts
- **WHEN** Ghidra's headless analyzer is invoked in the container as the runtime user
- **THEN** it starts under the installed JDK without a Java version error

### Requirement: Pinned REA installation
The image SHALL install an exact, lockfile-pinned version of `rea-agents` with
a reproducible install. The image build SHALL NOT run `rea-agents setup` or any
command that writes agent configuration.

#### Scenario: Exact version installed
- **WHEN** the installed `rea-agents` version is inspected in the image
- **THEN** it equals the version recorded in the committed lockfile

#### Scenario: No agent configuration written
- **WHEN** the image filesystem is inspected
- **THEN** no agent configuration files produced by `rea-agents setup` are present

### Requirement: Non-root runtime
The container SHALL run as uid `99` and gid `100`. The gateway and every
process it starts SHALL work without root, without added Linux capabilities,
and with `--cap-drop=ALL --security-opt=no-new-privileges:true`.

#### Scenario: Runtime identity
- **WHEN** the container is started with default settings
- **THEN** the gateway process runs as uid 99, gid 100

#### Scenario: Hardened run
- **WHEN** the container is started with `--cap-drop=ALL --security-opt=no-new-privileges:true`
- **THEN** it starts, `/healthz` returns `200`, and an authenticated MCP `initialize` succeeds

### Requirement: Volumes and working directory
The image SHALL declare `/samples` and `/work` as volumes and use `/work` as
its working directory. The gateway SHALL NOT write to `/samples` and SHALL
operate correctly when `/samples` is mounted read-only. All persistent output
(Ghidra projects, REA output) SHALL be written under `/work`.

#### Scenario: Read-only samples
- **WHEN** `/samples` is mounted read-only and an analysis is run on a file in it
- **THEN** the analysis completes and its output appears under `/work`

#### Scenario: Unwritable work directory
- **WHEN** `/work` is not writable by uid 99
- **THEN** the gateway reports a clear error identifying `/work` rather than failing obscurely during analysis

### Requirement: Health check and init process
The image SHALL define a `HEALTHCHECK` that probes `GET /healthz` on the
configured port, and SHALL run the gateway under an init process that forwards
signals and reaps zombie processes.

#### Scenario: Healthy container
- **WHEN** the container has started with a valid key
- **THEN** Docker reports its health status as `healthy`

#### Scenario: Stop signal
- **WHEN** `docker stop` is issued
- **THEN** the gateway receives `SIGTERM` and the container exits without being killed by the stop timeout

### Requirement: No embedded secrets or third-party analysis targets
The image SHALL NOT contain an API key, and its `ENV` and `ARG` defaults SHALL
NOT define one. The image SHALL NOT contain TI software or any other
third-party binaries intended as analysis targets.

#### Scenario: Container without a key
- **WHEN** the image is run with no key variable set
- **THEN** the container exits non-zero instead of serving requests

#### Scenario: Image history holds no key
- **WHEN** the image configuration and layer history are inspected
- **THEN** no `REA_MCP_API_KEY*` value is found
