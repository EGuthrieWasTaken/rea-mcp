# rea-mcp design (long form)

> **Status (2026-11-15).** The gateway, image, template, icon and their checks are built and verified on an
> unRAID 7.3.4 host (sections 8 to 11). The CI jobs ran on the first pull request, where `image` passed and
> `template` exposed a bug that is fixed (section 12); the image has been published to GHCR and an anonymous pull of it
> passes the smoke test (section 12); Claude Code has been run end to end against the container (section 14); and the claude.ai connector and a Cloudflare
> Tunnel are still to do.
> Section 13 is the current list of what is **UNVERIFIED**. The decisions that shape the specs live in
> [`openspec/changes/archive/2026-11-15-bootstrap-rea-mcp-gateway/design.md`](../openspec/changes/archive/2026-11-15-bootstrap-rea-mcp-gateway/design.md);
> this document records the evidence behind them. User-facing guidance is in the
> [README](../README.md), [`SECURITY.md`](SECURITY.md) and [`CLOUDFLARE.md`](CLOUDFLARE.md).

Evidence labels used below:

- **Ran**: observed by running it.
- **Source**: read in REA's published source.
- **Docs**: stated in REA's documentation only, not exercised.
- **UNVERIFIED**: not confirmed from a primary source. Never to be relied on
  until a task verifies it.

Findings about REA were gathered against:

| Item | Value |
|---|---|
| Package | `rea-agents@6.9.0` from the npm registry |
| Package integrity | `sha512-KqDn1UR5BMqHoQ3MGAnPuWiSKwgdFaz1L/uUNgrKt+1W8kPtgYP8AWEOXIF1lDIOBVyPuYIIst2iamo1Wf3r8g==` |
| Source read | `github.com/morluto/rea` at commit `cdc4541ef707f256f83abe5018df01a25182cf0b` (`package.json` version `6.9.0`) |
| Runtime | Node 22.23.4, Linux x86_64 |
| Date | 2026-11-13 |

## Architecture at a glance

```
client (Claude Code or the claude.ai connector)
  --HTTPS--> your proxy or tunnel (outside this project)
  --HTTP--> container, user 99:100, tini as PID 1, entrypoint checks /work and /tmp
        gateway (Node 24, plain node:http)         src/main.ts, src/http/*, src/sessions/*
          /healthz   /mcp (POST, GET, DELETE)
          for each MCP session:  one REA child, started in /work/sessions/<id>, over stdio
            REA (rea-agents 6.9.0) --> Ghidra 12.1.4 on a Temurin 21 JDK, tshark, objdump
```

| Concern | Decision | Evidence |
|---|---|---|
| Gateway | A thin custom relay on the MCP SDK between a streamable-HTTP transport and a stdio child; not `supergateway`, `mcp-proxy` or per-session `rea mcp --http` | section 6 |
| Launching REA | `node <rea-agents>/scripts/rea.mjs mcp`, no shell, no `npx`, an allowlisted environment with no key variable | sections 1, 2.2; design D8 |
| Authentication | Static key in `x-api-key`, at least 32 characters, SHA-256 digests compared in constant time, checked before any session lookup; failed attempts limited per source address; refuses to start without a key | design D4, D5; section 11.4 |
| Sessions | One REA process per MCP session. A slot is reserved first (cap `MAX_SESSIONS`, `503` over it); the gateway makes the session directory, starts the child and performs `initialize` itself, so a failed start is a plain `502`. Idle reaping spares sessions with a call in flight. Ending a session closes the child's stdin, waits the grace (5 s, 30 s with checkpoints), then `SIGTERM`, 2 s, `SIGKILL`, to the whole process group | design D6, D13; sections 7, 11.5 |
| Keep-alives | The SDK transport writes an SSE comment every `keepAliveMs` (15 s) while a request is open; progress tokens are mapped to request ids so progress reaches the right stream | design D7; section 7 |
| Ghidra and JDK | Ghidra 12.1.4 (hash-verified) on Temurin 21.0.13+9 (hash-verified), on a bookworm Node 24.22.3 base pinned by digest | sections 8, 9, 11.1 |
| Heap | `GHIDRA_MAX_HEAP` becomes `GHIDRA_HEADLESS_MAXMEM`, the one setting REA honours | sections 2.4, 11.3 |
| Checkpoints | Optional, shared, off by default: REA saves a binary's Ghidra analysis keyed by its bytes | sections 2.8, 5.2, 11.6 |
| Image and runtime | Multi-stage `linux/amd64`, non-root, no capabilities, `/samples` read-only, health check, an entrypoint that explains an unwritable `/work` or `/tmp` | sections 11.1, 11.2, 11.4 |
| unRAID | A template with a masked empty key, read-only samples and eight advanced variables, checked by script and by unRAID's own parser; not in Community Apps | sections 5.5, 10 |
| Security posture | The key grants command execution in the container, so isolation of the container matters | section 11.5; `docs/SECURITY.md` |

## Summary: the prerequisite gate (task 2.3)

**Result: pass.** REA runs as a standalone stdio MCP server, so work continues.
The exact launch command, for `rea-agents@6.9.0` on Node 22.23.4 or newer in the
admitted ranges (see 2.1), is:

```
node <package-root>/scripts/rea.mjs mcp
```

It completed an MCP `initialize` and `tools/list` over stdio (255 tools). Section 1
has the evidence, section 2 the runtime facts, section 3 what they change in the
OpenSpec artifacts, section 4 everything still **UNVERIFIED** plus the open
questions, and section 5 the decisions taken since discovery.

## 1. REA launch discovery

### 1.1 Result

REA **can** run as a standalone stdio MCP server. The prerequisite gate of the
change (task 2.1) passes and no workaround is needed.

### 1.2 Launch command

```
node <package-root>/scripts/rea.mjs mcp
```

`<package-root>` is the installed `rea-agents` directory. The package has no
`exports` map, so `require.resolve("rea-agents/package.json")` locates it.
`node_modules/.bin/rea mcp` and `rea-agents mcp` are the same entry point (both
`bin` names point at `scripts/rea.mjs`), and `--mcp` is accepted in place of `mcp`.

- **Arguments decide the mode.** The dispatcher in `scripts/rea.mjs` treats
  `mcp` with no further arguments as stdio. `mcp add` and `mcp doctor` run those
  commands instead of the server, and `mcp --http …` starts REA's own HTTP
  listener (see 1.5). The gateway must pass exactly `mcp` (**Source**).
- **Framing.** Newline-delimited JSON-RPC on stdin/stdout. stdout carries
  nothing but protocol messages (**Ran**: 0 non-JSON lines).
- **Environment.** A child started with only `PATH` and `HOME` initializes and
  lists tools (**Ran**).
- **Spawn it directly, without a shell and without `npx`.** `npx` would reach the
  network at start. Resolve the script path from the installed dependency and
  spawn `process.execPath` with it. This is the single configuration point that
  D8 of the change design calls for.

### 1.3 How it was verified (task 2.1)

In a throwaway directory outside the repository, with a scratch `HOME` and an
empty working directory, `rea-agents@6.9.0` was installed with
`npm install --ignore-scripts` and driven over stdio:

| Step | Observation (**Ran**) |
|---|---|
| `initialize` (client offered `2025-06-18`) | Result in about 0.3 s: `protocolVersion` `2025-06-18`, `serverInfo` `{name: "rea", version: "6.9.0"}`, capabilities `tools.listChanged`, `prompts.listChanged`, `completions`, and `instructions` text |
| `tools/list` | 255 tools in a single page, with the default catalog profile |
| Idle behaviour | Nothing written to stderr; no files created under `HOME` or the working directory |
| stdin closed | Process exits with status `0` within about 11 ms (no request in flight) |

To reproduce:

```bash
mkdir /tmp/rea-probe && cd /tmp/rea-probe
npm init -y >/dev/null
npm install --ignore-scripts rea-agents@6.9.0
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  | HOME="$(mktemp -d)" node node_modules/rea-agents/scripts/rea.mjs mcp
```

The tool list does not depend on which analysis engines are installed: all 255
tools were advertised with no Ghidra, Hopper, IDA, JADX or Kuna present
(`rea doctor` reported each as `missing_analysis_engine`). What a tool call does
when its engine is missing was not exercised (**UNVERIFIED**).

### 1.4 What `rea setup` would write

`rea setup` registers REA with local agent clients and installs a skill. It was
exercised only with `--dry-run`, against a scratch `HOME`; nothing was written.

| Invocation | Planned actions (**Ran**) |
|---|---|
| `setup --dry-run --yes --all-detected` (no agents present) | Install the bundled skill under `~/.agents/skills/reverse-engineer-anything` |
| `setup --dry-run --yes --client claude_code` | Edit `~/.claude.json` to add an MCP registration whose command is `node <package-root>/scripts/rea.mjs mcp`, and install the skill under `~/.claude/skills/reverse-engineer-anything` |

Both edit files under the user's home directory and neither is needed to serve
MCP. The image therefore never runs `setup`, as the change proposal requires.
Note that the registration `setup` would write is the same launch command as 1.2,
which is independent confirmation of it.

### 1.5 REA's own streamable HTTP mode (observed, relevant to task 2.4)

The change proposal says REA's documentation describes no network mode. In
6.9.0 that is no longer true: `rea mcp --http [--host H] [--port N]` serves the
same tool catalog over the MCP streamable HTTP transport (**Source**: dispatcher
plus `docs/specs/agent-environments/http-transport/spec.md`, upstream issue
`morluto/rea#4933`). It is opt-in; bare `rea mcp` stays stdio. It was started
and exercised on loopback:

| Probe (**Ran**) | Result |
|---|---|
| Startup | One JSON line on stderr announces `http://127.0.0.1:<port>/mcp`; default port is `0` (ephemeral); stdout unused |
| `initialize` and `tools/list` with no credentials | `200`, 255 tools. **There is no authentication.** |
| Same request with an arbitrary `x-api-key` header | `200`. The header is ignored. |
| Second client sends `initialize` while the first session is open | `200` with a new session ID; the **first client's next request gets `404 Session not found`**. |
| `Host` header that is not loopback | `403 Invalid Host: <name>` on a loopback bind |
| `SIGTERM` | Exits with status `143` |

Upstream documents this as intended: "Concurrent clients are not supported: the
newest `initialize` owns the server." Non-loopback binds additionally require a
Host allowlist (`--allowed-hosts` or `MCP_ALLOWED_HOSTS`) (**Source**).

What this means for the gateway (inputs to task 2.4, not decisions):

- REA's HTTP mode cannot stand alone as the product. It has no API-key check, so
  it cannot meet the `api-key-auth` capability, and it serves one client at a
  time, so it cannot meet `session-management` (isolated concurrent sessions).
- The per-session-child design therefore remains necessary. The gateway can
  front each child either over stdio (D1/D2 as written) or by proxying to a
  per-session `rea mcp --http` child on loopback. Nothing observed argues
  against the stdio relay: it avoids port allocation and REA's own Host/Origin
  checks. This is to be confirmed in 2.4.
- The statement in the proposal's "Why" section is stale and should be reworded
  when the artifacts are next updated.

## 2. REA runtime facts

These are the facts the gateway and image depend on (task 2.2). Anything that
would need a running Ghidra could not be exercised during discovery, because
Ghidra was not available there, and is marked **UNVERIFIED** with the task that
closes it.

### 2.1 Node versions

`package.json` declares `engines.node` as `^22.23.4 || ^24.22.1 || >=26.12.1`
(**Source**), and `scripts/rea.mjs` enforces it at start through
`scripts/lib/runtime-admission.mjs`. Calling REA's own check with candidate
versions (**Ran**):

| Node | 22.22.0 | 22.23.4 | 23.0.0 | 24.0.0 | 24.21.9 | 24.22.1 | 24.30.0 | 25.1.0 | 26.12.0 | 26.12.1 |
|---|---|---|---|---|---|---|---|---|---|---|
| Admitted | no | **yes** | no | no | no | **yes** | **yes** | no | no | **yes** |

- Node 24 is supported **only from 24.22.1**, and Node 25 is not supported. The
  image's Node 24 base must resolve to 24.22.1 or newer. `node:24-bookworm-slim`
  resolved to 24.22.3 on 2026-11-14 (section 9.2).
