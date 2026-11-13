# Proposal

## Why

REA ("Reverse Engineer Anything", npm `rea-agents`) is a local stdio MCP server
whose documentation describes no network mode, so it can only be used by an
agent running on the same machine as the analysis tooling. We want to run REA
and its engines (Ghidra, tshark, objdump/Rizin) on an unRAID server and use them
from Claude (claude.ai custom connector) and Claude Code over HTTPS, which
requires a remote MCP endpoint with authentication.

## What Changes

- Add a thin gateway (Node 24 + TypeScript) that serves MCP streamable HTTP on
  `/mcp` and bridges each MCP session to its own REA child process over stdio.
- Authenticate every `/mcp` request with a static API key in the `x-api-key`
  header; refuse to start without a key of at least 32 characters.
- Bound resource use: capped concurrent sessions, idle reaping, child cleanup
  on session end and on shutdown.
- Keep long-running tool calls alive through a reverse proxy that cuts idle
  origin responses at roughly 100 s (SSE keep-alives, progress forwarding).
- Ship a multi-stage `linux/amd64` Docker image that runs as uid 99 / gid 100
  with a pinned, hash-verified Ghidra and a pinned `rea-agents`.
- Ship a native unRAID Docker template (`unraid/rea-mcp.xml`) and icon.
- Establish repository guard rails so that secrets and analysis samples cannot
  be committed (ignore rules, gitleaks in CI and pre-commit).
- Add CI (lint, typecheck, test, gitleaks, template XML check, image build and
  smoke test) and user documentation (README, DESIGN, CLOUDFLARE, SECURITY).

**Prerequisite gate:** the first implementation task is to verify how REA is
launched as a standalone stdio MCP server. This is currently unverified. If REA
cannot run that way, work stops and the finding is reported; no workaround is
built.

**Out of scope**

- TLS termination and the Cloudflare Tunnel itself (terminated outside this
  project; only documented).
- OAuth or any authentication scheme other than the static `x-api-key` header.
- Bundling, downloading, or committing any software under analysis, including
  TI software.
- Running `rea-agents setup` in the image (it edits agent configuration).
- Multi-architecture images (amd64 only).
- A web UI.

**Deviation from the original brief:** the brief's repo layout lists
`LICENSE (MIT)`. The maintainer has since chosen **GPL-3.0** for this
repository, and the committed `LICENSE` is GPLv3. REA (MIT) and Ghidra
(Apache-2.0) are installed into the image as separate works and are not
relicensed.

## Capabilities

### New Capabilities

- `api-key-auth`: How API keys are supplied, validated at startup, checked per
  request, rate-limited on failure, and kept out of logs.
- `mcp-http-gateway`: The HTTP surface: `/mcp` streamable HTTP bridging to
  REA, `/healthz`, Host allowlisting, keep-alives and progress forwarding for
  long-running calls, configuration, and structured logging.
- `session-management`: Lifecycle of per-session REA child processes: creation,
  concurrency cap, idle reaping, termination, and graceful shutdown.
- `container-image`: What the Docker image contains and guarantees: pinned and
  verified third-party components, non-root runtime, volumes, healthcheck,
  signal handling.
- `unraid-template`: The unRAID Docker template and its fields, defaults, and
  validity checks.
- `secret-hygiene`: Repository-level guarantees that no secrets, samples, or
  third-party binaries are committed, and how that is enforced.

### Modified Capabilities

None. This is the first change in the repository.

## Impact

- **New code:** `src/` (gateway), `test/` (unit + integration with a fake stdio
  MCP server fixture), `docker/Dockerfile`, `unraid/rea-mcp.xml`,
  `unraid/icon.png`, `.github/workflows/ci.yml` (and optional `release.yml`).
- **New docs:** `CLAUDE.md`, `README.md` (expanded), `docs/DESIGN.md`,
  `docs/CLOUDFLARE.md`, `docs/SECURITY.md`, `.env.example`.
- **New tooling config:** `.gitleaks.toml`, `.pre-commit-config.yaml`.
- **Dependencies:** `@modelcontextprotocol/sdk`, exact-pinned `rea-agents`,
  Node 24, a JDK matching the pinned Ghidra, Ghidra (build-time download),
  tshark, binutils, procps, optionally Rizin.
- **External systems:** GHCR package `ghcr.io/eguthriewastaken/rea-mcp`
  (publishing requires maintainer approval), a Cloudflare Tunnel operated by
  the user, Claude custom connector / Claude Code as clients.
