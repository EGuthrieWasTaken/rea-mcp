# CLAUDE.md

Guidance for Claude Code and other agents working in this repository. The rules
below are copied verbatim from `openspec/config.yaml`, which is the source of
truth. If the two ever differ, `openspec/config.yaml` wins; fix this file.

## Project

rea-mcp is a thin HTTP gateway that exposes REA (npm `rea-agents`, a local
stdio MCP server) plus Ghidra/tshark/objdump as a remote MCP server, shipped
as one Docker image with a native unRAID template. Licensed GPL-3.0-only.

## Hard requirements (non-negotiable)

1. No secrets in the repo, ever. API keys are runtime-only (env var or *_FILE
   path). No default key, no realistic-looking example key, no real hostnames
   or tokens in docs or tests. Use obvious placeholders such as <host>, <key>.
2. The server refuses to start if no key is configured or any key is shorter
   than 32 characters.
3. The container runs as non-root uid 99 / gid 100 (unRAID nobody:users).
   /samples is mounted read-only.
4. Never log request headers, the API key, or any value derived from it
   (including hashes, prefixes, or lengths).
5. Do not bundle, download, or commit TI software or any third-party binaries
   under analysis. Ghidra is downloaded at image build time (pinned version,
   SHA-256 verified), never committed.

## Process rules

- Never commit anything under samples/ or work/.
- Ask the maintainer before pushing or creating/publishing the GHCR package.
- Claims that have not been verified against a primary source (REA launch
  command, Ghidra JDK requirement, distro package availability, unRAID
  template rules) must be marked "UNVERIFIED", not asserted.

## Where the plan lives

This repository is spec-driven with [OpenSpec](https://github.com/Fission-AI/OpenSpec).
The active change is `openspec/changes/bootstrap-rea-mcp-gateway/`
(`proposal.md`, `design.md`, `tasks.md`, and one `specs/<capability>/spec.md`
per capability). Work through `tasks.md` in order, land one task per commit, and
tick its checkbox in the same commit.

Check specs and changes with:

```bash
npx @fission-ai/openspec validate --all --strict
```
