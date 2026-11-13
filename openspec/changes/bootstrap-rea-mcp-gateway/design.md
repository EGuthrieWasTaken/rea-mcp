# Design

## Context

The repository is empty apart from its README, license, ignore rules, and these
planning artifacts. REA (`rea-agents`) is a local stdio MCP server; its
documentation describes no network mode. The deployment target is a single
unRAID host, reached from Claude through a Cloudflare Tunnel that terminates
TLS outside this project and cuts idle origin responses at roughly 100 s.

Nothing in this document has been verified against REA, Ghidra, Debian, or
unRAID primary sources yet. Every such claim is listed under
"Unverified assumptions" and has a task that verifies it before it is relied on.

The canonical long-form design lives in `docs/DESIGN.md` once implementation
starts; this file records the decisions that shape the specs and tasks.

## Goals / Non-Goals

**Goals:**

- Serve REA's unmodified MCP surface over streamable HTTP with one isolated REA
  process per session.
- Make an unauthenticated or weakly-keyed deployment impossible to start.
- Survive multi-minute Ghidra analyses behind a ~100 s idle timeout.
- Run with least privilege (uid 99:100, no capabilities, read-only samples).
- Install from the unRAID UI with secure defaults.
- Make committing a secret or a sample hard, and detectable in CI.

**Non-Goals:**

- TLS, tunnels, or any reverse proxy inside the container.
- OAuth, per-user identity, or per-key authorization scopes.
- Modifying, wrapping, or filtering REA's tools.
- Horizontal scaling or session persistence across gateway restarts.
- arm64 images.

## Decisions

### D1. Thin custom gateway on `@modelcontextprotocol/sdk`

Build a small TypeScript gateway using the official SDK: a
`StdioClientTransport` towards each REA child and a
`StreamableHTTPServerTransport` towards each HTTP client, with messages relayed
between the two at the transport level.

- **Why:** the three requirements that existing bridges must meet (header-auth
  middleware, one child per MCP session, keep-alives) are exactly the parts we
  must be able to test and reason about. Owning ~a few hundred lines is cheaper
  than auditing a general-purpose bridge for "never logs headers".
- **Alternatives:** `mcp-proxy`, `supergateway`. Either is acceptable only if
  it demonstrably supports all three requirements. Task 2.4 evaluates them
  briefly and records the outcome in `docs/DESIGN.md`; the default is custom.

### D2. Transport-level relay, not a re-implemented MCP server

The gateway pipes JSON-RPC messages between the two transports instead of
instantiating an SDK `Server` that re-declares REA's tools.

- **Why:** REA's capabilities, tool list, progress notifications, and
  cancellations pass through untouched, so the gateway cannot drift from REA.
- **Trade-off:** the gateway does not inspect message semantics, so it cannot
  enforce per-tool policy. That is a non-goal.

### D3. Plain `node:http`, no web framework

Three routes and a handful of pre-MCP checks do not justify a framework, and a
framework's default request logging and `X-Powered-By`-style banners work
against requirements 4 and the `/healthz` no-disclosure rule.

Request pipeline for `/mcp`, in order: method check → `ALLOWED_HOSTS` → rate
limit lookup → authentication → session lookup / creation → transport.
Authentication precedes session lookup so that an invalid key cannot probe for
session IDs.

### D4. Key handling

- Load keys once at startup from the three sources, trim, de-duplicate, and
  validate (≥ 32 characters each; any failure aborts startup).
- Store only SHA-256 digests in memory. Compare with `crypto.timingSafeEqual`
  on the 32-byte digest of the presented value against every stored digest,
  OR-ing the results without short-circuiting. Hashing first makes lengths
  equal, so a length mismatch takes the same path as a wrong key.
- Strip all `REA_MCP_API_KEY*` variables from the environment passed to
  children.
- The logger has no code path that accepts a headers object; request logging
  takes an explicit allowlist of fields (method, path, status, duration,
  source IP, session ID).

### D5. Failed-auth rate limiting

In-memory fixed-window counter per source IP. Proposed defaults: 10 failures
per 60 s, then `429` with `Retry-After` until the window ends. The map is
bounded and swept periodically so it cannot grow without limit. Source IP is
the socket peer unless `TRUST_PROXY=true`, then `CF-Connecting-IP`, else the
first `X-Forwarded-For` entry.

