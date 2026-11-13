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
