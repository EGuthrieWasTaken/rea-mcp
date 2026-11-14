# Design

## Context

The repository began with only a README, license, ignore rules, and these
planning artifacts; the first implementation phase added guard rails and the
REA discovery results in `docs/DESIGN.md`. REA (`rea-agents`) is a local stdio
MCP server. Version 6.9.0 also has an opt-in `rea mcp --http` mode, but it has
no authentication and serves one client at a time, so it cannot stand in for the
gateway. The deployment target is a single unRAID host, reached from Claude
through a Cloudflare Tunnel that terminates TLS outside this project and cuts
idle origin responses at roughly 100 s.

Claims about REA's launch command, runtime behaviour and checkpoints are now
recorded with their evidence in `docs/DESIGN.md`. Claims about Ghidra, Debian,
unRAID and Cloudflare have not been verified against primary sources yet; every
such claim is listed under "Unverified assumptions" and has a task that verifies
it before it is relied on.

The canonical long-form design lives in `docs/DESIGN.md`; this file records the
decisions that shape the specs and tasks.

## Goals / Non-Goals

**Goals:**

- Serve REA's unmodified MCP surface over streamable HTTP with one isolated REA
  process per session.
- Make an unauthenticated or weakly-keyed deployment impossible to start.
- Survive multi-minute Ghidra analyses behind a ~100 s idle timeout.
- Run with least privilege (uid 99:100, no capabilities, read-only samples).
- Install from the unRAID UI with secure defaults.
- Make committing a secret or a sample hard, and detectable in CI.
- Keep each session's outputs apart and, optionally, keep a binary's Ghidra
  analysis across sessions and restarts.

**Non-Goals:**

- TLS, tunnels, or any reverse proxy inside the container.
- OAuth, per-user identity, or per-key authorization scopes.
- Modifying, wrapping, or filtering REA's tools.
- Horizontal scaling, or persisting REA's in-memory session state across
  gateway restarts (Ghidra analysis can persist through the optional
  checkpoint, D14).
- Security isolation between sessions or projects: separation is by process and
  working directory only.
- arm64 images.

## Decisions

### D1. Thin custom gateway on `@modelcontextprotocol/sdk`

Build a small TypeScript gateway using the official SDK: a small stdio
transport of our own towards each REA child (the SDK's `StdioClientTransport`
fixes its own environment and shutdown sequence, so ours reuses only its framing
helpers) and a `StreamableHTTPServerTransport` towards each HTTP client, with
messages relayed between the two at the transport level.

- **Why:** the three requirements that existing bridges must meet (header-auth
  middleware, one child per MCP session, keep-alives) are exactly the parts we
  must be able to test and reason about. Owning ~a few hundred lines is cheaper
  than auditing a general-purpose bridge for "never logs headers".
- **Alternatives:** `mcp-proxy`, `supergateway`, and proxying to a per-session
  `rea mcp --http` child (REA's own HTTP mode, which supplies neither auth nor
  concurrency, so it would only replace the stdio relay). Any is acceptable only
  if it demonstrably supports all three requirements. Task 2.4 evaluates them and
  records the outcome in `docs/DESIGN.md`; the default is the custom stdio relay.

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
  children (D8 builds that environment from an allowlist).
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
- Before spawning, the gateway creates `/work/sessions/<session-id>` and starts
  the child there (D13).
- Idle reaping considers a session idle only when its in-flight count is zero.
- Children are spawned in their own process group (`detached: true`) so that
  termination can signal the whole group (REA plus any Ghidra JVM). Termination
  closes the child's stdin first, because REA treats stdin end as a shutdown
  request and answers with its full cleanup (stopping Ghidra and, with
  checkpointing on, saving the checkpoint). It then waits up to the grace period,
  sends `SIGTERM` to the group and waits 2 s, and finally sends `SIGKILL`.
- The grace period is a constant: 5 s, or 30 s when `REA_GHIDRA_CHECKPOINT_DIR`
  is set, so that REA can save a large Program (D14). Constants become env vars
  only if needed.
- Gateway shutdown: stop listening, terminate all groups in parallel, exit 0.
  The budget is 10 s or less without checkpointing, inside Docker's 10 s default,
  so no custom stop timeout is needed. With checkpointing it is up to 40 s, so
  the container's stop timeout must be raised to at least that; how the unRAID
  template sets one is unverified (task 5.1).
- Child stderr is line-buffered into the JSON log at `debug`/`warn`.

### D7. Keep-alives

A per-stream timer writes an SSE comment (`: keep-alive`) whenever ~15 s pass
without a write. The gateway forces SSE responses for requests (rather than a
single buffered JSON response) so that there is a stream to keep alive.

- **Spike result (task 3.6): no wrapper is needed.** The SDK's streamable HTTP
  transport answers a POST with an SSE stream by default and itself writes
  `: keepalive` comment frames every `keepAliveMs` (default 15 s) while a request
  is open. The gateway sets `keepAliveMs` and relies on it; a test pins that
  behaviour against SDK upgrades (`docs/DESIGN.md`, section 7).