- **Why 429 rather than 401 when limited:** it tells a legitimate but
  misconfigured client what is happening and reveals nothing about key
  validity, because the key is not evaluated while limited.
- **Trade-off:** behind a tunnel with `TRUST_PROXY=false`, all traffic shares
  the tunnel's IP and one abuser can lock out everyone. `docs/CLOUDFLARE.md`
  must tell tunnel users to set `TRUST_PROXY=true`.
- The limits are constants initially; they become env vars only if needed.

### D6. Session lifecycle

- A `SessionManager` owns a map of session ID → { child, transports, in-flight
  count, last-activity time }.
- The slot is reserved before spawning, so concurrent `initialize` requests
  cannot overshoot `MAX_SESSIONS`. Over the cap → `503` + `Retry-After`; no
  eviction of live sessions.
- Idle reaping considers a session idle only when its in-flight count is zero.
- Children are spawned in their own process group (`detached: true`) so that
  termination can signal the whole group (REA plus any Ghidra JVM): `SIGTERM`,
  then `SIGKILL` after a grace period (proposed 5 s).
- Gateway shutdown: stop listening, terminate all groups in parallel, exit 0.
  Total budget stays under Docker's 10 s default; the unRAID template does not
  need a custom stop timeout.
- Child stderr is line-buffered into the JSON log at `debug`/`warn`.

### D7. Keep-alives

A per-stream timer writes an SSE comment (`: keep-alive`) whenever ~15 s pass
without a write. The gateway forces SSE responses for requests (rather than a
single buffered JSON response) so that there is a stream to keep alive.

- **Fallback if the SDK transport does not expose the raw response for
  comment frames:** wrap the `ServerResponse` passed to the transport. This is
  checked in task 3.6 before the approach is committed to.
- The integration test uses a fake tool with a scaled clock (for example a
  120 s call and 15 s interval scaled to 1.2 s and 150 ms) plus an injected
  idle-timeout proxy that drops silent connections.

### D8. REA launch command is injected, and discovered first

The command, arguments, and working directory used to start REA come from one
internal configuration point (`REA_COMMAND`-style, not documented as a user
setting) so the integration tests can substitute the fake stdio MCP server.
The real value is unknown until task 2.1 completes; that task gates all other
implementation. If REA cannot run as a standalone stdio MCP server, the change
stops there.

### D9. Image layout

Three stages on `node:24-bookworm-slim`:

1. `ghidra`: `curl` + `unzip`, download `GHIDRA_URL`, `sha256sum -c` against
   `GHIDRA_SHA256`, extract to `/opt/ghidra`.
2. `build`: `npm ci`, compile TypeScript, `npm prune --omit=dev`.
3. `runtime`: JDK, `procps`, `tshark`, `binutils`, `tini`, optionally `rizin`;
   copy `/opt/ghidra`, the compiled gateway, and production `node_modules`
   (including pinned `rea-agents`); `USER 99:100`; `WORKDIR /work`.

- `HEALTHCHECK` uses a Node one-liner (`fetch` against `/healthz`) because
  `curl` is not in the runtime stage.
- `HOME` and Ghidra/Java user directories are pointed under `/work` so nothing
  needs a writable home for uid 99 and the root filesystem can be read-only.
- `tshark` is used only to read capture files, never to capture, so no file
  capabilities are set and `libcap2-bin` is not expected to be needed. This is
  what makes `--cap-drop=ALL` workable.
- The JDK major version follows the pinned Ghidra release notes. If Debian
  bookworm does not package that version, use the Eclipse Temurin apt
  repository or copy the JDK from an official `eclipse-temurin` image stage.

### D10. Ghidra heap

`GHIDRA_MAX_HEAP` is mapped by the container entrypoint to whatever mechanism
the pinned Ghidra version and REA's way of launching Ghidra actually honour.
Candidates, in order of preference: an environment variable read by Ghidra's
launch scripts; `JAVA_TOOL_OPTIONS=-Xmx…` scoped to the REA child; editing
`MAXMEM` in `support/analyzeHeadless` at image build. The choice depends on
task 2.1 (how REA invokes Ghidra) and is recorded in `docs/DESIGN.md`.

