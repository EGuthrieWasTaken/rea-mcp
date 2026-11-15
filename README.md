# rea-mcp

REA + Ghidra as a remote MCP server, packaged for unRAID.

> **Status.** The gateway, the Docker image and the unRAID template are built and were
> verified on an unRAID 7.3.4 host (evidence: [`docs/DESIGN.md`](docs/DESIGN.md), section 11).
> **Publishing is enabled** (a push to `main` or a `vX.Y.Z` tag publishes `ghcr.io/eguthriewastaken/rea-mcp`), but
> the first run has not happened yet, and GitHub makes a new package private until its owner sets it public. If
> `docker pull ghcr.io/eguthriewastaken/rea-mcp:latest` does not work for you, build the image yourself (see
> [Quick start](#quick-start)). Claude Code has been run end to end against the container; the claude.ai connector
> and a Cloudflare Tunnel have not been tried.

A single Docker container that exposes [REA](https://github.com/morluto/rea) ("Reverse Engineer
Anything", npm package `rea-agents`) and its analysis engines (Ghidra, tshark, objdump) as a **remote MCP
server over streamable HTTP**, so it can be added as a custom connector in Claude and used from Claude Code.

REA is a local stdio MCP server. This project is a thin gateway that starts one REA process per MCP session
and serves it over HTTP, authenticating every request with a static API key in an `x-api-key` header.

```
Claude (connector or Claude Code) -> HTTPS (a tunnel or proxy you run; not part of this project)
  -> container:8080  gateway (API key, session cap, keep-alives)
     -> one REA process per session (stdio)
        -> Ghidra (headless), tshark, objdump
```

What it can analyze: the files in the folder you mount read-only at `/samples`. The image has Ghidra 12.1.4
(on a Temurin JDK 21), tshark 4.0 and GNU objdump, and **no JADX and no Rizin**, so APK decompilation and Rizin
commands are not available (REA answers those with a `capability_unavailable` error).

> **The API key is powerful.** A client that has it can make the container run commands (REA's
> `capture_process_scenario` tool does exactly that, as uid 99), write to `/work` and `/tmp`, and reach the
> network. `/samples` stays read-only. Treat the key like a shell password and read
> [`docs/SECURITY.md`](docs/SECURITY.md) before you expose the server.

## Quick start

You need Docker and a folder of files you are permitted to analyze. The image is `linux/amd64` only.

```bash
# Build it (no published image exists yet). Downloads Ghidra and a JDK, each checked against a pinned SHA-256.
docker build -f docker/Dockerfile -t rea-mcp:local .

# A key of at least 32 characters. Keep it: every client needs it. There is no default.
export REA_MCP_API_KEY="$(openssl rand -hex 32)"

docker run -d --name rea-mcp \
  --cap-drop=ALL --security-opt=no-new-privileges:true \
  -e REA_MCP_API_KEY -p 8080:8080 \
  -v <samples-dir>:/samples:ro \
  -v <work-dir>:/work \
  rea-mcp:local
```

- `<work-dir>` must be writable by uid 99, gid 100 (the user the container runs as). If it is not, the
  container exits at once with a one-line JSON error that names the directory.
- `curl http://localhost:8080/healthz` answers `{"status":"ok"}` without a key.
- The MCP endpoint is `http://localhost:8080/mcp`. The server speaks plain HTTP; put TLS in front of it
  before exposing it beyond your own machine ([`docs/CLOUDFLARE.md`](docs/CLOUDFLARE.md)).
- Run [`scripts/smoke_test.sh`](scripts/smoke_test.sh) `<image>` to check an image: health, identity, 401 without a
  key, refusal without a key, and a clean `docker stop`.

## Install on unRAID

The template is [`unraid/rea-mcp.xml`](unraid/rea-mcp.xml). It is not in Community Apps (that was decided
against), so install it as a user template:

1. Copy it to the flash drive under the name `my-rea-mcp.xml` (unRAID lists user templates as `my-*.xml` in
   this directory, read from its Docker manager code):
   ```bash
   curl -fsSL -o /boot/config/plugins/dockerMan/templates-user/my-rea-mcp.xml \
     https://raw.githubusercontent.com/EGuthrieWasTaken/rea-mcp/main/unraid/rea-mcp.xml
   ```
   (That URL works once this is on `main`. Until then copy the file from a clone.)
2. On the **Docker** tab choose **Add Container** and pick **rea-mcp** from the user templates.
   (unRAID's Template repositories field is an alternative; unRAID's own help text marks it deprecated.)
3. Fill in the three blanks: the **API key** (`openssl rand -hex 32`; the field is masked), the **Samples**
   folder (a dedicated folder, mounted read-only) and, if you like, the **Work directory**
   (default `/mnt/user/appdata/rea-mcp`, which must be writable by `nobody:users`).
4. **Apply.** The eight settings under "advanced" are the variables below.

The template runs the container with `--security-opt=no-new-privileges:true --cap-drop=ALL`, bridge
networking and no web UI. unRAID adds `--pids-limit 2048` itself (its Docker PID Limit setting, default 2048).
The image's `latest` tag moves; pin a version tag once releases exist.

### Two unRAID host settings that matter

Both are on the **Settings, Docker** page and apply to every container; a template cannot change them.

- **Docker Stop Timeout** (default 10 s). With checkpointing **off** the container stops in under a second.
  With checkpointing **on**, stopping a session may take up to 30 s so REA can save, and the gateway's
  shutdown budget is 40 s, so raise the Stop Timeout to **at least 40 s**. Otherwise Docker kills the
  container after 10 s and unsaved annotations may be lost (a kill never corrupts a checkpoint). Whether
  array stop and server shutdown use the same setting was not checked.
- **Docker PID Limit** (default 2048). Measured: a live Ghidra session used about 94 PIDs on a 64-CPU host,
  so the default of 4 sessions needs roughly 400. The count follows the CPU count; on a bigger or busier
  host, watch it. Four concurrent sessions were not run.

## Configuration

Every setting is an environment variable. An unparsable value makes the container exit non-zero and name the
variable. A variable set to nothing counts as unset.

| Variable | Default | Meaning |
|---|---|---|
| `REA_MCP_API_KEY` | none, **required** (or one of the next two) | One API key, at least 32 characters |
| `REA_MCP_API_KEY_FILE` | none | Path to a file holding one key (a trailing newline is trimmed); for Docker or unRAID secrets |
| `REA_MCP_API_KEYS` | none | Comma-separated keys, for rotation. All three sources are combined |
| `PORT` | `8080` | Port the gateway listens on inside the container |
| `MAX_SESSIONS` | `4` | Open sessions at once, one REA and one Ghidra process each. Over the limit: `503` with `Retry-After`, and nothing is evicted |
| `SESSION_IDLE_TIMEOUT_SEC` | `300` | A session with no request and no call in flight for this long is ended. **Read [Tell the agent to close what it opens](#tell-the-agent-to-close-what-it-opens) before leaving the default** |
| `TRUST_PROXY` | `false` | `true` only behind a trusted proxy or tunnel: the client address then comes from `CF-Connecting-IP` or `X-Forwarded-For` |
| `ALLOWED_HOSTS` | empty | Comma-separated `Host` names accepted on `/mcp` (case-insensitive, port ignored). Empty accepts any. `/healthz` is exempt |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error`. Logs never contain request headers or keys |
| `GHIDRA_MAX_HEAP` | empty (REA's `2G`) | Maximum Java heap of each Ghidra process, such as `4G` or `512M` |
| `REA_GHIDRA_STARTUP_TIMEOUT_MS` | empty (REA's `330000`) | How long REA waits for Ghidra to start |
| `REA_GHIDRA_CHECKPOINT_DIR` | empty (**off**) | An absolute path, recommended `/work/checkpoints`. See [Checkpoints](#keeping-analysis-between-sessions-checkpoints) |

The image also fixes `JAVA_HOME=/opt/jdk`, `GHIDRA_INSTALL_DIR=/opt/ghidra` and `HOME=/work/home`; do not
override them. Mounts: `/samples` (read-only) and `/work` (read-write; Ghidra output, a directory per
session under `sessions/`, and the checkpoint folder).

**Memory.** Each session has its own Ghidra, so size `MAX_SESSIONS` times `GHIDRA_MAX_HEAP` plus overhead
against your RAM. Measured: two sessions analyzing a 770 KB static binary at the default 2G heap peaked at
about 2.5 GiB for the container.

### The key

Generate one at run time with `openssl rand -hex 32` and enter it only in the unRAID form, an environment
variable or a secret. The server **refuses to start** with no key, or with any key shorter than 32 characters.
To rotate: add the new key to `REA_MCP_API_KEYS` next to the old one, move the clients, then remove the old key.

## Connect a client

Both clients send the key in an `x-api-key` header. Use `<host>` for the public host name of your tunnel or
proxy and `<key>` for your key; never paste a real key into a document or a repository.

**Claude Code** (syntax from Claude Code's MCP documentation; the `--header` form is the one it shows):

```bash
claude mcp add --transport http rea https://<host>/mcp --header "x-api-key: <key>"
# or, to try it locally:
claude mcp add --transport http rea http://localhost:8080/mcp --header "x-api-key: <key>"
```

The command line ends up in your shell history. To keep the key out of it and out of Claude Code's configuration
file, export it (`export REA_KEY=<key>`) and give the header in **single quotes** so the shell does not expand it:
`--header 'x-api-key: ${REA_KEY}'`. Claude Code expands `${REA_KEY}` when it loads the server (checked with a
configuration passed on the command line, which connected; `claude mcp add --scope project` wrote the placeholder
and not the key to `.mcp.json`, but that server was still awaiting approval, so it was not connected). A server added with `--scope project` (shared in
`.mcp.json`) must be approved once by running `claude`. Then ask Claude Code to list the `rea` tools. This was
run end to end against the container with Claude Code 2.1.319 in `claude -p` mode: all 255 tools appear, and an
analysis of a sample works.

**claude.ai custom connector** (steps from Anthropic's help page; not yet tried against this server): open
**Customize, Connectors**, choose **+ Add**, **Add custom connector**, enter `https://<host>/mcp`, and
under **Request headers** add `x-api-key` with your key; choose **No sign in** for authentication.
Claude reaches the server **from Anthropic's cloud, on port 443 only**, so it must be public HTTPS on the
standard port; a private address or `:8080` will not work.

### Long calls, keep-alives and timeouts

Ghidra analysis takes tens of seconds (11 s for a 16 KB binary and 41 to 45 s for a 770 KB static one,
measured), and a proxy in front will cut a silent connection. The gateway writes an SSE comment on every open
stream every 15 s, so such a call stays alive, and it forwards REA's progress notifications. A session with a
call in flight is never reaped as idle. Cloudflare documents a default **125 s** proxy read timeout (the
design planned for roughly 100 s); keep-alives defeat an idle timeout but not an absolute cap on duration.
Details: [`docs/CLOUDFLARE.md`](docs/CLOUDFLARE.md).

### Tell the agent to close what it opens

Add a line like this to your instructions: *"When you finish with a binary, call `close_binary`."* It
releases Ghidra and, with checkpoints on, saves your edits and frees the binary for the next session.

This matters because of what Claude Code was observed to do (version 2.1.319, `claude -p`; interactive use and the
claude.ai connector were not tested):

- **Every conversation gets its own session** (its own REA and Ghidra).
- **It does not end its session when it finishes.** It sends no `DELETE /mcp`, and the agent calls `close_binary`
  only if you tell it to (it never did unprompted). The session, its Ghidra (about 1.2 GB) and its slot stay
  until `SESSION_IDLE_TIMEOUT_SEC` passes.
- **So finished conversations use up `MAX_SESSIONS`.** At the defaults (4 sessions, 300 s), four conversations
  within five minutes make the server answer `503` to the next one, which then has no `rea` tools; it works again once
  an idle session is reaped. With checkpoints on, a new conversation on the same binary is refused ("another REA
  session owns this checkpoint") until the previous conversation's session is reaped or has called `close_binary`.
- **The timeout trades slots against a quiet conversation's open binary.** The default is 300 s (it was 900 s until
  this was seen). A conversation that is quiet for longer than the timeout loses its session; Claude Code reconnects
  by itself, but the new session has nothing open, so the agent must open the binary again (it did, in the test) and
  unsaved edits are gone. Lower it to free slots sooner; raise it (and `MAX_SESSIONS`, with RAM to match) if your
  conversations pause for long. With `close_binary` in your instructions, the checkpoint lock-out is gone either way.

## Keeping analysis between sessions (checkpoints)

By default each session analyzes from scratch and Ghidra's work, including names and comments you add, is
discarded when the session ends. Set `REA_GHIDRA_CHECKPOINT_DIR=/work/checkpoints` and REA saves its Ghidra
analysis of each binary and restores it in later sessions (measured: 8.8 s against 43.5 s for the first
analysis of a 770 KB binary, with names and comments intact). It is **off by default** because of these
trade-offs, all observed with a real Ghidra:

- **Shared.** Names and comments saved in one conversation appear in any later one that opens the same bytes.
- **One live session per binary.** A second session on the same binary fails at once with "another REA
  session owns this checkpoint" until the first calls `close_binary` or is reaped (after
  `SESSION_IDLE_TIMEOUT_SEC`). A conversation that reconnects can be blocked by its own idle session.
- **All or nothing.** With it on, anything that is not a stock ELF, PE or Mach-O import (a raw binary, say)
  fails to open with Ghidra instead of falling back.
- **Saved when:** after the first analysis, on `close_binary`, and when a session ends or the container
  stops (a closed stdin or `SIGTERM`). A kill loses edits made since the last save but never corrupts it.
- **Never pruned.** Delete old entries yourself. Keep the folder on persistent storage, separate from
  `/samples`. One folder serves one container.
- **Needs Docker Stop Timeout of at least 40 s** on unRAID (above).
- `REA_GHIDRA_PROJECT_PATH`, `REA_GHIDRA_SEED_FILE`, `REA_GHIDRA_NATIVEAOT_JAR`, `REA_GHIDRA_LANGUAGE_ID` and
  `REA_GHIDRA_DISABLED_ANALYZERS` are never passed on to REA, because REA refuses them beside a checkpoint folder.

Whether running unRAID's "New Permissions" tool on the work folder resets the checkpoint folders (REA
insists on mode `700`) was not tested.

## Hardening, and running read-only

The container runs as uid 99, gid 100 with no capabilities, and `/samples` read-only. It also works with
`--read-only` if you mount a writable `/tmp`: `--read-only --tmpfs /tmp:rw,size=1g` (tested with Docker's
default noexec 64 MB tmpfs). Size `/tmp` generously: each live session used about 27 MiB for a 770 KB binary.
See [`docs/SECURITY.md`](docs/SECURITY.md).

## Where to read more

| File | Contents |
|---|---|
| [`docs/SECURITY.md`](docs/SECURITY.md) | What the server can do, isolation limits, key rotation, hardening |
| [`docs/CLOUDFLARE.md`](docs/CLOUDFLARE.md) | Exposing it through a Cloudflare Tunnel |
| [`docs/DESIGN.md`](docs/DESIGN.md) | Architecture and the evidence behind every claim, including what is still UNVERIFIED |
| [`openspec/changes/bootstrap-rea-mcp-gateway/`](openspec/changes/bootstrap-rea-mcp-gateway/) | The proposal, design, tasks and the specs (`npx @fission-ai/openspec validate --all --strict`) |
| [`openspec/config.yaml`](openspec/config.yaml), [`CLAUDE.md`](CLAUDE.md) | Hard constraints for every change |

## Ground rules

- **No secrets in this repository, ever.** The API key is supplied at runtime only. There is no default key.
- No third-party software under analysis (including TI software) is bundled, downloaded into the repository, or
  committed. Never commit anything under `samples/` or `work/`.
- **Only analyze software you are permitted to analyze.**

## License

Copyright (C) 2026 rea-mcp contributors.

This program is free software: you can redistribute it and/or modify it under
the terms of the GNU General Public License as published by the Free Software
Foundation, version 3. It is distributed WITHOUT ANY WARRANTY. See
[`LICENSE`](LICENSE) for the full text (`GPL-3.0-only`).

REA (`rea-agents`) is a separate MIT-licensed project and Ghidra a separate Apache-2.0-licensed one
(with some GPL components); neither is part of this repository. The image carries their licence files
(`/opt/ghidra/LICENSE`, `/opt/ghidra/licenses`, `/opt/jdk/NOTICE`, `/opt/jdk/legal`) and this project's own at
`/app/LICENSE`.
