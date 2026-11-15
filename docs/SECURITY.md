# Security

Read this before you expose rea-mcp to anything you do not control. Evidence labels are those of
[`DESIGN.md`](DESIGN.md): **Ran** was run against the built image on 2026-11-14, **Source** was read in code or
a vendor page, **UNVERIFIED** was not confirmed. Use `<host>` and `<key>` as placeholders and never put a real
value in this repository.

## What the API key lets a client do

**The key is the only thing between the network and a program that can run commands.** Treat it like a
shell password. An authenticated client can:

- **Run arbitrary commands inside the container**, as uid 99, gid 100. REA's `capture_process_scenario` tool runs
  "a caller-selected command under a PTY ... not a sandbox" (REA's own description), and it did: `id`,
  `sh -c 'touch /tmp/...'` and a Node program all ran (**Ran**). REA advertises other tools that launch or
  attach to things (a GDB, Rizin, Frida, ADB or browser session); this image has none of those engines, and the
  tools that need them fail with `capability_unavailable` (**Ran** for Rizin). `capture_process_scenario` needs
  nothing extra. The gateway relays REA's tools unfiltered by design, so it cannot withhold it.
- **Read every file under `/samples`** and write wherever uid 99 can: `/work` and `/tmp` (**Ran**), including putting any file it likes in `/work/inbox` through an upload URL. `/samples`
  itself cannot be written when mounted read-only (**Ran**: "Read-only file system").
- **Reach the network.** The container has outbound access by default; an HTTPS request from inside it to a
  public host succeeded (**Ran**).
- Start up to `MAX_SESSIONS` Ghidra processes, each using up to its heap and more (see Memory).

It is not a static-analysis-only service. Do not point it at a share you would mind a stranger reading, and do
not run files from `/samples` (several of the sample binaries are written to misbehave).

## Isolation: what there is, and what there is not

- **Between sessions: process and working directory only.** Each MCP session gets its own REA process and
  its own `/work/sessions/<session-id>` directory. Every session runs as the **same uid**, shares `/work`,
  `/samples` and the container's network, and can read another session's directory or process by path. This
  is tidiness, not a boundary. A real boundary needs separate containers.
- **Checkpoint annotations are shared across conversations** when `REA_GHIDRA_CHECKPOINT_DIR` is set: names,
  comments and types saved in one conversation appear in any later one that opens the same bytes (**Ran**).
  Do not enable it if different people or projects must not see each other's notes.
- **The container itself** runs as non-root (99:100) with no capabilities and `no-new-privileges` (**Ran**:
  capability sets all zero, `NoNewPrivs 1`), `Privileged` false. It does not use the host network. This limits
  what the commands above can do to the host; it does not limit what they can do inside the container.

## How the key is handled

- It exists only at run time: an environment variable (`REA_MCP_API_KEY`), a file (`REA_MCP_API_KEY_FILE`) or a
  list (`REA_MCP_API_KEYS`). No default, no key in the image, the repository or the template (**Ran**: the image's
  configuration and history hold no `REA_MCP_API_KEY`). The server **refuses to start** without a key or with one
  shorter than 32 characters (**Ran**).
- Only SHA-256 digests are kept in memory and compared in constant time against every key (**Source**). A missing,
  wrong or short key gets `401` with an empty body and no session (**Ran**).
- The key and request headers are never logged at any level, and the REA processes do not receive it: their
  environment is built from an allowlist (**Source**; **Ran**: no `REA_MCP_API_KEY` variable was in a REA
  child's environment).
  The smoke test checks the container's log for the key on every run.
- **Failed-login limiter:** 10 failed checks from one source address in 60 s get `429` with `Retry-After`,
  and the key is not checked while an address is limited. The source address is the socket peer, unless
  `TRUST_PROXY=true`, when it is `CF-Connecting-IP` or `X-Forwarded-For`; set that only when the container is
  reachable solely through your proxy, because the headers can otherwise be forged. Claude's connectors share
  Anthropic's addresses, so a connector with a wrong key can limit them for a minute (see `CLOUDFLARE.md`).
- **Rotation:** put the new key in `REA_MCP_API_KEYS` beside the old one, move the clients, then remove the old
  key. Any key that may have leaked should be treated as compromised and replaced. Each key is at least 32
  characters; `openssl rand -hex 32` makes one.
- **The key travels in a header**, so serve the endpoint only over TLS (a tunnel or reverse proxy you run). The
  container speaks plain HTTP. A key typed on a command line stays in shell history.

## The upload and download URLs

The gateway has two routes that need **no API key**: `PUT` or `POST /upload/<id>/<secret>` and
`GET /download/<id>/<secret>`. Whoever holds the URL can use it, once. That is how the agent's `curl` sends a file
or fetches a result without the bytes passing through the model, and it is the one place the gateway accepts
something other than the key. What stands between those routes and abuse:

- **The secret.** 256 random bits from the operating system's generator, in the path (not a query string). The
  gateway keeps only a SHA-256 digest of it and compares digests in constant time. An unknown id, a wrong secret and
  a ticket of the other kind all get the same bare `404`, and each counts as a failed attempt against the source
  address in the **same limiter as wrong API keys** (10 in 60 s, then `429`), so guessing is as hard as guessing the
  key. A correct ticket never counts.
- **Single use, short life.** A ticket works once (a second use is `409`) and expires after
  `TRANSFER_TICKET_TTL_SEC` (900 s by default), and at most 100 are live at once. Tickets live in memory, so a
  restart cancels them.
- **A fixed target.** An upload ticket names one file name, validated when the ticket is issued (a single path
  component: no `/` or `\`, no leading dot, no control or direction-changing characters, at most 200 bytes) and again
  before the write. It can write only that one name in `/work/inbox`, never replace a symlink or a directory, and
  never replace an existing file unless the agent asked for `overwrite`. A download ticket serves one stored result
  of one session, never an arbitrary path.
- **Bounded size.** The byte limit is enforced while the body streams, not only from `Content-Length`; a body that
  stalls for 60 s is dropped; the inbox as a whole is capped by `INBOX_MAX_BYTES`, counting uploads in progress.
  A file is written to a temporary name and appears under its own name only once complete and, if the agent gave
  a hash, matching it. A failure removes the temporary file.
- **The same host check and logging rules as `/mcp`.** `ALLOWED_HOSTS` applies to these routes. The log carries the
  route label and the source address, never the path, the secret, the file name or any content.

What a ticket URL does not protect against: **the URL is a bearer secret and it passes through the conversation**
(the tool result that carries it, and the shell command that uses it). Anyone who sees it before it is used, or
between issue and use, can use it for that one upload or download. Single use and the short default life are what
limit that. Do not raise the lifetime without reason.

Things to know about what arrives:

- **Uploaded files are untrusted samples.** They are never executed by the gateway and are created without an
  execute bit. REA analyzes them, and `capture_process_scenario` can still run what a client tells it to (see the
  top of this document); an uploaded file is no more dangerous than one in `/samples`, but it **can be put there by
  whoever can ask for a ticket, which means whoever holds the API key**.
- **The inbox is shared** by every session and is never cleared by the gateway. A file one conversation uploads can
  be opened by another. It sits in `<work-dir>/inbox` on the host: clear it from there.
- **Stored results are analysis output from untrusted files**, and can contain text written to mislead an AI agent.
  REA marks results as untrusted content and the gateway keeps that marking when it pages a result. They are
  readable only by the session that made them and are deleted when it ends.
- Through a **tunnel or proxy**, these routes are public on the internet at the same host name as `/mcp`, protected
  only as described above. See [`CLOUDFLARE.md`](CLOUDFLARE.md) for Access and request-size notes.

## Hardening checklist

1. **Mount only a dedicated samples folder**, read-only, holding only files you are permitted to analyze.
2. **Block or restrict the container's outbound network.** The default is open (above). Put the container on
   a Docker network with no route out (for example one created with `--internal`, which `cloudflared` also
   joins; not tested on unRAID), or firewall it. REA does not need the internet to analyze files, and
   blocking egress also stops a client from sending your samples out.
3. **Keep the work folder on persistent storage that holds nothing else**, owned by `nobody:users` (99:100).
   Keep checkpoints, if enabled, in `/work/checkpoints` and separate from `/samples`.
4. **Set memory and PID limits.** unRAID adds `--pids-limit 2048` itself (**Ran**); add `--memory` for the
   container (see Memory).
5. **Optionally run with `--read-only`** and a writable `/tmp`: Ghidra and REA work unchanged (**Ran**, with
   Docker's default noexec 64 MB tmpfs). It does not stop the commands above from writing to `/tmp` and `/work`.
6. **Expose it narrowly:** a tunnel hostname with `ALLOWED_HOSTS` set, the port not published to the LAN, and
   no Cloudflare Access service-token policy on it (see `CLOUDFLARE.md`).
7. **Pin a version tag** once releases exist instead of `latest`, and rebuild when Ghidra, the JDK or the
   base image have security updates: the JDK is a pinned Temurin archive that nothing updates automatically.

## Memory and sizing

Each session has its own Ghidra with a heap of `GHIDRA_MAX_HEAP` (default 2G) plus the JVM, REA's Node process
and the decompiler. Measured: two sessions analyzing a 770 KB static binary peaked at about 2.5 GiB and 197
PIDs in the container (**Ran**). Plan `MAX_SESSIONS` times your heap plus overhead, and set a container memory
limit so one runaway cannot starve the host. Four concurrent sessions were not run.

## unRAID specifics

- Docker Stop Timeout and Docker PID Limit are host-wide: see the [README](../README.md#two-unraid-host-settings-that-matter).
- unRAID's **New Permissions** tool resets ownership and modes on shares. REA requires its checkpoint
  directories to be private (mode `700`), so running it on the work folder may break checkpoints: **UNVERIFIED**
  (it was not run here). On `/mnt/user/appdata` the directories REA created stayed `700` and owned by 99:100
  and worked (**Ran**).
- The template's `Samples` field has no default on purpose; never choose a share that holds anything else.

## Supply chain

The image downloads Ghidra and a Temurin JDK, each checked against a SHA-256 pinned in the Dockerfile; a wrong
hash fails the build and produces no image (**Ran**). The base image is pinned by digest, `rea-agents` by
exact version and lockfile (its install scripts do not run, and `rea-agents setup` is never run). Ghidra's
published SHA-256 was compared with the pin (**Ran**). Everything else in the image is Debian packages. No third-party
binary under analysis is bundled, and CI scans the full history for secrets with gitleaks.

## What is not covered

TLS, identity, per-user authorization and audit of what a client did: there is one shared key, and the logs
record requests, not tool calls. A vulnerability in REA, Ghidra, `tshark` (which parses untrusted capture
files) or the JDK is outside this project's control; keep the image current.

## Legal

Only analyze software you are permitted to analyze: your own, software you have a licence or written
authorization to examine, or material published for the purpose. Reverse engineering can be restricted by
licence terms and law where you are. The sample set the project was tested with is published for this
purpose. This note is not legal advice.

## Reporting a problem

Open an issue at the project's GitHub repository. For a vulnerability, do not post details in public: use
GitHub's private vulnerability reporting if it is enabled for the repository (**UNVERIFIED**; the maintainer
has not said), or ask the maintainer for a private channel. Never include a real key.
