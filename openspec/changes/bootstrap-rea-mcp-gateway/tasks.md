# Tasks

Commit after each task. Never commit anything under `samples/` or `work/`.
Ask the maintainer before pushing or publishing to GHCR.

## 1. Guard rails

- [x] 1.1 Create `CLAUDE.md` containing the five hard requirements and the process rules verbatim from `openspec/config.yaml`; verify by reading it back against the brief
- [x] 1.2 Add `.env.example` listing every supported variable with `REA_MCP_API_KEY=` empty; verify no line carries a value that resembles a key
- [x] 1.3 Confirm `.gitignore` covers `.env`, `*.pcap`, `*.pcapng`, `samples/`, `work/`, `*.gpr`, `*.rep`, `*.tns`, and TI installers; verify with `git check-ignore` on one path per pattern
- [x] 1.4 Add `.gitleaks.toml` (default rules, no broad allowlists) and `.pre-commit-config.yaml` with the gitleaks hook; verify gitleaks rejects a staged throwaway credential-shaped string and passes on the clean tree

## 2. REA launch discovery (gate)

- [ ] 2.1 In a throwaway directory outside the repo, inspect `rea-agents` (README, `--help`, `package.json` `bin`, entry files, and what `setup` would write, using a dry run or a scratch `HOME`) to determine the exact command that starts REA as a standalone stdio MCP server; verify by completing an MCP `initialize` and `tools/list` against it over stdio
- [ ] 2.2 Record how REA finds Ghidra, reads `REA_GHIDRA_STARTUP_TIMEOUT_MS`, which Node versions it supports, and where it writes output; mark anything not confirmed from source or by running it as UNVERIFIED
- [ ] 2.3 Write the findings and the exact launch command into `docs/DESIGN.md`; **if REA cannot run as a standalone stdio MCP server, stop here and report to the maintainer**
- [ ] 2.4 Evaluate `mcp-proxy` and `supergateway` against the three criteria (header-auth middleware, one child per session, keep-alives) and record the gateway implementation choice in `docs/DESIGN.md`

## 3. Gateway

- [ ] 3.1 Scaffold the Node 24 + TypeScript project (`package.json` with `"license": "GPL-3.0-only"`, lockfile, `tsconfig`, ESLint, test runner, exact-pinned `rea-agents` and `@modelcontextprotocol/sdk`); verify `npm run lint`, `typecheck`, and `test` all run
- [ ] 3.2 Implement config loading for all environment variables with defaults and startup validation; unit-test defaults and that an unparsable value exits non-zero naming the variable
- [ ] 3.3 Implement key loading from `REA_MCP_API_KEY`, `REA_MCP_API_KEY_FILE`, and `REA_MCP_API_KEYS`, with startup refusal; unit-test no key, 31-character key, one weak key among several, unreadable file, `*_FILE` with trailing newline, and source union
- [ ] 3.4 Implement digest-based constant-time key verification that evaluates every accepted key; unit-test missing, wrong, right, multi-key, length mismatch, and that all comparisons run
- [ ] 3.5 Implement the JSON logger with an explicit field allowlist and `LOG_LEVEL` filtering; unit-test that no headers or key material are emitted at `debug` and that level filtering works
- [ ] 3.6 Implement the HTTP server with `/healthz`, 404 for unknown paths, 405 for unsupported methods, and confirm the SDK transport allows SSE comment frames and forced-SSE responses (spike); test that `/healthz` returns exactly `{"status":"ok"}` with no identifying headers
- [ ] 3.7 Implement the `ALLOWED_HOSTS` check for `/mcp` with `/healthz` exempt; unit-test allowed, disallowed, port-suffixed, case-differing, and unset cases
- [ ] 3.8 Implement failed-auth rate limiting with `TRUST_PROXY`-aware source IP resolution and a bounded store; unit-test limit reached, window expiry, per-IP isolation, successes not counted, and forwarding headers ignored versus honored
- [ ] 3.9 Wire authentication ahead of session lookup on `/mcp`; test that a wrong key with a live session ID returns the same `401` as with an unknown ID and does not reset the idle timer
- [ ] 3.10 Build the fake stdio MCP server fixture under `test/` (echo tool, slow tool with scalable delay and progress notifications, crash-on-demand tool, a mode that spawns a grandchild)
- [ ] 3.11 Implement the session manager and stdio↔streamable-HTTP relay with one child per session, key variables stripped from the child environment, and stderr captured to logs; integration-test initialize, list tools, call tool, two isolated concurrent sessions, and child spawn failure
- [ ] 3.12 Implement the `MAX_SESSIONS` cap with slot reservation; integration-test `503` + `Retry-After` at the cap, no extra process spawned, and recovery after a session ends
- [ ] 3.13 Implement `DELETE` termination, idle reaping that ignores in-flight sessions, and child-exit handling; integration-test cleanup on delete, cleanup on idle (scaled time), a long call outliving the idle timeout, and a mid-call crash
- [ ] 3.14 Implement process-group termination with SIGTERM→SIGKILL escalation and graceful gateway shutdown; integration-test that a child ignoring SIGTERM is killed, no grandchild survives, and SIGTERM with live sessions exits `0` within the budget
- [ ] 3.15 Implement SSE keep-alive comments and progress/cancellation forwarding; integration-test a time-scaled 120 s slow tool through an idle-timeout proxy stub, asserting keep-alives, forwarded progress, and the final result
- [ ] 3.16 Pass `REA_GHIDRA_STARTUP_TIMEOUT_MS` through to children; test presence in the child environment via the fixture

