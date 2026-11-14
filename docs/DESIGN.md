# rea-mcp design (long form)

> **Status: in progress.** Sections are added as the tasks of the OpenSpec change
> `bootstrap-rea-mcp-gateway` are completed. The decisions that shape the specs
> live in [`openspec/changes/bootstrap-rea-mcp-gateway/design.md`](../openspec/changes/bootstrap-rea-mcp-gateway/design.md);
> this document records the evidence behind them.

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
  image's Node 24 base must resolve to 24.22.1 or newer. What the `node:24-*`
  tag currently resolves to was not checked: **UNVERIFIED** (task 4.2/4.3).
- REA was exercised on Node 22.23.4 only (**Ran**). Running it on Node 24 was
  not possible in the discovery environment, so REA's behaviour on Node 24
  beyond the admission rule is **UNVERIFIED**. The CI job on Node 24 and the
  image smoke test (tasks 6.1, 4.7) are the first runs that can confirm it.

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
  declares JDK 25 or newer, and that neither sets a maximum (**Docs**). That
  agrees with the brief, but it is REA's statement about Ghidra, not Ghidra's
  own: **UNVERIFIED** against Ghidra's release notes or its
  `application.properties` (task 4.1).
- The release URL and SHA-256 for Ghidra 12.1.4 are **UNVERIFIED** (task 4.1).
  The pin that REA verified is 12.1.4 with JDK 21; choosing it is task 4.1's job.

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
  maximum heap is **UNVERIFIED** until task 4.4 runs it.
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
  as D9 assumes. The actual behaviour with a read-only root filesystem is
  **UNVERIFIED** (task 4.6).
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
  (**Docs**). Whether Ghidra's import of a binary from a read-only `/samples`
  works is **UNVERIFIED** (task 4.6). `REA_GHIDRA_PROJECT_PATH` and
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
(**Ran**, module only).

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
what `proposal.md` and `design.md` assume. **These edits have not been made**:
they change planning artifacts, so they are listed here for the maintainer to
accept (for example through `openspec-update-change`) before the later tasks
rely on them.

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

Each item names the task that should close it.

1. Ghidra 12.1.4 download URL and SHA-256, and its declared JDK range from
   Ghidra's own release notes or `application.properties` (task 4.1).
2. That the official Linux x86_64 Ghidra archive ships the native decompiler (4.1, 4.6).
3. Debian bookworm package availability and versions for a full JDK 21, `tshark`
   4.x, `procps`, `binutils`, `tini` and `rizin`, and the Temurin fallback (4.2).
4. What the `node:24-*` base tag resolves to, and REA's behaviour on Node 24
   (4.2, 4.3, 6.1).
5. That the Ghidra JVM reports the expected maximum heap when
   `GHIDRA_HEADLESS_MAXMEM` is set (4.4).
6. REA and Ghidra with a read-only `/samples`, a read-only root filesystem and a
   non-root uid, including the temp-directory behaviour in 2.6 (4.6).
7. What a tool call returns when its analysis engine is missing (4.6, 8.3).
8. REA's stdio behaviour when stdin closes or `SIGTERM` arrives **while a request
   is in flight**. Only the idle case was observed (exit `0` on EOF). In HTTP mode,
   `SIGTERM` exited `143` (3.13, 3.14).
9. Which REA tools write to which paths, and whether any are confined to a root (8.3).
10. That the SDK's streamable HTTP transport permits SSE comment frames and
    forced-SSE responses (3.6).
11. unRAID / Community Apps template rules: attribute names, advanced display mode,
    `ca_profile.xml`, icon size (5.1).
12. That the Claude custom-connector UI accepts a static request header, and the
    exact Cloudflare tunnel idle timeout (7.3, 8.3).
13. Restoring a checkpoint with a real Ghidra: that it is fast, and that names,
    comments and types survive. Upstream documents a verification script
    (`verify:ghidra:checkpoints`); it was not run (4.6, 8.3).
14. How long REA takes to publish a checkpoint on close for a large Program,
    compared with the termination grace period (4.6).
15. That, with checkpointing on, a non-stock target fails to open with Ghidra
    instead of falling back to an ephemeral session (**Source** only; 4.6).
16. That a conversation reconnecting on the same binary is blocked by the lease of
    its own idle child until that child is reaped or closed. An inference from the
    lease behaviour and the idle reaping (3.13, 8.3).
17. Whether unRAID's "New Permissions" tool, or its FUSE-backed user shares, leave
    the checkpoint directories at mode `700` owned by uid 99 (5.1, 8.3).
18. Whether Claude Code and the claude.ai connector send `DELETE /mcp` or call
    `close_binary` when a conversation ends, and whether each conversation gets its
    own MCP session (8.3).
19. Whether REA's Ghidra bridge endpoint is a Unix socket whose path length (the
    kernel limit is about 108 bytes) rules out placing `TMPDIR` under a long
    per-session directory name (4.6).

### 4.3 Open questions

The seven in the change's `design.md` stand. The discovery adds:

1. **Gateway transport to the child.** REA's own HTTP mode makes proxying to a
   per-session `rea mcp --http` child possible in addition to the stdio relay of
   D1/D2. The stdio relay remains the default; task 2.4 decides.
2. **Ghidra pin.** 12.1.4 with JDK 21 is the combination REA verifies; newer 12.x
   releases are admitted with an "unverified build" limitation, and 12.2
   reportedly needs JDK 25. Should the image pin the verified pair? Recommended:
   yes, decided in task 4.1.
3. **Retention of `/work/sessions/<id>`.** Delete a session's directory when the
   session ends, or keep it? Tool outputs written there (for example
   `decompile_all`) would otherwise vanish with the session. Proposed: keep, and
   leave cleanup to the operator at first.
4. **Termination grace.** A fixed constant, or a setting? And how the unRAID
   template gets a Docker stop timeout that fits it when checkpointing is on
   (how a template sets one is **UNVERIFIED**, task 5.1).
5. **Checkpoint retention.** Operator cleanup only, documented, or a later
   janitor that removes keys unused for a period?

## 5. Decisions taken since discovery

Taken by the maintainer, in conversation, on 2026-11-13. They are recorded here;
the OpenSpec proposal, specs and tasks do not yet reflect them (see section 3,
items 7 to 10).

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