### D11. unRAID template validation

CI runs `xmllint --noout` for well-formedness and a small script asserting the
required elements, `Config` targets, the empty masked key default, and the
`ro` samples mode. Template defaults are compared against the gateway's
defaults by the same script so the two cannot drift. An optional
`ca_profile.xml` is added only if the Community Apps guidelines call for it.

### D12. License

The repository is GPL-3.0 at the maintainer's direction (the original brief
said MIT). `package.json` uses `"license": "GPL-3.0-only"` pending
confirmation of `-only` versus `-or-later`. REA (MIT) is installed as a
dependency and Ghidra (Apache-2.0) as a separate program in the image; both
are compatible with distribution alongside GPLv3 code. The image must carry
the upstream license notices.

## Risks / Trade-offs

- **REA has no standalone stdio launch mode** → gated by task 2.1; stop and
  report rather than work around.
- **Claude custom connectors may not send an arbitrary `x-api-key` header** →
  the brief states this works "the same way as existing custom connectors";
  verify against the maintainer's existing connector before relying on it.
  Claude Code's `--header` flag is the fallback client and the first test.
- **A leaked key grants full analysis access to `/samples`** → static keys
  only; mitigated by multi-key rotation, mounting a dedicated samples
  directory, and optional egress blocking (documented in `docs/SECURITY.md`).
- **Keep-alives defeat the idle timeout but not a hard response cap** → if the
  proxy enforces an absolute duration, very long analyses still fail; document
  it and rely on REA's own asynchronous/job patterns if it has any.
- **In-memory session and rate-limit state is lost on restart** → acceptable
  for a single-host tool; clients re-initialize.
- **Ghidra memory × `MAX_SESSIONS`** → four sessions at an 8G heap can exceed
  host RAM; document sizing, keep the default cap low.
- **Process-group kill misses a re-parented grandchild** → `tini` as PID 1
  reaps; the integration test asserts no survivors after session end.
- **`:latest` in the unRAID template** → convenient but unpinned; README
  explains how to pin a version tag.
- **Supply chain** → `rea-agents` is exact-pinned with a lockfile and Ghidra
  is hash-verified; base image is pinned by tag (consider digest pinning).

## Unverified assumptions

Each of these must be confirmed against a primary source during implementation
and recorded, with the source, in `docs/DESIGN.md`.

- REA can be started as a standalone stdio MCP server, and with what command.
- Which Ghidra release to pin, its SHA-256, and the JDK major version it
  requires (the brief reports, second-hand, that the latest line needs JDK 25
  and the previous was the last to run on JDK 21).
- How REA locates Ghidra (environment variable, `PATH`, configuration file).
- Which mechanism sets Ghidra's maximum heap for the pinned version.
- That `REA_GHIDRA_STARTUP_TIMEOUT_MS` is read from the environment by REA.
- That REA supports Node 24 as stated in the brief.
- That Debian bookworm ships `tshark` 4.x, and whether it ships `rizin` at all.
- That REA and Ghidra work with a read-only `/samples` and write only under
  the working directory.
- That the SDK's streamable HTTP transport permits SSE comment frames and
  forced-SSE responses as assumed in D7.
- Current unRAID / Community Apps template rules: attribute names for advanced
  display, whether `ca_profile.xml` is expected, icon size guidance.
- That the Claude custom-connector UI accepts a static request header.
- The exact Cloudflare idle/response timeout applicable to tunnels.

## Open Questions

1. `GPL-3.0-only` or `GPL-3.0-or-later`?
2. Should the rate-limit thresholds (D5) be configurable, and are 10 failures
   per 60 s acceptable defaults?
3. Is `503` + `Retry-After` the wanted response at the session cap, as opposed
   to evicting the longest-idle session?
4. Which image tags should CI publish (`latest` on `main`, `vX.Y.Z` on tags,
   commit SHA)? Publishing to GHCR needs explicit maintainer approval first.
5. Should the GHCR package be public (required for a template that pulls
   without registry credentials)?
6. Is Rizin wanted if it is not in the distribution and would need a
   third-party download?
7. Is submission to Community Apps intended, or only a private template URL?