- A notification reaches a request's stream only when it is sent with that
  request's id; otherwise it belongs to the standalone GET stream. Progress
  forwarding therefore maps progress tokens back to request ids (task 3.15).
- The integration test uses a fake tool with a scaled clock (for example a
  120 s call and 15 s interval scaled to 1.2 s and 150 ms, through `keepAliveMs`)
  plus an injected idle-timeout proxy that drops silent connections.

### D8. REA launch command and child environment

REA is started with `process.execPath` and the arguments
`[<package-root>/scripts/rea.mjs, "mcp"]`, where `<package-root>` is resolved
from the installed `rea-agents` dependency. It is spawned without a shell and
without `npx`. This was verified in task 2.1 (`docs/DESIGN.md`, section 1.2).
The command, arguments, working directory and environment come from one internal
configuration point (not documented as a user setting) so integration tests can
substitute the fake stdio MCP server.

The child's environment is built from an allowlist, never copied wholesale:
`PATH`, `HOME`, `JAVA_HOME` and `GHIDRA_INSTALL_DIR` when set, `TMPDIR` when set,
`GHIDRA_HEADLESS_MAXMEM` (mapped from `GHIDRA_MAX_HEAP`, D10), and
`REA_GHIDRA_STARTUP_TIMEOUT_MS` and `REA_GHIDRA_CHECKPOINT_DIR` when set. No
`REA_MCP_API_KEY*` variable is on the list (D4). Neither are the five REA
settings that REA refuses to combine with a checkpoint directory:
`REA_GHIDRA_PROJECT_PATH`, `REA_GHIDRA_SEED_FILE`, `REA_GHIDRA_NATIVEAOT_JAR`,
`REA_GHIDRA_LANGUAGE_ID` and `REA_GHIDRA_DISABLED_ANALYZERS`.

### D9. Image layout