## 4. Container image

- [ ] 4.1 Choose and pin the Ghidra release; record version, URL, SHA-256, and the JDK major version from that release's notes in `docs/DESIGN.md`, with sources
- [ ] 4.2 Verify Debian bookworm package availability and versions for the JDK, `tshark`, `procps`, `binutils`, `tini`, and `rizin`; record results and any fallback (for example Temurin) in `docs/DESIGN.md`
- [ ] 4.3 Write `docker/Dockerfile` (multi-stage, `linux/amd64`, Ghidra stage with hash verification, runtime as `99:100`, `WORKDIR /work`, volumes, `tini`, Node-based `HEALTHCHECK`, no `rea-agents setup`); verify the build succeeds and fails when `GHIDRA_SHA256` is altered
- [ ] 4.4 Implement the `GHIDRA_MAX_HEAP` mapping for the pinned Ghidra version and REA's launch path; verify the Ghidra JVM's effective max heap in a running container
- [ ] 4.5 Add an entrypoint check that reports clearly when `/work` is not writable by uid 99; verify with a root-owned bind mount
- [ ] 4.6 Verify the image under `--cap-drop=ALL --security-opt=no-new-privileges:true` with `/samples` read-only: runs as 99:100, `java`/`ps`/`tshark`/`objdump` resolve, health becomes `healthy`, authenticated `initialize` succeeds, headless Ghidra starts, and `docker stop` exits cleanly
- [ ] 4.7 Write a smoke-test script (generate throwaway key, run image, `curl /healthz`, MCP `initialize` with and without the key, assert `401` without, assert exit non-zero with no key); verify it passes locally

## 5. unRAID template

- [ ] 5.1 Read the current unRAID Docker template and Community Apps guidelines and record the applicable rules (attribute names, advanced display mode, icon guidance, whether `ca_profile.xml` is expected) with source links in `docs/DESIGN.md`
- [ ] 5.2 Create `unraid/icon.png` as original artwork at the size the guidelines recommend; verify it is a valid PNG with no third-party marks
- [ ] 5.3 Write `unraid/rea-mcp.xml` with all metadata fields, the port, masked empty required `REA_MCP_API_KEY`, read-only `/samples`, `/work` default, and the seven advanced variables; verify with `xmllint --noout`
- [ ] 5.4 Write the template check script (required elements and `Config` entries, empty masked key, `ro` samples, lowercase repository, defaults equal to gateway defaults); verify it fails on a deliberately broken copy
- [ ] 5.5 Add `ca_profile.xml` if task 5.1 shows it is expected; otherwise note the decision in `docs/DESIGN.md`