- REA was exercised on Node 22.23.4 during discovery (**Ran**). On 2026-11-14 the
  CI `test` job on Node 24.22.3 started the pinned `rea-agents` 6.9.0 through the
  gateway, listed its tools, called one, and delivered
  `REA_GHIDRA_STARTUP_TIMEOUT_MS` to it (`test/real-rea.test.ts`, 2 tests passed;
  **Ran**, [run 43635764228](https://github.com/EGuthrieWasTaken/rea-mcp/actions/runs/43635764228)).
  That covers REA's stdio server on Node 24. Its Ghidra-backed analysis on Node 24
  was then run in the image, on all 22 sample binaries (section 11.5; **Ran**).

### 2.2 How REA finds Ghidra and Java

- **`GHIDRA_INSTALL_DIR`**: absolute path to the root of an extracted official
  Ghidra release, containing `support/analyzeHeadless` and
  `Ghidra/application.properties`. A relative path is rejected
  (**Source**: `GhidraInstallation.ts`). With it unset, `rea doctor` reports
  `GHIDRA_INSTALL_DIR is not set` and "Set GHIDRA_INSTALL_DIR to an extracted
  Ghidra 12.x (>=12.1) release directory" (**Ran**).
- **Fallback**: a `ghidra` or `ghidraRun` launcher on `PATH` whose real path
  lies inside a complete Ghidra tree (**Source**: `discoverGhidraInstallationOnPath`).
  The image should set `GHIDRA_INSTALL_DIR` explicitly and not rely on this.
- **Java**: `JAVA_HOME` (absolute) if set, otherwise `java` on `PATH`. It must be
  a 64-bit **full JDK that includes `javac`**, whose major version lies within
  the `application.java.min` / `application.java.max` range declared in the Ghidra
  installation's own `application.properties` (**Source**: `GhidraInstallationPolicy.ts`;
  **Docs**: `docs/getting-started/installation.md`). A JRE-only package is not
  enough.
- **Native decompiler**: `Ghidra/Features/Decompiler/os/linux_x86_64/decompile`
  (or the `build/os/...` equivalent) must exist and match the host
  (**Source**). Whether the official x86_64 release archive ships it is
  **UNVERIFIED** (REA's docs say only that Linux ARM64 may need a manual build).
- Discovery is read-only and does not execute the Ghidra launcher (**Docs**).

### 2.3 Ghidra release and JDK

- REA 6.9.0 verifies against **Ghidra 12.1.4** and **JDK 21**
  (`SUPPORTED_GHIDRA_VERSION`, `SUPPORTED_GHIDRA_JAVA_MAJOR`; **Source**). Any
  Ghidra 12.x from 12.1 upward is admitted, but a build other than 12.1.4 runs
  with an "unverified build" limitation recorded on the session (**Source**).
- REA's docs state that 12.1 releases require JDK 21 or newer, that Ghidra 12.2
  declares JDK 25 or newer, and that neither sets a maximum (**Docs**). For 12.1.4
  that agrees with Ghidra's own `application.properties` (`application.java.min=21`,
  no maximum), confirmed in section 8. Ghidra 12.2's JDK 25 declaration was not
  examined.
- The release URL and SHA-256 for Ghidra 12.1.4 are recorded in section 8
  (task 4.1). The pin is 12.1.4 with JDK 21, the pair REA verified. Only the
  comparison of that SHA-256 with the value Ghidra publishes is still
  **UNVERIFIED**.

### 2.4 Ghidra heap

- REA launches Ghidra's JVM with `-Xmx${GHIDRA_HEADLESS_MAXMEM || GHIDRA_MAXMEM || "2G"}`,
  appended after the VM arguments from Ghidra's own launch support, so it wins
  (**Source**: `GhidraJavaLaunch.ts`; **Docs**). The default is `2G`. The value
  must be a JVM heap size such as `512M` or `2G`; an invalid value makes Java
  fail to start (**Docs**).
- REA **blanks** `_JAVA_OPTIONS`, `JAVA_TOOL_OPTIONS`, `JDK_JAVA_OPTIONS` and
  `GHIDRA_JAVA_OPTIONS` inherited from its caller (**Source**:
  `ghidraJavaEnvironment`; **Docs**: "Custom flags injected through these
  variables are not supported configuration").
- Consequence for design D10: of the three candidate mechanisms, **a
  `JAVA_TOOL_OPTIONS=-Xmx…` scoped to the child cannot work** (it is cleared),
  and editing `MAXMEM` in `analyzeHeadless` would be overridden by the later
  `-Xmx`. The mechanism REA supports is to give each REA child
  `GHIDRA_HEADLESS_MAXMEM`, so `GHIDRA_MAX_HEAP` maps onto that variable in the
  child's environment. That the running Ghidra JVM then reports the expected
  maximum heap was **UNVERIFIED** until task 4.4 ran it; it does (section 11.3).
- The heap limit does not bound total memory: the Node process, the JVM outside
  its heap and Ghidra's native decompiler processes (their number follows the
  available CPUs) sit on top of it (**Docs**). Memory sizing must be
  `MAX_SESSIONS` times heap plus that overhead.

### 2.5 Ghidra startup timeout

`REA_GHIDRA_STARTUP_TIMEOUT_MS` is read from REA's own process environment
(**Ran**, by asking REA's `inspect_analysis_settings` tool for
`ghidra.startup_timeout_ms`):

| Environment | Effective value | Source reported |
|---|---|---|
| unset | `330000` ms | `default` |
| `REA_GHIDRA_STARTUP_TIMEOUT_MS=600000` | `600000` ms (`launch_value` too) | `setting` |
| `REA_GHIDRA_STARTUP_TIMEOUT_MS=abc` | no value; `configuration_invalid`: "Expected an integer from 1 to 2147483647 ms" | n/a |

- It applies at the next Ghidra startup, and the accepted range is 1 to
  2,147,483,647 ms (**Ran**). The 330 s default is well above the roughly 100 s
  idle timeout of the tunnel, so the gateway's keep-alives are required.
- **An invalid value does not stop REA from starting.** `abc`, `0` and
  `2147483648` all initialized and listed tools (**Ran**); the error surfaces
  only when the setting is inspected or used (**Ran** for `abc`; `0` and
  `2147483648` were not inspected). Passing the variable through unchanged, as
  the `mcp-http-gateway` spec says, therefore means a bad value shows up as a
  tool-call error and not as a startup failure.

### 2.6 Where REA writes

- **At idle, nothing**: no files under `HOME` or the working directory after
  `initialize` + `tools/list`, `rea doctor`, `rea setup --dry-run`, or an HTTP
  session (**Ran**).
- **Ghidra session state** is placed under a private session root. The root is
  `os.tmpdir()` (so it follows `TMPDIR`); when that path has a dot-prefixed
  element, REA falls back to `/tmp`, because Ghidra aborts on project paths
  with such an element (**Source**: `GhidraSessionRoot.ts`). The Ghidra child is
  given `HOME`, `TMPDIR`, `XDG_CACHE_HOME`, `XDG_CONFIG_HOME` and
  `XDG_DATA_HOME` pointing at private directories under it, and
  `-Duser.home` / `-Djava.io.tmpdir` to match (**Source**: `GhidraLauncher.ts`).
  For the image this means a writable temp directory **without a dot-prefixed
  path element** (for example `/tmp`, or `/work/tmp` but not `/work/.tmp`) is
  required, and Ghidra's own user directories need not be placed under `/work`
  as D9 assumes. With a read-only root filesystem and a `/tmp` mount, Ghidra works
  unchanged (section 11.5; **Ran**).
- **Tool outputs** go where the caller points. Tools that export or extract take
  a path, for example `decompile_all` ("Write every function's pseudocode into a
  directory and return a manifest"), `extract_artifact` and `export_web_scripts`
  ("into an absent directory"). 24 of the 255 tool names contain
  export/extract/write/save/capture/evidence, and 7 of those are read-only
  `inspect_*` / `compare_*` tools, so at most 17 are candidates for writing
  (**Ran**: tool list; **Docs**: CLI help). With only `/work` writable, a call
  that targets another path will fail.
  Which tools accept which paths, and whether any are confined to a root, was
  not audited: **UNVERIFIED**.
- **Read-only inputs**: REA's docs say it never writes to an APK it analyzes
  (**Docs**). Ghidra's import of a binary from a read-only `/samples` works (section
  11.5; **Ran**). `REA_GHIDRA_PROJECT_PATH` and
  `REA_GHIDRA_CHECKPOINT_DIR` exist (**Source**, by name); their semantics were
  not examined.

### 2.7 Limits that touch the relay

From REA's limit inventory (**Docs**, `docs/design/rea-limit-inventory.md`):

- `REA_MCP_MAX_RESPONSE_BYTES` defaults to 10 MiB ("Stdio receive buffer and the
  paired client buffer"), so a single tool result can be that large. The relay
  (task 3.11) must not impose a smaller per-message limit.
- Startup budgets: `REA_MCP_INITIALIZE_BUDGET_MS` 15000, `REA_MCP_FIRST_CATALOG_BUDGET_MS`
  20000, `REA_MCP_TOOLS_LIST_BUDGET_MS` 5000. Observed `initialize` took about 0.3 s
  (**Ran**).

### 2.8 Ghidra checkpoints (`REA_GHIDRA_CHECKPOINT_DIR`)

Investigated as the way to keep analysis alive beyond one MCP session. Apart
from the source and docs, REA's real `GhidraCheckpoint` class from the published
package was driven from separate processes with 1 MiB fake packed programs;
Ghidra itself was not available, so nothing below involved a real Ghidra
(**Ran**, module only). Section 11.6 repeats the main behaviours with a real Ghidra.

**What it is.** An opt-in cache of a binary's Ghidra analysis.

- It is a startup setting: an absolute POSIX path in the environment of the REA
  process (**Source**: `src/config/environment.ts`). It cannot be changed at
  runtime; REA must restart (**Docs**).
- Layout (**Ran**): `<root>/<key>/`, where `<key>` is a SHA-256 over the target
  binary's SHA-256 and the analysis-profile digest (**Source**). The directory
  (mode `700`) holds `current.json` (mode `600`; manifest with `version`,
  `target_sha256`, `base_profile_digest` and `source` = `{file, sha256, kind}`) and
  `program-<uuid>.gzf`, the packed Ghidra Program. Publishing copies the blob,
  hashes and syncs it, then atomically renames the manifest into place; the
  superseded blob is removed afterwards (**Source**).
- The profile digest is built from the target's format and architecture, the
  import mode, versioned analysis-semantics tags, and loader and language facts
  (**Source**: `GhidraAnalysisProfile.ts`), with the Ghidra version included
  (**Docs**). No heap or timeout setting was among the parameters read; this was
  not traced exhaustively.
- Identical bytes at another path reuse the same checkpoint (**Docs**).
- Restoring imports the packed Program into a private temporary project with
  `-noanalysis`, bringing back auto-analysis, names, comments and types
  (**Docs**). It does **not** restore REA's own investigation state (evidence,
  snapshots), and the working project stays ephemeral (**Docs**).

**When it is saved** (**Source**, **Docs**; not run with Ghidra).

- Completed first analysis is saved at once.
- Later metadata edits are saved on normal close: the `close_binary` tool, which
  REA advertises (**Ran**: tool list), or REA's shutdown on `SIGINT`, `SIGTERM` or
  stdin end/close (`processShutdown.ts`, `shutdown.ts`), which runs the full
  cleanup including the checkpoint publish and lease release. No time bound on
  that cleanup was found.
- Cancellation, a crash or a kill recovers only the last saved state. Save cost
  grows with Program size (**Docs**).

**Observed behaviour** (**Ran**, module only):

| Scenario | Observation |
|---|---|
| Publish, then a new process opens the same binary and profile | Restored blob checksum matches; acquired in about 10 ms |
| Same binary, second live session | Fails at once (about 9 ms): "another REA session owns this checkpoint (run …, process …); close that session before retrying". It does not wait. |
| Different binary, or different profile, while the first is held | Acquires normally, in its own directory |
| Holder killed with `SIGKILL` | Its lease socket is left behind; the next session recovers it and acquires |
| Holder closes normally | Lease socket removed |
| One byte of the blob flipped | Error "the packed Program checksum differs from its manifest"; **no** fallback to a fresh import |
| Manifest deleted | Silently treated as no checkpoint; the orphaned blob stays |
| Key directory set to mode `755` | Refused: "must be a private directory owned by this user"; not repaired |

**Constraints** (**Source**, not run with Ghidra):

- **Lease location.** The lease is a Unix socket at
  `/tmp/rea-ghidra-checkpoint-leases-<uid>/<hash>.sock`. The `/tmp` is hard-coded
  and ignores `TMPDIR`. It lives for the whole session. Leases are therefore
  invisible between containers, so one checkpoint root must serve only one
  container.
- **All-or-nothing per REA process.** With the variable set, opening a target
  that is not a stock ELF, PE or Mach-O import on Linux/macOS (pinned-language
  or special-loader profiles, raw and DOS images, and so on) is a configuration
  error, not a fallback to an ephemeral session. It cannot be combined with
  `REA_GHIDRA_PROJECT_PATH`, `REA_GHIDRA_SEED_FILE`, `REA_GHIDRA_NATIVEAOT_JAR`,
  `REA_GHIDRA_LANGUAGE_ID` or `REA_GHIDRA_DISABLED_ANALYZERS`.
- **Keyed by binary, not by conversation.** Any later session opening the same
  bytes gets the saved names, comments and types. REA reports such results as
  restored state, not fresh discovery (**Docs**).
- **No retention policy.** Nothing prunes other keys; only the superseded blob
  inside a key is removed. A change of Ghidra version changes the profile
  identity (**Docs**), leaving old keys orphaned. An interrupted publish can leave
  unreferenced staging files (an inference from the code; not tested).
- **Cancellation.** Cancelling an active Ghidra request discards that session's
  unsaved annotations (**Source**: provider limitation text). The gateway forwards
  client cancellations, so a cancel can drop edits made since the last save.

## 3. Consequences for the OpenSpec change

None of the findings above blocks the change, but several contradict or refine
what `proposal.md` and `design.md` assume. **These edits have since been
applied** to the proposal, design, specs and tasks of the change; the list is
kept as the record of why they were made.

1. **`proposal.md`, "Why"**: it says REA's documentation describes no network
   mode. REA 6.9.0 has `rea mcp --http` (section 1.5). The gateway is still
   needed, but the sentence is stale.
2. **`design.md` D10 (heap)**: replace the three candidates with the one that
   works: map `GHIDRA_MAX_HEAP` to `GHIDRA_HEADLESS_MAXMEM` in each REA child's
   environment (2.4). `JAVA_TOOL_OPTIONS` is blanked by REA and an `analyzeHeadless`
   edit is overridden.
3. **`design.md` D9 (image)**:
   - The JDK must be a full JDK that provides `javac`, not a JRE (2.2).
   - The Node 24 base must be 24.22.1 or newer (2.1).
   - Ghidra's per-session state goes under `TMPDIR` or `/tmp`, so the image
     needs a writable temp directory with no dot-prefixed path element; placing
     `HOME` and Ghidra user directories under `/work` is not what REA does (2.6).
4. **`design.md` D8 and task 3.11 (spawning REA)**: spawn `process.execPath` with
   the resolved `scripts/rea.mjs` and the single argument `mcp`, with no shell and
   no `npx` (1.2). `PATH` and `HOME` are enough to initialize and list tools
   (**Ran**). For Ghidra analysis the child also needs `GHIDRA_INSTALL_DIR` and a
   JDK via `JAVA_HOME` or `PATH`, and may be given `TMPDIR`,
   `GHIDRA_HEADLESS_MAXMEM` and `REA_GHIDRA_STARTUP_TIMEOUT_MS` (**Source**; not
   run, as Ghidra was unavailable). The `REA_MCP_API_KEY*` variables must be absent.
5. **`specs/mcp-http-gateway`, "Analysis-engine settings passthrough"**: the
   "Heap setting applied" scenario is achievable as written, but the spec is
   silent on the value's format. An invalid heap value makes Java fail to start
   (2.4) and an invalid startup timeout fails only on use (2.5), so consider
   stating that `GHIDRA_MAX_HEAP` must be a JVM heap size and is validated at
   gateway startup under the existing "unparsable value" rule.
6. **`design.md` "Unverified assumptions"**: update the list as in section 4.
7. **`specs/session-management`, "One REA process per MCP session"**: it says each
   child starts with `/work` as its working directory. Per decision 5.1 this
   becomes a per-session directory, `/work/sessions/<session-id>`. Add scenarios
   that the directory exists and is the child's working directory, and that two
   sessions have different ones.
8. **`specs/mcp-http-gateway`, "Analysis-engine settings passthrough"**: add that
   `REA_GHIDRA_CHECKPOINT_DIR`, when set, is passed to every child unchanged, with
   no default (decision 5.2). The child-environment allowlist in item 4 must keep
   excluding the five settings that cannot be combined with it (2.8).
9. **`design.md` D6 and `specs/session-management`, "Reliable child termination"**:
   with checkpointing enabled, end a session by closing the child's stdin first
   and allow a longer grace than D6's 5 s before escalating to `SIGTERM` and then
   `SIGKILL` (decision 5.4). D6's statement that the unRAID template needs no
   custom stop timeout holds only while checkpointing is off.
10. **Configuration surface**: `.env.example` (task 1.2), the unRAID template
    (tasks 5.3 and 5.4, and the `unraid-template` spec's "seven advanced
    variables") and the template's defaults check gain `REA_GHIDRA_CHECKPOINT_DIR`,
    default unset. No new mount is needed, since `/work` is already writable.

## 4. Unverified assumptions and open questions

### 4.1 Resolved by task 2.x

| Assumption in the change design | Outcome |
|---|---|
| REA can be started as a standalone stdio MCP server, and with what command | Yes: `node <package-root>/scripts/rea.mjs mcp` (**Ran**) |
| How REA locates Ghidra | `GHIDRA_INSTALL_DIR`, then a launcher on `PATH` (**Source**; **Ran** for the unset case) |
| Which mechanism sets Ghidra's maximum heap | `GHIDRA_HEADLESS_MAXMEM`, then `GHIDRA_MAXMEM`, then `2G` (**Source**) |
| `REA_GHIDRA_STARTUP_TIMEOUT_MS` is read from the environment | Yes (**Ran**), default 330000 ms |
| REA supports Node 24 | Only from 24.22.1 (**Ran**: admission check); actual behaviour on Node 24 is still **UNVERIFIED** |

### 4.2 Still UNVERIFIED

This is the original list, annotated as items were closed; the numbers are cited elsewhere, so it is kept.
Section 13 is the current state.

Each item names the task that should close it.

1. That the SHA-256 recorded in section 8 equals the one published in Ghidra's
   release notes for 12.1.4. **Resolved 2026-11-14**: it does (section 8.2; **Ran**).
2. That the native decompiler in the official Linux x86_64 archive runs under uid
   99 in the image. The archive ships it (section 8; **Ran**); running it is
   task 4.6. **Resolved 2026-11-14**: it ran as uid 99 and produced correct
   pseudocode (sections 11.3, 11.5).
3. That the Temurin 21.0.13+9 JDK, which bookworm needs because it packages no
   JDK 21, runs on the image's Debian userland with REA and Ghidra. It was
   verified by hash and contents but not executed (section 9.3; tasks 4.3, 4.6).
   Also that `dumpcap` carries no file capabilities and `tshark -r` works under
   `--cap-drop=ALL` (section 9.4; task 4.6). **Partly resolved 2026-11-14**: the JDK
   runs in the image (`java` and `javac` report 21.0.13), `dumpcap` has no file
   capabilities, and `tshark -r` works as uid 99 under `--cap-drop=ALL` (section 11.1).
   Ghidra and REA also run on that JDK (sections 11.3, 11.5): **resolved**.
4. REA's Ghidra-backed analysis on Node 24 (task 4.6). Its stdio server was run on
   Node 24.22.3 in CI (section 2.1). The base tag resolves to Node 24.22.3, read
   from a tag name rather than by running `node` in the image (section 9.2).
   **Partly resolved 2026-11-14**: `node --version` in the image reports v24.22.3
   (section 11.1), and REA's Ghidra-backed analysis ran on it for all 22 samples
   (section 11.5): **resolved**.
5. That the Ghidra JVM reports the expected maximum heap when
   `GHIDRA_HEADLESS_MAXMEM` is set (4.4). **Resolved 2026-11-14**: it does, for four
   settings (section 11.3; **Ran**).
6. REA and Ghidra with a read-only `/samples`, a read-only root filesystem and a
   non-root uid, including the temp-directory behaviour in 2.6 (4.6). **Resolved
   2026-11-14**: all work, with `/tmp` and `/work` the only writable places (section 11.5).
7. What a tool call returns when its analysis engine is missing (4.6, 8.3).
   **Resolved 2026-11-14** for Rizin: a normal result with `isError` set and a
   structured `capability_unavailable` error that names the missing executable and
   a remedy. JADX was not exercised on an APK (section 11.5).
8. REA's stdio behaviour when stdin closes or `SIGTERM` arrives **while a request
   is in flight**. Only the idle case was observed (exit `0` on EOF). In HTTP mode,
   `SIGTERM` exited `143` (3.13, 3.14). **Resolved 2026-11-14**: with a Ghidra
   analysis in flight, a closed stdin made REA cancel the call, stop Ghidra and
   exit `0` within about 0.6 s, and `docker stop` ended the container with exit
   `0` in 0.84 s (section 11.5).
9. Which REA tools write to which paths, and whether any are confined to a root (8.3).
   Still open; one tool was checked: `decompile_all` wrote into `/work` (section 11.5).
10. That the SDK's streamable HTTP transport permits SSE comment frames and
    forced-SSE responses (3.6).
11. Whether the Community Apps scanner finds a template at `unraid/rea-mcp.xml`
    (the starter layout uses `templates/`), whether it accepts the hardening flags
    in `ExtraParams` and a bare `Tools:` category, and what icon size it expects.
    None is stated in the rules read in section 10; the submission flow's Validate
    and Scan answers them (5.1; **maintainer check**).
12. That the Claude custom-connector UI accepts a static request header, and the
    exact Cloudflare tunnel idle timeout (7.3, 8.3).
13. Restoring a checkpoint with a real Ghidra: that it is fast, and that names,
    comments and types survive. Upstream documents a verification script
    (`verify:ghidra:checkpoints`); it was not run (4.6, 8.3). **Resolved 2026-11-14**
    for the samples: restore took 8.8 s against 43.5 s for the first analysis of the
    largest one, and names and comments survived (section 11.6). The upstream script
    was still not run.
14. How long REA takes to publish a checkpoint on close for a large Program,
    compared with the termination grace period (4.6). **Resolved 2026-11-14** for the
    largest sample (a 3.8 MB blob): 1.1 s on `close_binary`, and REA exited 0.96 s
    after its stdin closed. A truly large Program was not available (section 11.6).
15. That, with checkpointing on, a non-stock target fails to open with Ghidra
    instead of falling back to an ephemeral session (**Source** only; 4.6).
    **Resolved 2026-11-14**: it fails, with the reason in the error (section 11.6).
16. That a conversation reconnecting on the same binary is blocked by the lease of
    its own idle child until that child is reaped or closed. An inference from the
    lease behaviour and the idle reaping (3.13, 8.3). **Resolved 2026-11-14**: a second
    live session on the same bytes failed at once until the first called `close_binary`
    (section 11.6). Whether a real client reconnects that way is still item 18.
17. Whether unRAID's "New Permissions" tool, or its FUSE-backed user shares, leave
    the checkpoint directories at mode `700` owned by uid 99 (5.1, 8.3). **Partly
    resolved 2026-11-14**: on `/mnt/user/appdata` (shfs, FUSE) REA created them at `700`
    owned by 99:100 and everything worked (section 11.6). The "New Permissions" tool was
    not run, by instruction, so whether it resets them stays **UNVERIFIED**.
18. Whether Claude Code and the claude.ai connector send `DELETE /mcp` or call
    `close_binary` when a conversation ends, and whether each conversation gets its
    own MCP session (8.3).
19. Whether REA's Ghidra bridge endpoint is a Unix socket whose path length (the
    kernel limit is about 108 bytes) rules out placing `TMPDIR` under a long
    per-session directory name (4.6). Not examined: `TMPDIR` stayed unset (section 5.1).

### 4.3 Open questions

The seven in the change's `design.md` stand. The discovery adds:

1. **Gateway transport to the child.** REA's own HTTP mode makes proxying to a
   per-session `rea mcp --http` child possible in addition to the stdio relay of
   D1/D2. The stdio relay remains the default; task 2.4 decides.
2. **Ghidra pin.** 12.1.4 with JDK 21 is the combination REA verifies; newer 12.x
   releases are admitted with an "unverified build" limitation, and 12.2
   reportedly needs JDK 25. Should the image pin the verified pair? Decided in
   task 4.1: yes (section 8).
3. **Retention of `/work/sessions/<id>`.** Delete a session's directory when the
   session ends, or keep it? Tool outputs written there (for example
   `decompile_all`) would otherwise vanish with the session. Proposed: keep, and
   leave cleanup to the operator at first.
4. **Termination grace.** A fixed constant, or a setting? Decided for now:
   constants (5 s, and 30 s with checkpointing). The remaining question, how the
   unRAID template gets a Docker stop timeout of at least 40 s when checkpointing
   is on, is answered by task 5.1: it cannot. unRAID applies one host-wide setting,
   so the operator must raise it (section 10.3).
5. **Checkpoint retention.** Operator cleanup only, documented, or a later
   janitor that removes keys unused for a period?
6. **Base distribution** (task 4.2). The spec fixes Debian bookworm, which packages
   no JDK 21, so the JDK comes from a hash-verified Temurin tarball (section 9.3).
   Debian 13 (trixie) packages JDK 21 (section 9.5), which would let the image take
   the JDK from apt with Debian's security updates, but it changes the
   `container-image` spec. **Decided 2026-11-14 (section 5.5): keep bookworm and the
   tarball.**

## 5. Decisions taken since discovery

Taken by the maintainer, in conversation, on 2026-11-13. They are recorded here
and are reflected in the OpenSpec proposal, design, specs and tasks (section 3).

### 5.1 Per-session working directory

Each REA child starts with `/work/sessions/<session-id>` as its working
directory, created by the gateway before the child is spawned. This keeps
sessions' outputs tidy and apart. It is **not** a security boundary: every child
runs as the same uid, shares `/work` and `/samples`, and tools can still be given
absolute paths. `TMPDIR` stays at its default for now (see 4.2, item 19).

### 5.2 One shared checkpoint root, off by default

When the operator sets `REA_GHIDRA_CHECKPOINT_DIR` (recommended value
`/work/checkpoints`), the gateway passes it unchanged to every child, so all
sessions share one root. Unset is the default and keeps today's ephemeral
behaviour. Consequences accepted with this choice (details in 2.8):

- Names, comments and types saved in one conversation appear in any later
  conversation that opens the same binary. With no security boundary required,
  this is acceptable and is the point of a shared cache.
- Only one live session can hold a given binary at a time. A second session on
  the same binary fails at once with "another REA session owns this checkpoint".
- With the setting on, targets that are not stock ELF, PE or Mach-O imports fail
  to open with Ghidra, so it is meant for deployments that analyze such targets.
  The five incompatible settings listed in 2.8 are not forwarded to children.
- Nothing prunes the directory (open question 5), and one root must not be shared
  between containers.

A per-workspace namespace was considered and not chosen. It would need a stable
name supplied by the client, and whether the claude.ai connector can supply one
is **UNVERIFIED**. It remains a possible later extension.

### 5.3 Guidance to carry into the user documentation

- Tell agents to call `close_binary` when they finish with a binary. It saves
  edits and releases the lease, which avoids the self-lock in 4.2, item 16.
- Keep checkpoints on persistent storage, separate from `/samples`.
- When enabling checkpoints, do not set `REA_GHIDRA_PROJECT_PATH`,
  `REA_GHIDRA_SEED_FILE`, `REA_GHIDRA_NATIVEAOT_JAR`, `REA_GHIDRA_LANGUAGE_ID` or
  `REA_GHIDRA_DISABLED_ANALYZERS`.

### 5.4 Session termination when checkpointing is on

End a session by closing the child's stdin, which REA treats as a shutdown request
and answers with its full cleanup, including saving edits (per the source and
docs; not run with Ghidra). Wait longer than D6's
5 s before escalating to `SIGTERM` and then `SIGKILL`. Gateway shutdown as a whole
must still fit inside the container's stop timeout, so the longer grace needs a
matching stop timeout in the template (open question 4). A killed child never
corrupts a checkpoint, but loses edits made since the last save (2.8).

### 5.5 Decisions of 2026-11-14

Answered by the maintainer when the image work began. They close open questions 1, 5, 6
and 7 below and the change's `design.md` open questions 1, 5, 7 and 11.

- **JDK source: a Temurin tarball on bookworm.** The image keeps its `node:24-bookworm-slim`
  base and takes the JDK from the hash-verified Temurin 21.0.13+9 archive of section 9.3,
  fetched in its own build stage. Debian 13 and copying from an `eclipse-temurin` image were
  not chosen. The one spec edit this needs is in the `secret-hygiene` capability: the
  scenario "Build fetches only pinned tooling" now lists the JDK archive. Nothing updates the
  JDK automatically; a security update means bumping the version, URL and hash by hand.
- **Community Apps: not submitting.** The template is installed from a private template URL
  (or by copying the XML to the server), so no `ca_profile.xml` is added. This closes task
  5.5. The Community Apps items in section 10.5 (template path, `ExtraParams`, the bare
  `Tools:` category, icon size, the two-factor policy) stay **UNVERIFIED** and unneeded; if
  the decision changes, add `ca_profile.xml` (section 10.4) and run Validate and Scan.
- **GHCR package: public.** A template can then pull without registry credentials. Nothing is
  created or published yet; the package and its first publication still need the
  maintainer's go-ahead at that time (task 6.4).
- **Licence: GPL-3.0-only stays**, as in `package.json` and `LICENSE`.

## 6. Gateway implementation choice (task 2.4)

**Decision: build the custom gateway** (D1 and D2 of the change design): a
transport-level relay on the MCP SDK, with one stdio REA child per session. None
of the alternatives meets the three criteria as shipped, and they leave most of
the other requirements for us to write anyway.

### 6.1 What was evaluated, and how

- **`supergateway` 4.2.2** (MIT) and **`mcp-proxy` 6.10.0** (MIT, TypeScript).
  Both were read from their published npm tarballs, because GitHub is not
  reachable from the discovery environment. They were **not run** (**Source**).
- **A per-session `rea mcp --http` child**, from the probes in section 1.5
  (**Ran**) and REA's own spec (**Source**).
- The Python package also called `mcp-proxy` was not evaluated: the image has no
  Python runtime, and adding one is a cost the other options do not carry.

### 6.2 Against the three criteria

| Criterion | `supergateway` 4.2.2 | `mcp-proxy` 6.10.0 | Per-session `rea mcp --http` |
|---|---|---|---|
| **Header-key auth** before any MCP handling | Yes. `--apiKey` / `--apiKeyFile`, `X-API-Key` or `Authorization: Bearer`, several keys at once, SHA-256 digest compared with `timingSafeEqual` against every key, `401`, refuses to start with an empty key. No minimum key length. | Partly. One key (`--apiKey`, `X-API-Key`), and the compare returns early when lengths differ before `timingSafeEqual`. A custom `authenticate` callback exists, but only in the library API. | None. Any request is served; an arbitrary `x-api-key` is ignored (**Ran**). |
| **One child per MCP session** | Yes, with `--outputTransport streamableHttp --stateful`: a child per session, ended with it, and `--sessionTimeout` for idle sessions. | **No in the CLI**: one upstream child "serves every session". The library's per-session `createServer` could do it, which means writing the gateway ourselves on top of its HTTP layer. | Possible, because we would spawn each child, but each one is then an unauthenticated loopback HTTP server. |
| **SSE keep-alive** (comment about every 15 s) | **No.** Only TCP keep-alive (65 s) and MCP `ping` requests whose interval follows `--sessionTimeout`, clamped between 5 s and 300 s. | **No.** TCP keep-alive and a resumability event store; no comment frames found. | Not tested. Only `initialize` and `tools/list` were run in HTTP mode, so long calls were not observed. |

### 6.3 Requirements neither package covers

Each of these would be ours to write whichever package we started from:

- A 32-character minimum key length, failed-auth rate limiting (`429`), and the
  `Host` allowlist.
- `/healthz` returning exactly `{"status":"ok"}` with `404` elsewhere.
  `supergateway`'s health endpoints return plain `ok`. `mcp-proxy` serves `/ping`
  and the legacy `/sse` and `/messages` routes, and enables CORS by default.
- The `MAX_SESSIONS` cap with `503` and `Retry-After`.
- A per-session working directory.
- **Spawning REA safely.** `supergateway` starts children with `shell: true` and
  the gateway's whole environment, and `mcp-proxy` passes `process.env` through.
  Either would hand `REA_MCP_API_KEY*` to every child, which the `api-key-auth`
  spec forbids. We need no shell and an allowlisted environment (D8).
- **Termination.** `supergateway` signals the child's process group with
  `SIGTERM` and `SIGKILL` after a fixed 5 s, with no stdin-EOF step and no longer
  grace for checkpointing. `mcp-proxy` has no group kill.

### 6.4 Why not proxy to per-session `rea mcp --http` children

It would replace the stdio relay with an HTTP reverse proxy and add problems the
relay does not have:

- **Cross-talk.** Every child listens on loopback without authentication, so one
  session's REA (or anything else in the container) can reach another's. Stdio
  pipes are private to the parent.
- **REA's own gates.** It validates `Host` and `Origin` on loopback binds, so the
  gateway must rewrite them; it must also allocate ports and parse the
  announcement line from stderr.
- **Keep-alives.** Comment frames would have to be injected into a proxied
  stream, which is the same work as in the relay but with a hand-written proxy
  around it.
- **Stability.** REA keeps stdio as its stable surface: registrations,
  `rea mcp doctor` and `server.json` stay stdio, while HTTP mode is opt-in and
  newer (**Source**, section 1.5).

### 6.5 What is borrowed, and caveats

- Borrowed as ideas, not code: `supergateway`'s digest-then-`timingSafeEqual`
  over every key (the same as D4), and its per-session child in its own process
  group.
- The evidence is the source of these two versions only. A later release of
  either may differ, and nothing here was exercised.
- What the SDK transports permit (SSE comment frames, forced-SSE responses, which
  SDK package to pin) is settled in tasks 3.1 and 3.6, not here.

## 7. MCP SDK transport spike (task 3.6)

Design D7 planned to write SSE keep-alive comments ourselves and, if the SDK
transport hid the response object, to wrap it. The SDK was read and then driven
with `@modelcontextprotocol/sdk` 1.32.2 (**Source**, **Ran**: `test/sdk-streamable-http.test.ts`):

| Question | Result |
|---|---|
| Does a POST get an SSE response? | Yes. `enableJsonResponse` defaults to off, and the response is `text/event-stream` with an `Mcp-Session-Id` header (**Ran**). |
| Can comment frames be written to the stream? | The transport does it itself: `: keepalive` every `keepAliveMs` while a request is open, on POST streams as well as the standalone GET stream. A 550 ms request at `keepAliveMs: 100` showed at least three, all before the result (**Ran**). No wrapper is needed. |
| What is the default interval? | `DEFAULT_SSE_KEEP_ALIVE_MS` is 15000, the interval the spec asks for. A test asserts it so an SDK change is noticed (**Ran**). |
| Where does a notification go? | Onto the request's stream only if sent with `relatedRequestId`. Without it, it belongs to the standalone GET stream, and is dropped when no client has opened one (**Ran**). A response is routed by its own id. |

Consequences:

- The gateway sets `keepAliveMs` (15 s) on each transport and does no keep-alive
  writing of its own. Task 3.15 shrinks to configuration, a scaled-time test, and
  forwarding.
- The relay must map each request's `_meta.progressToken` to its JSON-RPC id and
  send REA's progress notifications with that id. Notifications that carry no
  token (logging, list-changed) go without one, to the standalone stream.
- The SDK's own Host check (`allowedHosts`) compares the exact header, port
  included, and case-sensitively. The spec wants a case-insensitive check that
  ignores the port, so the gateway does its own (task 3.7) and leaves the SDK's off.
- The SDK's `StdioClientTransport` supplies its own default environment and runs
  its own shutdown sequence. The spec needs an exact environment, a process-group
  kill and a configurable stdin-EOF grace, so task 3.11 spawns the child itself and
  reuses only the SDK's framing helpers (`ReadBuffer`, `serializeMessage`).

## 8. Ghidra release pin (task 4.1)

**Decision: pin Ghidra 12.1.4 with JDK 21.** It is the release REA 6.9.0 verifies
against (section 2.3), so REA records no "unverified build" limitation, and JDK 21
is the lowest JDK Ghidra itself declares for it.

Gathered on 2026-11-14.

| Item | Value |
|---|---|
| Release | Ghidra 12.1.4, `PUBLIC` build of 2026-09-21 |
| Tag | `Ghidra_12.1.4_build`, commit `8b6bbb857accdfa20dc5b2f5dea471178c2e9fbc` (**Ran**: `git ls-remote --tags`) |
| Archive | `ghidra_12.1.4_PUBLIC_20260921.zip`, 569,649,598 bytes |
| `GHIDRA_URL` | `https://github.com/NationalSecurityAgency/ghidra/releases/download/Ghidra_12.1.4_build/ghidra_12.1.4_PUBLIC_20260921.zip` |
| `GHIDRA_SHA256` | `ddac49f903da9d5bac833e5cc79395098b9c33cfd3279be5f31bd00387d2d4db` |
| `GHIDRA_VERSION` | `12.1.4` |
| JDK | 21 or newer; Ghidra declares no maximum |

### 8.1 Sources

- **JDK range (Ghidra's own declaration).** `Ghidra/application.properties` at the
  tag (**Source**) and inside the release archive (**Ran**, `unzip -p`) both say
  `application.java.min=21`, `application.java.max=` (empty) and
  `application.java.compiler=21`.
- **README and release notes.** The README at the tag says "Install JDK 21 64-bit"
  and links Eclipse Temurin (`adoptium.net`) as its JDK source (**Source**).
  `ChangeHistory.md` at the tag opens with "Ghidra 12.1.4 Change History
  (September 2026)" and contains no change to the JDK requirement; the statement
  that Ghidra requires JDK 21 comes from an earlier release's entry (**Source**).
- **Archive contents** (**Ran**): `unzip -t` reports no errors. The top-level
  directory is `ghidra_12.1.4_PUBLIC/`, so the image build must move it to
  `/opt/ghidra`, because `GHIDRA_INSTALL_DIR` must be the directory that holds
  `support/analyzeHeadless`. `support/analyzeHeadless` is present. The native
  decompiler `Ghidra/Features/Decompiler/os/linux_x86_64/decompile` is present, as
  is the Windows one; there is no ARM64 build, which agrees with the image being
  amd64-only. The embedded `application.revision.ghidra` equals the tag's commit.
- **The filename.** It contains the build date and is not listed anywhere readable
  from the build environment. It was found by requesting the release-download URL
  for each date from 2026-09-05 to 2026-09-30: only `20260921` answered (a `302`
  redirect to GitHub's release-asset host), and the archive's own
  `application.build.date.short` is `20260921`.

To reproduce:

```bash
git ls-remote --tags https://github.com/NationalSecurityAgency/ghidra Ghidra_12.1.4_build
mkdir ghidra-probe && cd ghidra-probe
curl -sSL -o ghidra.zip "<GHIDRA_URL from the table>"
sha256sum ghidra.zip
unzip -p ghidra.zip ghidra_12.1.4_PUBLIC/Ghidra/application.properties
unzip -Z1 ghidra.zip | grep 'Decompiler/os/linux_x86_64/decompile$'
```

### 8.2 What is still UNVERIFIED

- **The SHA-256 against Ghidra's published value: resolved on 2026-11-14.** When it
  was pinned, the hash was computed from one HTTPS download and the release page
  could not be read. From the maintainer's host the GitHub API answers
  (`GET /repos/NationalSecurityAgency/ghidra/releases/tags/Ghidra_12.1.4_build`,
  **Ran**), and three values were compared programmatically: the SHA-256 line in that
  release's notes, the `digest` of the asset `ghidra_12.1.4_PUBLIC_20260921.zip` (569,649,598
  bytes, the size recorded above), and `GHIDRA_SHA256` in the table above. **All three are
  equal.** The image build also downloads the archive afresh and checks it against the pin
  (section 11.1). The maintainer may still wish to compare the release notes by eye.
- **That the decompiler and headless analyzer run** under uid 99 with the chosen
  JDK in the image (task 4.6).
- **Ghidra 12.2 and JDK 25** (section 2.3) were not examined; the pin does not
  depend on them.

## 9. Image packages and base (task 4.2)

Gathered on 2026-11-14. The Debian package indexes (`Packages.xz`, amd64) were
downloaded from `deb.debian.org` and `security.debian.org` and parsed (**Ran**),
against Debian 12.15 (`bookworm`, suite `oldstable`, `Release` dated 2026-07-11).
The pockets read were `main`, `bookworm-updates`, `bookworm-backports` and
`bookworm-security`.

### 9.1 What bookworm packages

| Needed | Found | Result |
|---|---|---|
| `binutils` (`objdump`) | 2.40-2 (`main`) | Available |
| `procps` (`ps`) | 2:4.0.2-3 (`main`) | Available |
| `tini` | 0.19.0-1+b3 (`main`) | Available |
| `tshark` | 4.0.17-0+deb12u3 (`main` and `bookworm-security`) | Available, 4.x |
| Full JDK 21 | **None in any pocket.** Only `openjdk-17-{jdk,jdk-headless,jre-headless}`: 17.0.19+10 in `main`, 17.0.21+9 in `bookworm-security` | **Not available**, so the fallback in 9.3 is needed |
| `rizin` | **None in any pocket** | **Not available**; omitted from the image (the spec asks for it only when installable from the distribution) |

`bookworm-updates` and `bookworm-backports` held none of the packages looked for.
JDK 17 is below the minimum of 21 that Ghidra 12.1.4 declares (section 8), so it
cannot serve.

### 9.2 Base image

`node:24-bookworm-slim` was resolved through the Docker Hub API (**Ran**):

| Item | Value (2026-11-14) |
|---|---|
| Digest of the tag | `sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54` (tag updated 2026-11-11) |
| Other tags with the same digest | `24.22.3-bookworm-slim`, `24.22-bookworm-slim`, `krypton-bookworm-slim` |
| Platforms | `linux/amd64`, `linux/arm64`, `linux/ppc64le` |

So the tag is Node **24.22.3**, which is at or above REA's floor of 24.22.1
(section 2.1). The version comes from the tag name that shares the digest, not
from running `node --version` in the image; the image build and smoke test
(tasks 4.3, 4.7) are the first runs of it. On 2026-11-14 `docker buildx imagetools
inspect node:24-bookworm-slim` still gave the digest above, and `node --version` in the
built image reported v24.22.3 (section 11.1). The tag moves, so task 4.3 should
reference the base by this digest as well as the tag for reproducible builds
(`design.md`, Risks: "consider digest pinning"). A pinned digest goes stale and
needs a Dependabot `docker` entry, which `.github/dependabot.yml` does not have yet.

### 9.3 JDK fallback: Eclipse Temurin 21

The fallback `design.md` D9 anticipated. Temurin's own API and the checksum file
published next to the asset give the same SHA-256, and the archive was downloaded
and hashed again here (**Ran**), giving the same value a third time.

| Item | Value |
|---|---|
| Release | Temurin `jdk-21.0.13+9` (21.0.13+9-LTS), HotSpot, linux x64, image type `jdk` |
| Archive | `OpenJDK21U-jdk_x64_linux_hotspot_21.0.13_9.tar.gz`, 207,858,352 bytes |
| URL | `https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.13%2B9/OpenJDK21U-jdk_x64_linux_hotspot_21.0.13_9.tar.gz` |
| SHA-256 | `d7f5d5cf865a2902b70ff549b97586a7d3f234e016f041ab447ea740c7d66d1c` |
| Sources | `https://api.adoptium.net/v3/assets/latest/21/hotspot?architecture=x64&image_type=jdk&os=linux&vendor=eclipse` (`checksum` field), and the `.sha256.txt` file beside the asset |
| Contents (**Ran**, `tar -t`) | Top-level directory `jdk-21.0.13+9/`; contains `bin/java` and `bin/javac` |

**Proposal for task 4.3** (the maintainer may prefer another form): fetch and verify
this archive in its own build stage with `sha256sum -c`, exactly as for Ghidra,
and copy the extracted directory into the runtime stage as `/opt/jdk` with
`JAVA_HOME` pointing at it. The gateway already passes `JAVA_HOME` to the REA
child when set (design D8), and REA reads it (section 2.2; whether Ghidra's own
launcher does was not checked here). This
needs no extra apt repository or signing key and no dependence on an
`eclipse-temurin` image tag. Its cost is that nothing updates the JDK
automatically: its security updates need a manual bump of the version and hash.
The two other options in D9 were not examined: the Adoptium apt repository (its
host was not reachable) and copying from an official `eclipse-temurin` image
(whether a Debian-based tag exists was not checked).

The archive was **not executed** when it was pinned. Task 4.3 then ran it in the image
(section 11.1): `java -version` reports `Temurin-21.0.13+9` and `javac -version` reports
21.0.13, so it runs on bookworm's glibc. Whether Ghidra and REA run on it is task 4.6. The
image must keep the upstream licence notices (D12): the archive ships `NOTICE` and a `legal/`
directory, and the image carries both (section 11.1).

### 9.4 `tshark` and `libcap2-bin` (corrects design D9)

`design.md` D9 said `libcap2-bin` was not expected to be needed. In bookworm,
`wireshark-common`, on which `tshark` depends, has an unconditional
`Depends: libcap2-bin` (**Ran**: full `Depends` field), so it is installed with
`tshark`. `wireshark-common` only recommends `wireshark | tshark`, and `tshark`
itself does not depend on `libcap2-bin`. In the built image `/usr/bin/dumpcap` is
`-rwxr-xr-x root root`, `getcap /usr/bin/dumpcap` prints nothing, and `tshark -r` works as
uid 99 under `--cap-drop=ALL` (section 11.1; **Ran** 2026-11-14).

### 9.5 Alternative: a Debian 13 base

Not a change to the spec, which fixes bookworm; recorded as input to open question
6 in section 4.3. The same indexes for Debian 13.7 (`trixie`, suite `stable`,
`Release` dated 2026-09-12):

| Package | trixie `main` |
|---|---|
| `openjdk-21-jdk` (also `-headless`) | 21.0.12.1+1-1~deb13u1 (`openjdk-25-jdk` 25.0.3+9-2~deb13u1 is also there) |
| `tshark` | 4.4.18-0+deb13u1 |
| `procps` | 2:4.0.4-9 |
| `binutils` | 2.44-3 |
| `tini` | 0.19.0-3+b8 |
| `rizin` | none |

`node:24-trixie-slim` exists on Docker Hub (**Ran**). A trixie base would give a
distribution-maintained JDK 21 and drop the tarball pin. It was not tried: how REA,
Ghidra and `tshark` 4.4 behave on it is **UNVERIFIED**, and it changes the
`container-image` spec's base requirement and tasks 4.2 and 4.3.

### 9.6 What is still UNVERIFIED

- Nothing. The JDK, Ghidra and REA run together on Node 24.22.3 in the image, and
  `dumpcap` has no file capabilities (sections 11.1, 11.3 and 11.5).

## 10. unRAID and Community Apps rules (task 5.1)

Gathered on 2026-11-14. **Source** means read in the page or file named; nothing
here was run on an unRAID host.

### 10.1 Sources

| Source | Used for |
|---|---|
| [Community Applications](https://docs.unraid.net/community-applications/) (unRAID docs) | How CA works; maintenance expectations; names the submission portal as "the source of truth for submission requirements, repository XML guidance, supported fields" |
| [Managing and customizing containers](https://docs.unraid.net/unraid-os/using-unraid-to/run-docker-containers/managing-and-customizing-containers/) (unRAID docs) | Container management and the advanced view |
| [CA Application Policies](https://forums.unraid.net/topic/87144-ca-application-policies/) (a locked forum thread, redirecting to a slug ending `-privacy-policy`) | Moderation rules |
| Submission docs at `https://ca.unraid.net/submit/help`, and its `/repository-xml`, `/repository-info-xml`, `/xml-field-reference` and `/builders` pages | Minimum template and `ca_profile.xml` rules; the public field catalog |
| [`unraid/unraid-community-apps-starter`](https://github.com/unraid/unraid-community-apps-starter) at `01398ff8bd728ce92dd9595e33d8577299e0e971` | A complete example template, profile and layout |
| [`unraid/webgui`](https://github.com/unraid/webgui) at `99e39027fbd50cf8c3768da0464bdd8de754a7f7`: `emhttp/plugins/dynamix.docker.manager/` (`include/CreateDocker.php`, `include/Helpers.php`, `include/DockerClient.php`, `DockerSettings.page`, `default.cfg`) and `emhttp/languages/en_US/helptext.txt` | How unRAID reads a template and stops a container |
| [Docker Engine API v1.47](https://docs.docker.com/reference/api/engine/version/v1.47.yaml), operation `ContainerStop` | The meaning of the stop `t` parameter |

The forum's "Docker Template XML Schema" thread, which the CA docs point to, was
not read: its address was not found in the pages fetched. What it would cover
(attribute names, display values) was taken from the starter repository and the
`webgui` source instead.

### 10.2 Template rules that apply to `unraid/rea-mcp.xml`

- **Root and elements.** The root is `<Container version="2">`. The starter template
  uses `Name`, `Repository`, `Registry`, `Network`, `Shell`, `Privileged`, `Icon`,
  `WebUI`, `Overview`, `Support`, `Project`, `TemplateURL`, `Category` and `Config`
  entries, and says "Either Support or Project is REQUIRED" (the spec asks for
  both). CA's public field catalog marks only `Name` and `Repository` as minimum;
  `Category`, `Icon`, `Overview`, `Project`, `Support` and `TemplateURL` as
  recommended; and `ExtraParams`, `Network`, `Privileged`, `Registry`, `Shell`,
  `WebUI`, `Config`, `License` and `ReadMe` as advanced, that is optional.
- **`<Config>` attributes.** `Name`, `Target`, `Default`, `Mode`, `Description`,
  `Type`, `Display`, `Required` and `Mask` (starter; the same set is what the
  unRAID editor reads and writes). `Type` is `Port`, `Path` or `Variable` (and
  `Device`). `Mode` is `tcp` or `udp` for a port and, for a path, one of `rw`,
  `rw,slave`, `rw,shared`, `ro`, `ro,slave` or `ro,shared`, so `ro` on `/samples`
  is valid. `Mask` is the editor's "Password Mask" option, which it branches on
  when it equals `"true"`.
- **Advanced display.** `Display="advanced"`. The values the editor handles are
  `always`, `always-hide`, `advanced` and `advanced-hide`; `advanced` entries are
  placed in a separate advanced section of the form, and the starter uses
  `Display="advanced"` for its PUID and PGID variables.
- **Icon.** `<Icon>` is recommended and the starter's example URLs end in `.png`;
  unRAID downloads the URL and stores it as `<container>-icon.png`. CA's policy
  forbids animated icons and asks that icons and descriptions be in good taste.
  **No pixel size is stated** in any source read. The starter repository's own
  icon is an SVG with a 256 by 256 view box, and the submission flow rejects the
  placeholder if it is not replaced.
- **`TemplateURL`** is "the canonical raw template URL used for identity and
  review" and in the starter "the raw GitHub URL for that exact XML file".
- **`WebUI`** is optional (advanced). The starter sets one; nothing requires it,
  so the spec's "no `WebUI`" for an API-only container is allowed.
- **`ExtraParams`** is advanced, and the catalog warns that CA's parser "security
  checks may rewrite or reject unsafe values". Whether
  `--cap-drop=ALL --security-opt=no-new-privileges:true` passes is not stated.
- **`Category`** takes the `Parent:Sub` form; the starter and the format page
  show `Tools:System` and `Tools:Utilities`, and the starter suggests the
  Application Categorizer plugin for valid values. Whether the spec's bare
  `Tools:` is accepted is not stated.
- **Optional extras in the starter** that fit this project: `License`, `ReadMe`,
  `Changes`, `Requires`. `MinVer` and `MaxVer` are left out because nothing has
  been tested on any unRAID version.

### 10.3 Host settings that affect the container (Settings, then Docker)

- **Docker Stop Timeout.** `DOCKER_TIMEOUT`, default `10`, described as "The time
  in seconds to allow a container to gracefully stop before forcing it to stop".
  When unRAID stops a container from its UI it calls
  `POST /containers/<id>/stop?t=<DOCKER_TIMEOUT>` (`DockerClient.php`,
  `stopContainer`). **No template element or attribute sets a stop timeout**: the
  CA field catalog has none. Docker's API describes `t` as the "number of seconds
  to wait before killing the container" and does not say whether an explicit `t`
  overrides a container's own `--stop-timeout`, so a `--stop-timeout` in
  `ExtraParams` is not relied on (**UNVERIFIED**).
- **Consequence for design D6.** With checkpointing off, the gateway shuts down
  within the default 10 s. With checkpointing on, its budget is up to 40 s, so the
  operator must raise Docker Stop Timeout to at least 40. Otherwise Docker kills
  the container after 10 s, REA may be killed while saving, and edits since its last
  save are lost (a kill does not corrupt a checkpoint; section 2.8). This is a
  **manual step on the unRAID host**, to be stated in the README (task 7.2) and in
  the checkpoint variable's description (task 5.3). Whether array stop and server
  shutdown use the same value was not read, because that script is not in the
  `webgui` repository (**UNVERIFIED**).
- **Docker PID Limit.** `DOCKER_PID_LIMIT`, shipped empty, whose help text says it
  limits "the number of PIDs that a docker can use. The default is 2048. Set to zero
  for unlimited PIDs (not recommended)". Threads count against a PID limit, so
  several Ghidra JVMs and their decompiler processes, up to `MAX_SESSIONS` of them,
  could approach it. That is an inference and is **UNVERIFIED**; it belongs in the
  memory and sizing guidance (tasks 7.2, 7.4) and in the end-to-end check (8.3). One
  measurement exists (section 11.5): two concurrent Ghidra sessions on a 770 KB binary
  took the container to 197 PIDs, from 10 idle, so the default `MAX_SESSIONS` of 4 is
  an extrapolated 380 or so on that 64-CPU host, well under 2048; the count depends on
  the CPU count.

### 10.4 Community Apps submission and moderation

- **Needed to submit** (submission help): a public, active repository; an
  OSI-approved `LICENSE` at the root (the committed GPL-3.0 qualifies); a
  `ca_profile.xml`; and valid template XML whose entry has a `<Repository>`. The
  author runs Validate and Scan at `https://ca.unraid.net/submit/new` and then
  submits for review. That portal needs a sign-in, so it is a **maintainer step**.
- **`ca_profile.xml`** is **expected for a Community Apps submission and not for
  installing from a private template URL.** The file name is exact, it sits in the
  repository root, its root element is `<CommunityApplications>`, and a non-empty
  `<Profile>` is required: without it "Community Apps will block submission
  finalization". `<Icon>`, `<WebPage>` and `<Forum>` are recommended and the rest
  optional. Task 5.5 decides whether to add it, given open question 7.
- **Policies** (forum thread, locked, with a June 2025 note on submissions):
  every template needs a reasonable description; `Project` and `Support` URLs must
  not be referral or affiliate links; icons and descriptions must be in good taste
  and icons must not be animated; a maintained application must be open source;
  maintainers are expected to keep up with new unRAID releases and answer support
  requests. For GHCR images, download counts come from a Docker Hub equivalent,
  so none are shown without one.
- The same thread says "All GitHub repositories / dockerHub repositories must have
  2 Factor Authentication enabled, and an acknowledgement of this must be given".
  Whether that still applies to the current portal is **UNVERIFIED**.
- **Layout.** The starter and the builder guide put templates under `templates/`
  ("one XML file per Docker app under `templates/`"), and the profile and icon in
  the root. The spec puts this template at `unraid/rea-mcp.xml`.

### 10.5 What is still UNVERIFIED

- That the CA scanner finds a template at `unraid/rea-mcp.xml`. If it does not,
  moving it under `templates/` is a change to the `unraid-template` spec.
- That the scanner accepts the hardening flags in `ExtraParams` and a bare
  `Tools:` category.
- The icon size CA expects. The plan for task 5.2 is a 256 by 256 PNG, matching
  the starter icon's view box, which is a choice and not a guideline.
- Whether a `--stop-timeout` in `ExtraParams` is honoured, and whether array stop
  and shutdown use the host's Docker Stop Timeout.
- Whether the PID limit constrains several Ghidra sessions. Measured data are in section 11.5, and section
  10.7 shows unRAID applies `--pids-limit 2048` by default; four concurrent sessions were not run.
- Whether the two-factor requirement in the policy thread still applies.

### 10.6 The icon (task 5.2)

`unraid/icon.png` is a 256 by 256, 8-bit RGBA PNG of 6,504 bytes: a magnifying lens over a grid of "byte
cells" on a navy rounded square with transparent corners. The size is the choice recorded in 10.2, not a
documented guideline. Checked on 2026-11-14 (**Ran**): the PNG signature and every chunk CRC are valid; the
file holds only `IHDR`, `IDAT` and `IEND`, so it is one frame with no APNG animation chunks (`acTL`, `fcTL`,
`fdAT`); the decompressed pixel data has exactly the length the header implies; and the corners are
transparent while the centre is opaque. It is original: `scripts/make_icon.py` draws it from geometric shapes
(signed-distance functions, standard library only) and reproduces it byte for byte, so it contains no
third-party artwork. That it resembles no one else's mark rests on that construction and a look at the
picture; no trademark search was made. The template check of task 5.4 repeats the PNG checks in CI.

### 10.7 The template (task 5.3)

`unraid/rea-mcp.xml` follows the `unraid-template` spec: root `<Container version="2">`; `Name`, `Repository`
(`ghcr.io/eguthriewastaken/rea-mcp:latest`), `Registry`, `Shell`, `Support`, `Project`, `Overview`, `Category`
(`Tools:`), `TemplateURL` and `Icon` set; `Network` `bridge`; `Privileged` `false`; `ExtraParams`
`--security-opt=no-new-privileges:true --cap-drop=ALL`; no `WebUI`. It has 12 `<Config>` entries, each with
all nine attributes: the port, the masked empty required `REA_MCP_API_KEY`, `/samples` with `Mode="ro"` and
no default, `/work` defaulting to `/mnt/user/appdata/rea-mcp`, and the eight advanced variables with
`Display="advanced"`, whose defaults equal the gateway's (`DEFAULT_ENV` in `src/config.ts`; empty where the
gateway has none). The checkpoint variable is empty, names `/work/checkpoints`, says non-stock targets fail to
open, and tells the operator to raise the host's Docker Stop Timeout to at least 40 s (section 10.3).
`xmllint --noout` accepts it, and it holds no key and no long hex string.

**unRAID's own parser, run on this host** (**Ran**, 2026-11-14, unRAID 7.3.4): `xmlToCommand()` from the
installed `dynamix.docker.manager/include/Helpers.php` was called read-only from a PHP stub (fake time zone, host
name and network table; `$create_paths` false, so nothing was created). It builds this command from the template:

| From the template | In dockerMan's `docker create` |
|---|---|
| `Name`, `Repository`, `Network` | `--name='rea-mcp'`, `--net='bridge'`, image `'ghcr.io/eguthriewastaken/rea-mcp:latest'` |
| `ExtraParams` | `--security-opt=no-new-privileges:true --cap-drop=ALL`, appended unchanged |
| Port 8080 `tcp` | `-p '8080:8080/tcp'` |
| `/work` | `-v '/mnt/user/appdata/rea-mcp':'/work':'rw'` |
| `/samples` once the user gives a path | `-v '<path>':'/samples':'ro'`; with no path it is left out, as the user must choose one |
| The eight advanced variables | `-e` for each, an empty default being passed as an empty string |
| `Icon` | `-l net.unraid.docker.icon=<url>` |
| (not in the template) | `--pids-limit 2048`, which dockerMan adds itself from the host's `DOCKER_PID_LIMIT` (empty: 2048) |

So an unRAID-installed container is limited to 2048 PIDs by default, which section 11.5's measurement (about
94 PIDs per live Ghidra session on a 64-CPU host) leaves room for at the default of 4 sessions. The image was also
run with exactly that environment, empty strings included (`GHIDRA_MAX_HEAP=`, `ALLOWED_HOSTS=`,
`REA_GHIDRA_CHECKPOINT_DIR=` and so on): it became healthy, analysed a sample, and Ghidra ran with REA's default
`-Xmx2G`, so a blank variable behaves as unset.

Not checked: how the edit form renders the template (that `Mask` hides the key, `Display="advanced"` collapses
the eight variables, and `Required` blocks Apply). That is browser-side code in `CreateDocker.php`, and nothing
was rendered here.

### 10.8 The template check (task 5.4)

`scripts/check_template.py` (Python 3 standard library only) checks `unraid/rea-mcp.xml` against the
`unraid-template` spec and reports every violation: well-formed XML and the `Container` root; the ten metadata
elements, with the spec's fixed values (lowercase repository, `Tools:`, project, support and raw links,
`bridge`, not privileged, both hardening flags, no `WebUI`); all seven attributes on every `<Config>`; the
required entries (port, masked empty required key, `ro` samples with no default, `/work` default); the eight
advanced variables as advanced entries whose defaults equal `DEFAULT_ENV` in `src/config.ts`, which it reads
from the source so the two cannot drift; the checkpoint variable off by default and its description; no
key-like string, private key, host other than public GitHub and GHCR, or host path other than the appdata
default; and that the icon is a valid, 256 by 256, single-frame PNG.

`--self-test` copies the template, icon and `config.ts` to a scratch directory, makes one deliberate
violation, and requires the checker to reject it, 31 times (**Ran**, 2026-11-14): malformed XML, a wrong
version, a missing or empty element, an uppercase repository, a wrong category or link, `Privileged` true, a
host network, a missing `--cap-drop=ALL`, a `WebUI`, an API key with a default (a random key-shaped string made
at run time, so no literal is committed), an unmasked or optional key, a writable or defaulted `/samples`, a
changed `/work` default, a `<Config>` without `Mask`, a missing or non-advanced variable, a default changed on
either the template side or the gateway side, checkpointing on by default, a checkpoint description without
`/work/checkpoints` or without the warning, a link to another host, a user-specific host path, and an icon that
is truncated, has a bad CRC, is animated, or is missing. It also requires the unmodified template to pass and
the command to exit 1, naming the problem, on a broken copy. All 31 were rejected and the real template passes.

## 11. Image build and verification (tasks 4.3 to 4.7)

Gathered on 2026-11-14 on the maintainer's unRAID host (Docker Engine 29.8.2, BuildKit
0.33.1, cgroup v2, amd64), with Docker's built-in `default` builder and the image tagged
`rea-mcp-dev:test`. Everything is **Ran** unless it says otherwise. The sample set is the
maintainer's `rea-test-samples.zip`, kept outside the repository; its
`sha256sum -c SHA256SUMS` reported all 50 files `OK`, and none is executable.

### 11.1 The Dockerfile (task 4.3)

`docker/Dockerfile` builds five stages on one base, `node:24-bookworm-slim` pinned by
tag and digest (section 9.2): `base` (which refuses any platform but amd64), `ghidra`, `jdk`,
`build` and `runtime`. Only `runtime` ships.

```bash
docker buildx build --platform linux/amd64 -f docker/Dockerfile -t <image> .
```

| Check | Result |
|---|---|
| Build | Succeeds; about 1 min 20 s with warm base layers, 1 min 34 s the first time; the image is 1.92 GB (`docker image inspect` `.Size` 1,915,751,710) |
| Pins equal this document | Programmatic comparison of `GHIDRA_URL`, `GHIDRA_SHA256`, `GHIDRA_VERSION`, `JDK_URL`, `JDK_SHA256` and the base digest in the Dockerfile with sections 8 and 9: all equal |
| `GHIDRA_SHA256` altered (first hex digit changed, one character) | `sha256sum --check` prints `/tmp/ghidra.zip: FAILED`, the build exits `1`, and no image with that tag exists |
| `JDK_SHA256` altered the same way | `/tmp/jdk.tar.gz: FAILED`, exit `1`, no image |
| Ghidra layout | `/opt/ghidra/support/analyzeHeadless` and `.../Decompiler/os/linux_x86_64/decompile` are present and executable; `application.version=12.1.4`, `application.java.min=21`, `application.java.max=` empty |
| Runtime identity | `uid=99(rea-mcp) gid=100(users)`; `getent passwd 99` gives `rea-mcp:x:99:100::/work/home:/usr/sbin/nologin` |
| Node | `v24.22.3` (at or above REA's floor of 24.22.1) |
| JDK | `OpenJDK Runtime Environment Temurin-21.0.13+9 (build 21.0.13+9-LTS)`; `javac 21.0.13` |
| Other tools | `ps` procps-ng 4.0.2; `tshark` 4.0.17 (`4.0.17-0+deb12u3`); `objdump` 2.40; `tini`; each resolves on `PATH` |
| Build-only tools absent | `curl` and `unzip` are not on `PATH`, and `dpkg-query` knows neither |
| Environment | `HOME=/work/home`, `JAVA_HOME=/opt/jdk`, `GHIDRA_INSTALL_DIR=/opt/ghidra`, `PORT=8080`; **`TMPDIR` is unset**; `/tmp` is `drwxrwxrwt`, writable by uid 99 |
| Volumes and directories | `/samples` and `/work` declared as volumes, `WORKDIR /work`; `/work/home` and `/work/sessions` exist, mode `700`, owned `rea-mcp:users`; `/samples` refuses a write under `:ro` ("Read-only file system") |
| `dumpcap` | `-rwxr-xr-x root root`; `getcap /usr/bin/dumpcap` prints nothing |
| `rea-agents` | Installed 6.9.0, equal to the lockfile's; no `~/.claude.json`, `~/.agents` or `~/.claude` under `HOME`, so no `setup` output |
| No key in the image | `REA_MCP_API_KEY` occurs 0 times in `docker image inspect` and `docker history --no-trunc` |
| Licence notices | `/opt/ghidra/LICENSE`, `/opt/ghidra/licenses`, `/opt/ghidra/GPL/licenses`, `/opt/jdk/NOTICE`, `/opt/jdk/legal`, `/app/LICENSE` (Ghidra's archive has no `NOTICE` file) |

The first build raised BuildKit's `FromPlatformFlagConstDisallowed` lint on a constant
`--platform` in `FROM`. It was replaced by a `dpkg --print-architecture` assertion in `base`.

**The capture, opened in `tshark` for the first time** (as uid 99, `--cap-drop=ALL`,
`--security-opt=no-new-privileges:true`, `/samples` read-only; empty stderr, nothing written to
`HOME`). It matches the samples README exactly:

| README says | `tshark -r` shows |
|---|---|
| 34 packets: 6 UDP, 26 TCP, 2 ICMP | 34 frames; `udp` 6, `tcp` 26, `icmp` 2 |
| DNS `www.example.test` and `api.example.test` answered; `missing.example.test` NXDOMAIN | Frames 1 to 6; the `dns.flags.rcode == 3` filter matches frame 6, "No such name" |
| `GET /index.html`, `POST /api/v1/items` (JSON) | Frames 10 and 20; the POST is dissected as `HTTP/JSON` |
| One ClientHello with SNI `api.example.test` | `203.0.113.30  api.example.test` (the `tls.handshake.type == 1` filter) |
| One ping, id `0x0042` | Frames 33 and 34, `id=0x0042, seq=1/256`, ttl 64 and 56 |

### 11.2 The entrypoint check (task 4.5)

`docker/entrypoint.sh` is the image's entrypoint, behind `tini`. It probes `/work` and `/tmp`
by creating a file in each (which also catches read-only mounts and ACLs that `test -w`
can miss), creates `/work/home` and `/work/sessions` at mode `700`, probes those two as well
(they may already exist from a run as another user), and then `exec`s the command, so Node is
tini's direct child. It reports a problem as one JSON object on stdout in the gateway's log
shape (`time`, `level`, `message`, `path`, `reason`) and exits `1`. Every row below ran under
`--cap-drop=ALL --security-opt=no-new-privileges:true` as uid 99.

| Scenario | Result |
|---|---|
| `/work` is a bind mount owned by root, mode 755 | Error naming `/work` and the remedy (make the host directory writable by uid 99 and gid 100, "on unRAID, nobody:users"); exit `1`; nothing is left in the mount |
| `/work` is writable but `/work/home` exists, owned by root, mode 700 | Error naming `/work/home`; exit `1` |
| `--read-only` root filesystem with no `/tmp` mount | Error naming `/tmp`; exit `1` |
| `/work` is a bind mount owned by 99:100, with a throwaway key | `home` and `sessions` appear in it, mode `700`, uid 99, gid 100; the gateway logs `listening`; the container is `healthy` 2 s after start with `--health-interval=2s`; `GET /healthz` gives `200` and `{"status":"ok"}`; `docker stop` exits `0` in 0.18 s |
| No key, and a 31-character key | The gateway's refusal reaches the log through the entrypoint (`cannot start without a usable API key`, naming `REA_MCP_API_KEY`); exit `1`; the throwaway key does not occur in the output |

The gateway also checks `/work/sessions` itself (`src/main.ts`), so the same mistake would be
caught there if the entrypoint were bypassed; the entrypoint reports it first, and for `/tmp`
as well, which the gateway does not check.

### 11.3 The heap mapping (task 4.4)

A real Ghidra was driven through the gateway: an MCP client opened
`/samples/binaries/ghidra-class/switch` (read-only mount), called `binary_overview` and
`list_procedures`, and then, with the session still open, `docker exec` read the Ghidra JVM's
command line from `/proc/<pid>/cmdline` and its effective limits from `jcmd <pid> VM.flags`.
The container ran as uid 99 with `--cap-drop=ALL --security-opt=no-new-privileges:true`. Each row
is a separate container.

| `GHIDRA_MAX_HEAP` | `GHIDRA_HEADLESS_MAXMEM` in the REA child | JVM command line | `jcmd` `MaxHeapSize` |
|---|---|---|---|
| unset | absent | `-Xmx2G` (REA's own default) | 2,147,483,648 (2048 MiB) |
| `1536M` | `1536M` | `-Xmx1536M` | 1,610,612,736 (1536 MiB) |
| `3g` | `3g` | `-Xmx3g` | 3,221,225,472 (3072 MiB) |
| `768m` | `768m` | `-Xmx768m` | 805,306,368 (768 MiB) |

Each value equals the heap requested, so the mapping of design D10 works as written. Also seen:

- The JVM environment holds `JAVA_TOOL_OPTIONS=` set to nothing, which is REA blanking it
  (section 2.4), so that variable could not have carried the heap setting.
- The JVM is a child of the REA process, runs as uid 99, gid 100, and `jcmd VM.version` reports
  `OpenJDK 64-Bit Server VM version 21.0.13+9-LTS`, the Temurin JDK of section 9.3. REA adds
  `-Xshare:off -XX:ParallelGCThreads=2 -XX:CICompilerCount=2`.
- Ghidra's per-session home and temporary directory are under `/tmp`:
  `-Duser.home=/tmp/rea-ghidra-<random>/home` and `-Djava.io.tmpdir=/tmp/rea-ghidra-<random>/tmp`,
  as section 2.6 said.
- `open_binary` does not start Ghidra (it answered in 0.1 to 2 s); the first Ghidra-backed call
  did, and `binary_overview` took about 11 s for this 16 KB binary.
- The REA child's working directory was `/work/sessions/<session-id>`, and its environment held only
  `GHIDRA_HEADLESS_MAXMEM`, `GHIDRA_INSTALL_DIR`, `HOME`, `JAVA_HOME` and `PATH` of the variables
  checked (design D8, D13).

### 11.4 The hardened run (task 4.6)

The container was started as the template will start it: `--cap-drop=ALL
--security-opt=no-new-privileges:true`, `/samples` mounted `:ro`, `/work` a bind mount owned by
99:100, no `--privileged`, bridge networking, the image's own `HEALTHCHECK`. A memory limit of 6 GiB
and a PID limit of 1024 were added as test safeguards.

| Check | Result |
|---|---|
| Identity | `.Config.User` is `99:100`; `id` gives `uid=99(rea-mcp) gid=100(users)` |
| Privileges | The gateway process has empty permitted, effective and bounding capability sets (`CapPrm`, `CapEff`, `CapBnd` all zero) and `NoNewPrivs: 1`; `Privileged=false` |
| Tools resolve as uid 99 | `java` 21.0.13, `javac` 21.0.13, `ps` procps-ng 4.0.2, `tshark` 4.0.17, `objdump` 2.40 |
| `/samples` and `/work` | A write to `/samples` fails with "Read-only file system"; a write to `/work` works |
| Headless Ghidra's own launcher | `support/analyzeHeadless /tmp/ghproj rea-dev -import /samples/binaries/ghidra-class/switch -deleteProject` ran as uid 99 under the Temurin JDK in 9.0 s: "Analysis succeeded", "Save succeeded", "Import succeeded"; no Java version error. It wrote Ghidra's user settings to `/work/home/.config/ghidra/ghidra_12.1.4_PUBLIC` |
| Health | `healthy` at the first poll, more than 10 s after start, with the image's unmodified `HEALTHCHECK` (30 s interval, 15 s start period) |
| `/healthz` | `200` with `{"status":"ok"}` and no key; no `Server` or `X-Powered-By` header |
| Authenticated `initialize` | Right key: `200` with an `Mcp-Session-Id`, REA's `initialize` result. Wrong key and no key: `401`, empty body, no session; the log line is `authentication failed` with the source address only |
| `docker stop` | Exit `0` in 0.2 s when idle; 0.84 s with a Ghidra analysis in flight (section 11.5) |

### 11.5 Real Ghidra-backed paths, shutdown and sizing (task 4.6)

**Analysis through REA.** All 22 sample binaries were opened and analysed through the gateway in one
session, in the hardened container with `/samples` read-only: 22 succeeded, none failed. Each took 9 to
13 s (JVM start dominates; `open_binary` itself does not start Ghidra), except the 770 KB static
`stack-buffer-overflow-amd64`: 41 s and 1078 function rows. Function rows ranged from 1
(`exotic_instructions-amd64`) and 2 (`dynamic_jump-amd64`) to 86 for the C++ `animals`, and 1078 for the
static binary; the four shared objects and the stripped `sharedReturn` also worked. For `switch`, `analyze_function` returned
pseudocode for `main` that matches its source (a jump through a ten-entry table, with the usage
message), so Ghidra's native decompiler, `demangler_gnu_v2_41` and the JVM all ran as uid 99.

**Other REA tools that reach the image's engines.**

| Tool | Result |
|---|---|
| `inspect_with_objdump` | Real GNU objdump output: `file format elf64-x86-64`, `<main>:`, the `strtoul` call |
| `inspect_pcap_capture` (tshark) | 34 packets, with `www.example.test`, `api.example.test`, `missing.example.test`, `/index.html`, `/api/v1/items`; TShark 4.0.17; `inspect_packet_capture` and `inspect_packet_fields` also answered |
| `decompile_all` | Wrote 20 files under `/work/out-decompile` from the read-only `/samples`: directories `700`, files `600`, owner 99:100 |
| `execute_rizin_command` (no Rizin in the image) | A normal result with `isError`, `code: capability_unavailable`, "Could not launch the selected rizin executable "rizin" (ENOENT)" and a remedy ("make that command available on PATH") |
| `capture_process_scenario` | **Runs an arbitrary command inside the container**, as uid 99: `id` printed `uid=99(rea-mcp) gid=100(users)`, a `sh -c` wrote to `/tmp` and was refused on `/samples` ("Read-only file system"), and a Node one-liner made an outbound HTTPS request to a public host that returned 200. REA describes the tool as "not a sandbox". The gateway relays tools unfiltered (design D2), so a key holder has command execution in the container, write access to `/work` and `/tmp`, and the network; `docs/SECURITY.md` says so |
| `search_android_classes` (no JADX) | `capability_unavailable`, "Target ... is elf; provide one standalone APK". It was given an ELF, so it does not show what an APK does without JADX |

**A read-only root filesystem works.** With `--read-only --tmpfs /tmp` (Docker's default options,
`rw,noexec,nosuid,nodev`, 64 MB) the same analysis gave the same pseudocode and nothing was logged. The
writable places Ghidra needs are `/tmp` (its per-session home and temporary directory, `/tmp/rea-ghidra-<random>`,
which REA removes after `close_binary` and after a bare `DELETE`; only the JVM's small `hsperfdata_<user>`
stays) and `/work`. `noexec` on `/tmp` is harmless. The size matters: one live session
on the 770 KB binary used about 27.5 MiB of `/tmp`, so two used 55 of the 64 MB. A read-only deployment
should give `/tmp` a larger tmpfs.

**Sizing, measured** with two concurrent sessions on the 770 KB binary and Ghidra's default 2G heap
(each took about 45 s): the container's cgroup `pids.current` peaked at 197 (10 with the gateway idle),
about 94 per session, and its memory at about 2.5 GiB. The PID count follows the host's CPU count (64 here).
Four concurrent sessions were not run.

**Shutdown while a request is in flight** (a `binary_overview` of the 770 KB binary, 6 s in):

| Ending | Result |
|---|---|
| Client `DELETE /mcp` | `200` in 5 ms. REA cancelled the call (`status: "error"` in its log), stopped Ghidra and exited `0` 0.64 s after the gateway closed its stdin; no `SIGTERM` or `SIGKILL`; no Java or decompiler process left |
| `docker stop` (default 10 s) | 0.84 s; container exit code `0`; REA exited `0` about 0.6 s after the `SIGTERM` reached the gateway |
| The request that was in flight | In both cases it ended as HTTP `200` with an empty body: no JSON-RPC result and no JSON-RPC error. The spec fixes only the child-exit case ("fail its in-flight requests with an error"), so this was recorded as an observation. **Fixed on 2026-11-15** (section 16): a request in flight when its session ends now gets a JSON-RPC error (`-32603`, "Session ended") |

### 11.6 Checkpoints with a real Ghidra (task 4.6; section 2.8)

With `REA_GHIDRA_CHECKPOINT_DIR=/work/checkpoints`, in the hardened container, on `switch` unless
noted (all **Ran**):

| Scenario | Result |
|---|---|
| First analysis | Saved at once. REA created `/work/checkpoints` itself (mode `700`, owner 99:100), with `<key>/current.json` (`600`) and `program-<uuid>.gzf` (38 KB, `644`) in a `700` key directory. The lease is a socket under `/tmp/rea-ghidra-checkpoint-leases-<uid>/` |
| `annotate_native_function`, then `close_binary` | The blob was replaced by a new one: saved on normal close |
| A later session on the same bytes | The renamed function and its comment came back, reported as restored state. First Ghidra call 8.5 s, against 10.9 s for the first analysis: little gain on a 16 KB binary, where JVM start dominates |
| The same on the 770 KB static binary | First analysis 43.5 s; restore plus first Ghidra call 8.8 s; blob 3.79 MB |
| A second live session on the same bytes | Fails in about 100 ms: `configuration_invalid`, "REA_GHIDRA_CHECKPOINT_DIR: another REA session owns this checkpoint (run ..., process ...); close that session before retrying." The holder was an idle session. After its `close_binary` (no `DELETE` needed) the second session worked |
| A non-stock target (`raw-binary`) with checkpointing on | `open_binary` succeeds, then the first analysis call fails with `provider_unavailable`; the rejection reason is "Ghidra checkpoints currently support stock ELF/PE/Mach-O imports on Linux/macOS" (code `version_unresolved`), also shown by `binary_session` with `detail: complete`. It does not fall back. Without checkpointing the same target analysed normally (10 s) |
| `DELETE` without `close_binary`, after an unsaved edit | The edit was saved by REA's shutdown. On the large sample, REA published a 3.8 MB Program and exited 0.96 s after its stdin closed, against a 30 s grace |
| `close_binary` publish on the large sample | 1.1 s |
| `docker stop` (default 10 s) after an unsaved edit | 0.4 s, exit `0`; in a new container on the same `/work` the edit was there |
| `SIGKILL` of the whole container after an unsaved edit | The checkpoint was intact and restored in a new container; the last good save was present and the unsaved edit was lost |
| `/work` on `/mnt/user/appdata` (unRAID user share, shfs, FUSE) | Everything above behaved the same; directories stayed `700`, owner 99:100 |

`annotate_native_function` replaces a function's comment, so a later edit overwrites an earlier
one on the same function.

### 11.7 The smoke-test script (task 4.7)

`scripts/smoke_test.sh <image>` starts the image as the template will (`--cap-drop=ALL`,
`--security-opt=no-new-privileges:true`, `/samples` read-only, a random host port on `127.0.0.1`) with a
throwaway key, and asserts that: the container becomes `healthy`; its user is `99:100`; `GET /healthz`
returns `200` and exactly `{"status":"ok"}` without a key; `initialize` with the key returns `200`, an
`Mcp-Session-Id` and REA's result; the same request with no key and with a wrong key returns `401` and
starts no session; `DELETE /mcp` ends the session; the key does not occur in the container's log; and
`docker stop` exits `0` in under 10 s. It then starts two more containers, with no key and with a
31-character key, and asserts each exits non-zero, names `REA_MCP_API_KEY`, and does not print the short
key. It does not run Ghidra (sections 11.3 to 11.6 did). The key lives in the script's environment only:
`docker` takes it from the environment, `curl` reads the header from stdin (`-H @-`) and `grep` reads it from a
process substitution, so it is never on a command line, in a file or in the output. Containers are named
with `REA_MCP_SMOKE_PREFIX` and always removed, with their anonymous volumes.

| Run | Result |
|---|---|
| The built image | All checks pass, exit `0`, 4.6 s; no container is left |
| A variant with `USER root` | Fails with "the container stopped before it became healthy" and the log: the entrypoint reports that `/work` is not writable by uid 0. A root process with all capabilities dropped has no `CAP_DAC_OVERRIDE`, so it cannot write to a directory owned by another uid |
| A variant that starts as uid 1000 (`/work` made world-writable so it does start) | Healthy, then fails with "the image's user is '1000:100', not 99:100" |
| An image name that does not exist | `docker run` fails and the script exits `125` |

Two defects of the first draft were found and fixed by these runs: the port lookup ran before the
container was known to be running, so an early exit gave no message; and `docker logs | grep -q` under
`pipefail` could report a match as no match, so the key-in-the-log check reads the log into a variable first.

### 11.8 What was not checked

- **APK decompilation.** There is no APK sample and the image has no JADX by design, so only the
  non-APK error of section 11.5 was seen.
- **A truly large Program.** The largest sample is 770 KB (a 3.8 MB checkpoint blob). Publish time and
  restore time for a program of tens of megabytes are unknown, as is whether 30 s is enough for one.
- **Four concurrent sessions** (the default `MAX_SESSIONS`), memory at an 8G heap, and unRAID's own
  Docker PID limit setting (the test used `--pids-limit=1024`).
- **unRAID's "New Permissions" tool**, whether array stop and server shutdown use the Docker Stop
  Timeout setting, and whether a `--stop-timeout` in `ExtraParams` is honoured (section 10.5).
- **Clients and the tunnel**: Claude Code, the claude.ai connector, `DELETE /mcp` on exit, and a call
  longer than the roughly 100 s idle limit (task 8.3 and `docs/CLOUDFLARE.md`).
- **Which of REA's roughly 250 tools write where.** Only `decompile_all` was checked.
- **`TMPDIR` under a long per-session path** (item 19 of section 4.2).
- **The upstream `verify:ghidra:checkpoints` script.**

## 12. CI jobs written ahead of their first run (tasks 6.2 to 6.4)

Written on 2026-11-14 and checked locally first; a workflow is only verified by a pull request run, which the
maintainer then allowed (pull request 5; results below the table). Task 6.3 is ticked on that run, and 6.2 on the
seeded-violation run of 2026-11-15 (below); 6.4 stays unticked. What was checked locally, and what remained:

| Piece | Checked here (**Ran**) | Still to do |
|---|---|---|
| `template` job in `ci.yml` | `scripts/check_template.py` passes and its self-test rejects all 31 seeded violations (section 10.8) | Done: passed on pull requests and on `main`, and failed on a seeded violation (below) |
| `image` job in `ci.yml` | The same Docker commands ran on this host: the build (section 11.1), `scripts/check_hash_pins.sh` (an altered Ghidra or JDK hash fails the build on the checksum and leaves no image) and `scripts/smoke_test.sh` (section 11.7) | Done: passed on a runner (below) |
| `gate` | Parsed with the `yaml` package: every job other than `gate` is in its `needs` | Seeing it fail when a job fails |
| `.github/workflows/publish.yml` | Parses; triggers on a push to `main`, a `vX.Y.Z` tag and manually, with a guard so a fork does not publish; empty top-level `permissions`, job-level `contents: read` and `packages: write`; no third-party action. `scripts/image_tags.sh` gives `latest` and `sha-<12>` for `main`, `X.Y.Z` and `sha-<12>` for a `vX.Y.Z` tag, and refuses every other ref and malformed input. It was written disabled and **enabled on 2026-11-15 with the maintainer's approval** | Done: its first run succeeded (below), so task 6.4 is ticked |
| `.github/workflows/release.yml` (task 6.5, optional; added 2026-11-15) | Parses; triggers only on a `vX.Y.Z` tag; empty top-level `permissions`, job-level `contents: write`; no checkout and no third-party action; a guard against forks. Its script, run locally with `gh` stubbed, builds `gh release create vX.Y.Z --verify-tag --generate-notes` with a line naming `ghcr.io/eguthriewastaken/rea-mcp:X.Y.Z`, and refuses `v1.2`, `v1.2.3-rc1` and a branch name; the flags were checked against `gh release create --help` | Done: it ran on `v0.1.0` (below), so task 6.5 is ticked |

Design choices: the new jobs use the runner's own `docker` and `python3` and so add no third-party action
to pin and no binary to hash-verify. The template job does not call `xmllint` (design D11 mentions it): the
checker parses the XML strictly and its self-test includes a malformed file, so the runner needs no extra
package. The tag policy in `scripts/image_tags.sh` is a proposal for open question 4 of the change's
`design.md`. The package was expected to start private and need making public (decision of section 5.5); it came
out public (below).

Also run once on a clean copy of this branch in a Node 24.22.3 container (as root): `npm run lint` and
`npm run typecheck` clean, and `npm test` gave 358 passed and 1 skipped. The skip is
`it.skipIf(process.getuid?.() === 0)` in `test/keys.test.ts`, which a root run skips.

### First run on GitHub (pull request 5, run 43664812125)

- **`image` passed on a runner in 2 min 3 s**: the build, `scripts/check_hash_pins.sh` (an altered Ghidra hash and an
  altered JDK hash each failed the build on the checksum and left no image) and all twelve `scripts/smoke_test.sh`
  checks. This is the "verify on a branch run" of task 6.3, which is therefore ticked.
- **`template` failed, and so did `gate`.** The real check passed (`template: ok`) but the self-test crashed with an
  uncaught `ValueError` on its `WebUI` mutation, which puts unRAID's `[IP]` placeholder in a URL
  (`http://[IP]:[PORT:8080]/`). Python on the runner rejects a bracketed host that is not an IP address;
  the 3.9 on the maintainer's host does not. Reproduced with Python 3.13 and fixed by parsing every URL through one helper
  that treats an unparsable URL as a violation. The checker and its 31-case self-test now pass under Python
  3.9 and 3.13 (**Ran**). A lesson for the checker: the self-test found the bug only because it exercises odd
  inputs, and only a runner with a different Python could show it.
- The other six jobs (`lint`, `typecheck`, `test`, `secrets`, `hygiene`, `openspec`) passed.
- Task 6.2 stayed unticked until `template` passed and a seeded violation had been tried on a scratch branch (next).

### Seeded violations, and the jobs passing (task 6.2, 2026-11-15)

- **Passing.** The final run of pull request 5 (run 43665105676) and the push run on `main` after the squash merge
  (run 43681029352, commit `a5a2cfa`) each passed all nine jobs, `secrets` (gitleaks over the full history) and
  `template` included.
- **Failing on purpose.** A scratch branch off `main` carried two commits: a random credential-shaped string
  (`api_key = "<64 hex digits made at run time>"`, in `scratch-seeded-credential.txt`; not a credential for anything)
  and `<Privileged>true</Privileged>` in the template. Its draft pull request (number 6, run 43681170242) gave:

  | Job | Result | Why, from the log |
  |---|---|---|
  | `secrets` | fail | gitleaks: rule `generic-api-key`, file `scratch-seeded-credential.txt`, the seed commit, value redacted, "9 commits scanned", "leaks found: 1" |
  | `template` | fail | `template: <Privileged> is 'true'; it must be 'false'` |
  | `gate` | fail | its `needs` include the two jobs above |
  | `hygiene`, `image`, `lint`, `openspec`, `test`, `typecheck` | pass | the seeds touch nothing they check, so only the two intended jobs failed |

  Before pushing, the same two violations were caught locally (gitleaks: 1 finding; the checker: the message
  above). The pull request was closed without merging and the branch deleted. GitHub keeps a closed pull request's
  head commit reachable through its `refs/pull/6/head` ref, so the seeded string remains visible there; it is
  random and worthless, and it is not in `main`, whose history a squash merge never carries it into.
- **The branch ruleset.** The repository's rulesets, read through the API, are now the single imported `main`
  ruleset. The maintainer imported it and confirmed that a direct push to `main` is rejected (task 6.0a, ticked on
  that confirmation; it was not tried here).
- **Dependabot.** Its first runs, on 2026-11-15, succeeded for both the `github_actions` and the `docker` entries.
  The `docker` run read the Dockerfile's `FROM` line, reported "Latest version is 24-bookworm-slim" and "No update
  needed for node 24-bookworm-slim", and opened no pull request, which is right because the digest pinned on
  2026-11-14 is current. Whether it proposes a new digest when the tag moves, and skips a new Node major as configured,
  cannot be seen until something changes.

### The first publish (task 6.4, 2026-11-15)

The merge of pull request 7 to `main` (commit `217c09a`) ran `publish.yml` (run 43684167112); every step succeeded:
the image references, the build, the hash-pin check, the smoke test, the login with the workflow token and the push.
Checked afterwards (**Ran**):

- **The package.** `ghcr.io/eguthriewastaken/rea-mcp`, linked to this repository, visibility **public**, with the tags `latest`
  and `sha-217c09a24a13`. A fresh package was expected to start private; it did not, and why was not looked into.
- **Anonymous access.** An anonymous registry token fetched the manifest of `:latest` (HTTP 200), and the maintainer's host
  pulled the image with an empty Docker configuration (no credentials) in 40 s.
- **The published image itself.** `scripts/smoke_test.sh ghcr.io/eguthriewastaken/rea-mcp:latest` passed all twelve checks.
  Its image id is `sha256:34902d21...`, 1,915,755,280 bytes, `linux/amd64`, user `99:100`, with the labels
  `org.opencontainers.image.source` (this repository) and `org.opencontainers.image.licenses` (`GPL-3.0-only`).
- The unRAID template's `Repository`, `ghcr.io/eguthriewastaken/rea-mcp:latest`, therefore resolves.

### The first release, `v0.1.0` (task 6.5, 2026-11-15)

The maintainer asked for a `v0.1.0` tag as a shakedown of the release pipeline before any 1.0.0, since `release.yml` and
the tag path of `publish.yml` had never run. An annotated tag `v0.1.0` was pushed on `main` at `e48a9a6`, the commit
that records the first publish, after that commit's own CI and publish runs had passed. Both workflows then succeeded
(**Ran**):

- **`release.yml`** (run 43685657862): created the GitHub Release `v0.1.0`, not a draft and not a pre-release, on `main`,
  with generated notes (the seven pull requests merged so far, a full-changelog link) and the line "Container image:
  `ghcr.io/eguthriewastaken/rea-mcp:0.1.0`". It needed only the workflow token.
- **`publish.yml` on the tag** (run 43685657834): every step passed and the image was pushed as `0.1.0` and `sha-e48a9a6620cb`.
  A tag publishes no `latest`, as designed.
- **The image.** `:0.1.0` was pulled with an empty Docker configuration (no credentials) and `scripts/smoke_test.sh` passed
  all twelve checks; the image is 1,915,755,280 bytes, `linux/amd64`, user `99:100`.
- **A finding.** `:0.1.0` (digest `sha256:7db8c5e9...`, the same as `sha-e48a9a6620cb`) and `:latest` (`sha256:f369776c...`,
  built by the run for the merge to `main`) are two builds of the same commit, so they are not byte-identical: the Dockerfile
  pins every download and the base image, but not the Debian packages apt installs. The version tag is therefore not
  "the `latest` image, named". Whether to promote the `main` build to the version tag instead of rebuilding is open
  (section 13).

## 13. What is still UNVERIFIED (current)

As of 2026-11-14. "Closed" items are in the list of section 4.2, with their evidence; this table is only what is open.
An item is **UNVERIFIED** until a primary source or a run shows it.

| Item | Why open | What would close it |
|---|---|---|
| Dependabot's `docker` entry proposing a new digest when the tag moves, and skipping a new Node major | It ran and found `node 24-bookworm-slim` current (section 12); nothing has changed since | The tag moving, or a new Node major appearing |
| `latest` and a version tag (`0.1.0`) are separate builds of the same commit, not one image under two names | Each workflow run rebuilds; the Dockerfile pins Ghidra, the JDK, the base image and `rea-agents`, but the Debian packages installed with apt are not pinned, so two builds can differ (section 12) | A maintainer decision: promote the image built for `main` to the version tag instead of rebuilding, or accept it |
| The claude.ai connector against this server, and interactive Claude Code (whether they send `DELETE /mcp`, and whether each conversation gets its own session; the rest of item 18) | Claude Code in `-p` mode was run end to end (section 14): separate sessions, no `DELETE`, no `close_binary` unless told. Anthropic's page says a connector accepts fixed request headers (**Docs**), which is not the same as trying it | The maintainer's steps in section 14 |
| A Cloudflare Tunnel in front of it: the idle and absolute limits for a stream that has started, and what happens to a call whose connection a proxy cut | Cloudflare documents a 125 s default Proxy Read Timeout for a first response (**Docs**); the rest is not documented on the pages read | The maintainer's tunnel steps in section 14, with a call longer than 125 s |
| APK decompilation | No APK sample and no JADX in the image by design | Not planned |
| Analysis and checkpoint behaviour on a truly large Program (tens of MB), and whether 30 s suffices | The largest sample is 770 KB | A larger permitted target |
| Four concurrent sessions, 8G heaps, and the effect of unRAID's own PID limit setting | Only two sessions were run, at the default heap | A load test on the host |
| unRAID: the "New Permissions" tool and checkpoint directories; whether array stop and shutdown use the Docker Stop Timeout; whether a `--stop-timeout` in `ExtraParams` is honoured | Not run, by instruction, or not read | The maintainer on the host |
| unRAID: how the edit form renders the template (mask, advanced section, Required) | Browser-side code, not rendered here | The maintainer opening it |
| Which REA tools write to which paths (item 9) | Only `decompile_all` was checked; `capture_process_scenario` writes wherever uid 99 can | An audit if it matters |
| `TMPDIR` under a long per-session path (item 19) | `TMPDIR` stays unset (section 5.1) | Only if `TMPDIR` is ever set |
| Upstream's `verify:ghidra:checkpoints` script | Not run | Optional |

Closed since the list of section 4.2 was written but not yet marked there: item 10 (the SDK's SSE comment frames
and forced-SSE responses, **Ran** in section 7) and item 12's first half (the connector accepts a fixed request
header, **Docs**, 2026-11-14: Anthropic's custom-connector help page lists "Request headers"). Item 11 and the
Community Apps rules are moot, since submission was decided against (section 5.5).

## 14. Claude Code against a running container (task 8.3)

Run on 2026-11-15 with the real client, Claude Code 2.1.319, non-interactively (`claude -p`, Haiku 5.5, built-in tools
off, `--strict-mcp-config`, `--no-session-persistence`, a spending cap; about 55 cents in all), against the image
built on this host, started hardened with `/samples` read-only. **Each `claude -p` run is one conversation.** The key
reached the client only through `${REA_CC_KEY}` expansion in its MCP configuration, and the container through its
environment: no file holds it. Everything is **Ran** unless it says otherwise. The gateway's own log, with
REA's tool-call lines at `LOG_LEVEL=debug`, is the source for what the server saw.

| Question | Result |
|---|---|
| Connect, list tools | Connected with `{"type": "http", "url": ..., "headers": {"x-api-key": "${VAR}"}}`, the shape `claude mcp add --transport http ... --header` writes: all 255 tools visible |
| The documented command | `claude mcp add --transport http --scope project rea <url> --header 'x-api-key: ${REA_CC_KEY}'` wrote exactly that shape, with the placeholder in the file and not the key. `claude mcp list` then showed the server as "Pending approval (run `claude` to approve)": a server shared through a project's `.mcp.json` needs approval, which local and user scope do not (**Docs**). The connection itself was proved through `--mcp-config` |
| One analysis | The agent opened `switch`, called `list_procedures` (11 s, Ghidra starting), `procedure_pseudo_code` and `inspect_analysis_view`, and answered correctly: 23 procedures; `main` prints a usage message unless `argc == 3`, otherwise parses two numbers and calls through `array[n % 10]` (as in section 11.5). About 5 cents |
| Do separate conversations get separate MCP sessions? | **Yes.** Every run started its own session, with its own REA and Ghidra |
| Does the client send `DELETE /mcp` on exit? | **No.** In every run the client exited without one. The session, its REA and its Ghidra stayed alive until the gateway's idle reaper ended them (`session ended ... idle`, REA exit 0). Tested with `claude -p`; interactive Claude Code was not |
| Does the agent call `close_binary`? | **Not unless told**: never in eight conversations; once in the one whose prompt said to (and then it did) |
| The session cap | With `MAX_SESSIONS=2` and two finished conversations still lingering, a third conversation's `initialize` got `503` three times and the client ended up with no `rea` tools at all. After the idle reaper ran, a new conversation worked |
| Checkpoints, reconnecting on the same binary (`REA_GHIDRA_CHECKPOINT_DIR=/work/checkpoints`, idle timeout 60 s) | K1 edited a function and left. **K2**, a new conversation seconds later on the same binary, was blocked: "another REA session owns this checkpoint ... close that session before retrying". After the reaper ended K1's session, **K3** saw K1's comment (so the reaper's close saved it), edited, and called `close_binary`; **K4** then got straight in and saw K3's comment, although K3's session was still alive |
| A conversation that goes quiet longer than the idle timeout (20 s) and carries on | The gateway ended the session. The client opened new sessions by itself (two at once, one of them unused until reaped); its next call failed with `target_unavailable` (the new REA has nothing open); the agent re-opened the binary and finished. The open binary and unsaved edits belong to the session and are lost with it |

What follows from this:

- Because the client leaves sessions behind, **a finished conversation costs a session slot, a Ghidra process (about
  1.2 GB) and, with checkpoints, the binary's lease, for `SESSION_IDLE_TIMEOUT_SEC`**, which defaulted to 900 s when this
  was run (the maintainer then chose 300 s: section 16). At `MAX_SESSIONS` 4, four conversations within that time make the
  server refuse the next one, and with checkpoints a follow-up conversation on the same binary is locked out for the same
  time. The README says so.
- Telling the agent to call `close_binary` works and is the fix for the lease. It frees Ghidra and the binary but not
  the session slot, which stays until the idle timeout.
- A shorter `SESSION_IDLE_TIMEOUT_SEC` frees slots sooner and costs the open binary of a quiet conversation (the agent
  recovered here by re-opening it). The maintainer chose a default of 300 s (section 16).

Not tested, so still open (section 13): interactive Claude Code; other models (the transport behaviour should not depend
on the model); the claude.ai connector; and a Cloudflare Tunnel.

### Steps left for the maintainer

1. **The claude.ai custom connector:** Customize, Connectors, Add custom connector, URL `https://<host>/mcp`, request
   header `x-api-key` with your key, no sign in; enable it in a conversation and run an analysis. Check whether its
   conversations behave as above (a separate session each, no `DELETE`) in `docker logs`.
2. **A Cloudflare Tunnel** (`docs/CLOUDFLARE.md`): route `<host>` to the container, set `TRUST_PROXY=true` and
   `ALLOWED_HOSTS=<host>`, check `https://<host>/healthz`, then repeat an analysis through `https://<host>/mcp`. Try one
   call that runs longer than 125 s (a large target) and note what the client sees.
3. Record each outcome here, as **Ran** or as a defect.

## 15. Review of the documents for secrets (task 7.5)

On 2026-11-14, over every tracked and new file (**Ran**): `gitleaks detect` over the full history and over the working tree
(`--no-git`), both with the repository's `.gitleaks.toml`, found no leaks. A search for `x-api-key` found only
placeholders (`<key>`), prose, or code that reads the header; the tests generate their keys at run time. The 32-or-more
character hex strings are the pinned SHA-256 values and digests of sections 8 and 9, the CI tool hashes, action and
commit identifiers; the one long base64 string is the public npm integrity value of `rea-agents` (section 1). The only
IP addresses are `127.0.0.1`, RFC 5737 documentation addresses and test fixtures; the one email-shaped string is a
reserved `.example` test value. The only host names are public GitHub, GHCR, Docker, Debian, Adoptium, Node.js,
unRAID, Cloudflare and Anthropic locations. No real host name, key or token of the maintainer appears.

## 16. Reconciling the specs with what was built (task 8.4)

`openspec validate bootstrap-rea-mcp-gateway --strict` passes. On 2026-11-14 the specs were compared with the built
image, template and scripts; every requirement of `container-image`, `unraid-template`, `secret-hygiene` and the
image-related scenarios of `session-management` and `ci-gate` was met or had its evidence above, with the differences
below (the Claude Code run of section 14 added the last). They were put to the maintainer, who answered **"all as
recommended"** on 2026-11-15. What was decided, and where it landed:

| Observation | Decision, and where it landed |
|---|---|
| The image downloads a Temurin JDK and verifies its SHA-256 like Ghidra's, but `container-image` had a requirement only for Ghidra | A requirement "Pinned, verified JDK where the base distribution has none" was added to `container-image`, with a match scenario and a mismatch scenario. Evidence: sections 11.1 and 12 (`scripts/check_hash_pins.sh`) |
| `DELETE /mcp` and `docker stop` ended a request in flight as an empty `200` (section 11.5) | A requirement "Calls still open when a session ends are answered" was added to `session-management` (a `DELETE`, a shutdown, and no second answer after REA's exit). **Gateway code changed**: `end()` in `src/sessions/manager.ts` now answers every request still waiting with `-32603`, "Session ended", through `failInFlight`, which the child-exit path shares. Four tests in `test/lifecycle.test.ts`; against the previous code the three about `DELETE` and shutdown fail (the call never gets an answer) and the fourth, which pins the existing child-exit behaviour, passes |
| The entrypoint also checks `/work/home` and `/work/sessions` (section 11.2) | A scenario for an unwritable directory under `/work` was added to "Volumes and working directory" |
| Design D11 mentions `xmllint`, which CI does not call (section 12) | D11 now says the checker parses the XML strictly |
| `unraid-template` fixes `Category` as the bare `Tools:`; Community Apps was not consulted | No change; revisit only if submission is reconsidered |
| Design open question 4, the image tags | Decided by the maintainer's approval of the implementation (task 6.4): `main` publishes `latest` and `sha-<12>`, a `vX.Y.Z` tag publishes `X.Y.Z` and `sha-<12>`, nothing else publishes. Recorded in the design's open question 4 |
| Claude Code never ends its sessions or calls `close_binary` unprompted (section 14), so finished conversations hold slots for `SESSION_IDLE_TIMEOUT_SEC` | The default was lowered from 900 s to **300 s**: the `mcp-http-gateway` spec, `DEFAULT_ENV` in `src/config.ts`, the fallback in `src/sessions/manager.ts`, the unRAID template (default, value and description), `.env.example`, the README and the config test. `scripts/check_template.py` confirms the template still equals `DEFAULT_ENV` |

The design's "Unverified assumptions" section and D6, D11 and the risk about a conversation locking itself out of its
binary were refreshed to match (they are a planning artifact, not a spec).

## 17. Acceptance checks 8.1 and 8.2

Run on 2026-11-14 on the final tree of the working branch (**Ran**).

- **8.1, secrets.** `gitleaks detect` with `.gitleaks.toml` over all 23 commits, and over the working tree with
  `--no-git`: no leaks. A grep pass for 32-or-more-character hex strings and 40-or-more-character base64-like strings in
  every tracked file (the lockfile and `LICENSE` excluded) finds only the five documented 64-character pins
  and digests (Ghidra, the JDK, the base image, gitleaks, Node) and the public npm integrity string of
  `rea-agents`; the commits of this branch add only the Ghidra, JDK and base-image values.
- **8.2, binaries and samples.** `git ls-files --eol` shows one binary, `unraid/icon.png`; no tracked path lies under
  `samples/` or `work/`; `scripts/check_hygiene.sh` passes; `git check-ignore` confirms that `samples/`, `work/`,
  `*.pcap`, `*.pcapng`, `*.gpr`, `*.rep`, `*.tns` and `.env` are ignored.
- **Tests.** As a non-root user in a Node 24.22.3 container: `npm run lint` and `npm run typecheck` clean, `npm test`
  359 passed, none skipped (the one skip of a root run is `it.skipIf(running as root)`).


## 18. File transfer and result paging: evidence (change `add-file-transfer-and-result-paging`)

Evidence for the change that adds upload and download tickets, an inbox and stored results. Run on 2026-11-15
against the published image `ghcr.io/eguthriewastaken/rea-mcp:latest` (REA 6.9.0) in a throwaway container: loopback
only, a throwaway key, `--cap-drop=ALL`, `no-new-privileges`, `/samples` an empty read-only directory, removed
afterwards. The target was a copy of the image's own `objdump` (371,264 bytes) made inside the container as
`/work/inbox/objdump-copy`.

### 18.1 Task 1.1: REA and files outside `/samples` (**Ran**)

| Check | Result |
|---|---|
| `open_binary` on `/work/inbox/objdump-copy` | Succeeded: `kind` `executable`, `format` `elf`, `architecture` `x86_64`. REA does not restrict paths to `/samples`. |
| Analysis calls on that path | `list_documents` took 36.8 s (it starts Ghidra) and returned `ok`; `list_names`, `list_procedures`, `list_segments`, `list_strings`, `binary_overview`, `binary_session` and `list_unknowns` all returned `ok` afterwards, in 0.0 to 1.4 s. |
| `structuredContent` against `content[0].text` | For all 8 tools that returned `structuredContent`, `json.loads(content[0].text)` equalled `structuredContent` exactly. Two calls with no required arguments (`list_bookmarks`, `list_architectures`) returned `isError` and had **no** `structuredContent`, only `content`. |
| Result sizes (characters of `content[0].text`) | `list_names` 1,676,773; `list_strings` 340,324; `list_procedures` 200,484; `binary_session` 34,734; `binary_overview` 8,977; `list_documents` 3,642; `list_segments` 13,448. Results this large are the normal case for an unrestricted call, not an exception. |
| Names of the gateway's four tools | None of `request_upload`, `upload_status`, `request_download`, `read_result` is among REA's 255 tools. The list is one page (no `nextCursor`). |

What this settles: design D2's assumption that `content` carries what `structuredContent` carries held for every
tool checked (8 of 255; the rest are **UNVERIFIED**, and the gateway removes `outputSchema` only so that a stub is not
rejected, not because it relies on equality for anything else). An error result has no `structuredContent`, which is
why validating clients skip errors.

### 18.2 Task 1.2: Node's request timeouts (**Ran**, Node 24.22.3)

A client sent a 10-byte body at one byte per 400 ms (about 4 s) to a plain `node:http` server whose
`connectionsCheckingInterval` was 100 ms:

| Server options | Outcome |
|---|---|
| `requestTimeout: 1000`, `headersTimeout: 800` | `408 Request Timeout`: the whole-request limit cut the slow body |
| `requestTimeout: 0`, `headersTimeout: 800` | `200 OK`: the body finished |
| `requestTimeout: 0`, `headersTimeout: 800`, headers never finished | `408 Request Timeout`: `headersTimeout` still applies |

So setting `requestTimeout` to `0` removes the 300 s default whole-request limit (a 76 MiB upload over a slow uplink
would exceed it) without removing the header limit. The gateway's own no-progress limit on the transfer routes
replaces it there.