Three stages on `node:24-bookworm-slim`, whose Node must be 24.22.1 or newer
(REA's admission floor on the 24 line):

1. `ghidra`: `curl` + `unzip`, download `GHIDRA_URL`, `sha256sum -c` against
   `GHIDRA_SHA256`, extract to `/opt/ghidra`.
2. `build`: `npm ci`, compile TypeScript, `npm prune --omit=dev`.
3. `runtime`: a full JDK (including `javac`), `procps`, `tshark`, `binutils`,
   `tini`, optionally `rizin`; copy `/opt/ghidra`, the compiled gateway, and
   production `node_modules` (including pinned `rea-agents`); `USER 99:100`;
   `WORKDIR /work`; `GHIDRA_INSTALL_DIR=/opt/ghidra`.

- `HEALTHCHECK` uses a Node one-liner (`fetch` against `/healthz`) because
  `curl` is not in the runtime stage.
- REA gives each Ghidra session private `HOME`, `TMPDIR` and `XDG_*` directories
  under its session root (`os.tmpdir()`, falling back to `/tmp` when that path
  has a dot-prefixed element, which Ghidra rejects), and keeps checkpoint leases
  under `/tmp` regardless of `TMPDIR`. So `/tmp` must be writable and `TMPDIR`,
  if set, must have no dot-prefixed element. REA's own `HOME` points at a
  writable directory under `/work`.
- `/work` holds `home`, `sessions` and, when enabled, `checkpoints`.
- `tshark` is used only to read capture files, never to capture, so no file
  capabilities are set and `libcap2-bin` is not expected to be needed. This is
  what makes `--cap-drop=ALL` workable.
- The JDK major version follows the pinned Ghidra release notes. If Debian
  bookworm does not package that version, use the Eclipse Temurin apt
  repository or copy the JDK from an official `eclipse-temurin` image stage.

### D10. Ghidra heap

`GHIDRA_MAX_HEAP` is validated at gateway startup as a JVM heap size and passed
to each child as `GHIDRA_HEADLESS_MAXMEM`. That is the variable REA reads to
build Ghidra's `-Xmx` (default `2G`). REA blanks `JAVA_TOOL_OPTIONS` and the
other Java option variables, so setting `JAVA_TOOL_OPTIONS`, or editing
`analyzeHeadless`, cannot work. Whether Ghidra's JVM then reports the expected
maximum heap is verified in task 4.4.

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

### D13. Per-session working directory

Each child starts in `/work/sessions/<session-id>`, created by the gateway
before it spawns the child. Anything REA writes relative to its working
directory therefore stays apart per session.

- It is tidiness, not a boundary: every child runs as the same uid, `/work` and
  `/samples` are shared, and tools can still be given absolute paths.
- `TMPDIR` is left at its default. REA's Ghidra bridge may use a Unix socket
  under the session root, whose path length limit (about 108 bytes) could
  constrain a long per-session `TMPDIR`; that is unverified (task 4.6).
- Session directories are not deleted when a session ends, so tool output
  survives the session (open question 8).

### D14. Shared, opt-in Ghidra checkpoint

When the operator sets `REA_GHIDRA_CHECKPOINT_DIR` (recommended
`/work/checkpoints`) the gateway passes it unchanged to every child, so all
sessions share one root. It is unset by default. REA then saves a binary's Ghidra
Program after first analysis and again on normal close, and restores it with
`-noanalysis` in later sessions (evidence in `docs/DESIGN.md`, section 2.8).

- **Why shared:** it is the simplest option that keeps analysis beyond one
  session, and no security boundary is required. A per-workspace namespace would
  need a stable client-supplied name, which is unverified for the claude.ai
  connector and is left as a later extension.
- **Keyed by binary content:** names, comments and types saved in one
  conversation appear in any later one that opens the same bytes.
- **One live session per binary:** a second session fails at once with "another
  REA session owns this checkpoint". A reconnecting conversation can be blocked
  by its own idle child until that child is reaped or the agent calls
  `close_binary`; the user documentation says to call it when finished.
- **All-or-nothing:** with the variable set, targets that are not stock ELF, PE
  or Mach-O imports fail to open with Ghidra instead of falling back, and five
  REA settings cannot be combined with it (D8).
- **Shutdown:** children are stopped with stdin EOF first and a 30 s grace (D6),
  so REA can save. A killed child never corrupts a checkpoint but loses edits
  made since its last save.
- **Constraints:** REA's lease sockets live under `/tmp`, so one checkpoint root
  must serve one container; nothing prunes old entries, so cleanup is the
  operator's.

## Risks / Trade-offs

- **REA 6.9.0 only** → the launch command and runtime facts were verified against
  one exact version; `rea-agents` is pinned with a lockfile, and an upgrade must
  repeat the discovery checks in `docs/DESIGN.md`.
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
  for a single-host tool; clients re-initialize (Ghidra analysis can survive
  through the optional checkpoint).
- **Ghidra memory × `MAX_SESSIONS`** → four sessions at an 8G heap can exceed
  host RAM; document sizing, keep the default cap low.
- **Process-group kill misses a re-parented grandchild** → `tini` as PID 1
  reaps; the integration test asserts no survivors after session end.
- **Checkpointing is all-or-nothing and shared** → off by default; when on,
  non-stock targets fail to open with Ghidra and annotations are visible across
  conversations on the same binary. Documented in the template and README.
- **A conversation can lock itself out of its binary** → the lease is held by
  its own idle child until reaped or closed; mitigated by `close_binary`
  guidance and, if needed, a shorter idle timeout. Inferred, not yet tested.
- **The checkpoint grace period may be too short for a very large Program** →
  edits since the last save are lost, never corrupted; the 30 s constant is
  revisited if testing shows otherwise.
- **`:latest` in the unRAID template** → convenient but unpinned; README
  explains how to pin a version tag.
- **Supply chain** → `rea-agents` is exact-pinned with a lockfile and Ghidra
  is hash-verified; base image is pinned by tag (consider digest pinning).

## Unverified assumptions

Each of these must be confirmed against a primary source during implementation
and recorded, with the source, in `docs/DESIGN.md`, whose section 4.2 is the
canonical list with evidence and the task that closes each item.

- Which Ghidra release to pin, its SHA-256, and the JDK major version it
  requires (REA verifies Ghidra 12.1.4 with JDK 21; that is REA's statement
  about Ghidra, not Ghidra's own).
- That `GHIDRA_HEADLESS_MAXMEM` produces the expected maximum heap in the
  running Ghidra JVM.
- That REA behaves correctly on Node 24.22.1 or newer (its admission rule was
  verified; its behaviour on Node 24 was not run).
- That Debian bookworm ships a full JDK of the needed major version, `tshark`
  4.x, and whether it ships `rizin` at all; and that `node:24-bookworm-slim`
  resolves to Node 24.22.1 or newer.
- That REA and Ghidra work with a read-only `/samples`, a read-only root
  filesystem and a non-root uid, writing only under `/work` and the temporary
  directory.
- That the official Linux x86_64 Ghidra archive ships the native decompiler.
- That the SDK's streamable HTTP transport permits SSE comment frames and
  forced-SSE responses as assumed in D7.
- That checkpoint restore with a real Ghidra is fast and preserves names,
  comments and types, and that publishing on close fits the 30 s grace.
- That, with checkpointing on, non-stock targets fail to open instead of
  falling back, and that a conversation can be blocked by its own idle child.
- Whether unRAID's tooling or user shares leave checkpoint directories at mode
  `700` owned by uid 99, and how a template sets a Docker stop timeout.
- Whether Claude Code and the claude.ai connector start a separate MCP session
  per conversation and send `DELETE /mcp` or call `close_binary` on exit.
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
8. Should `/work/sessions/<session-id>` be deleted when a session ends, or kept?
   Proposed: kept, with cleanup left to the operator.
9. Should the termination grace periods (5 s, and 30 s with checkpointing) stay
   constants, or become settings? Decided for now: constants.
10. Should checkpoint entries be pruned by the gateway, or is operator cleanup
    enough? Proposed: operator cleanup, documented.