## 6. CI

- [x] 6.0 Add the CI skeleton ahead of the code: `ci.yml` with `secrets` (gitleaks, full history), `hygiene` (`scripts/check_hygiene.sh`), `openspec` (strict validation) and the `gate` job, Dependabot for actions, a PR template, and the importable ruleset `.github/rulesets/main.json`; verify each job passes on a pull request
- [ ] 6.0a Maintainer imports `.github/rulesets/main.json` under Settings → Rules → Rulesets and confirms a direct push to `main` is rejected
- [ ] 6.1 Add `.github/workflows/ci.yml` jobs for lint, typecheck, and tests on Node 24; add each to `gate`'s `needs`; verify they pass on a branch run
- [ ] 6.2 Add the gitleaks job scanning full history (`fetch-depth: 0`) and the template XML check job; verify both pass and that each fails on a seeded violation in a scratch branch
- [ ] 6.3 Add the image build job and run the smoke-test script from 4.7 against the built image; verify on a branch run
- [ ] 6.4 Add GHCR publishing on `main` and version tags using the workflow token with least-privilege `permissions`, lowercase image name, and no stored secrets; **get maintainer approval before this job is enabled or first runs**
- [ ] 6.5 (Optional) Add `.github/workflows/release.yml` for tagged releases

## 7. Documentation

- [ ] 7.1 Complete `docs/DESIGN.md`: architecture, gateway choice, REA launch command, Ghidra/JDK pin and heap mechanism, session and keep-alive design, and every remaining UNVERIFIED item
- [ ] 7.2 Expand `README.md`: quick start, environment-variable table, long-running-call behaviour (~100 s proxy timeout and keep-alives), unRAID install (template repository URL or copying the XML to `/boot/config/plugins/dockerMan/templates-user/`), key generation with `openssl rand -hex 32`, and connecting from Claude Code and as a Claude custom connector, with placeholders only
- [ ] 7.3 Write `docs/CLOUDFLARE.md`: point a tunnel hostname at `container:8080`, set `TRUST_PROXY=true`, do not put Cloudflare Access service-token policies on the hostname, the ~100 s origin timeout
- [ ] 7.4 Write `docs/SECURITY.md`: what the server can do, key rotation with `REA_MCP_API_KEYS`, mount only a dedicated samples directory, consider blocking container egress, memory sizing, and the legal note on only analyzing permitted software
- [ ] 7.5 Review all docs for real hostnames, keys, or tokens; verify with gitleaks and a grep for `x-api-key` showing placeholders only

## 8. Acceptance

- [ ] 8.1 Run the scripted secret check over the working tree and full history (gitleaks plus a grep pass for key-shaped strings) and confirm zero findings
- [ ] 8.2 Confirm the only tracked binary is `unraid/icon.png` and nothing under `samples/` or `work/` is tracked
- [ ] 8.3 End-to-end check from Claude Code against a locally running container: `claude mcp add --transport http rea http://localhost:8080/mcp --header "x-api-key: <key>"`, then list tools and run one analysis on a permitted sample
- [ ] 8.4 Run `openspec validate bootstrap-rea-mcp-gateway --strict` and reconcile specs with what was built
- [ ] 8.5 Report to the maintainer the final list of open questions, assumptions, and any item still marked UNVERIFIED

## Workflow follow-up

- Ask the maintainer before the first push and before creating or publishing the GHCR package.
- Archive this change with `openspec archive bootstrap-rea-mcp-gateway` once all tasks are complete, which promotes the six capability specs into `openspec/specs/`.
