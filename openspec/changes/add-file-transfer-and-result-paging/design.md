# Design

## Context

Two things have to cross the boundary between the agent and the container without
going through the model's context: a file the agent wants analysed (agent to
container), and an analysis result too large for the client to take (container to
agent). `claude-files`, the maintainer's file server for a shared folder, already
solves both and the maintainer has used it for months, so this design follows it
closely and says where it differs and why. The reference implementation was read in
full on 2026-11-15 (`app/uploads.py`, `app/downloads.py`, `app/safepath.py`,
`app/config.py`, the `read_file`, `request_upload` and `request_download` tools in
`app/mcp_endpoint.py`, the upload and download routes in `app/main.py`, and its
`docs/upload-urls.md` and `docs/download-urls.md`).

Credit: the ticket model (single-use, 256-bit secret in the URL path, a `curl` command in
the tool result, `pending -> receiving -> complete | failed`, lazy expiry, a cap on live
tickets, one 404 for a bad id or a bad secret, a path-redacting log) and the ranged read
(`offset`, `length`, `next_offset`) come from `claude-files`. `claude-files` has no
LICENSE file; the maintainer is its author and has given permission, and nothing of it
is copied or vendored.

What the gateway does today: it relays JSON-RPC between the HTTP transport and one REA
child per session and interprets none of it, except `initialize` (to start the session) and
the request ids and progress tokens it needs for bookkeeping (`src/sessions/manager.ts`).

## Goals / Non-Goals

**Goals**

- An agent can give REA a file with one tool call and one `curl`, with no file bytes in
  any tool argument or result.
- No REA result can exceed what the gateway is configured to send inline, and the agent
  can read the rest in pieces or fetch it whole.
- Stand-alone: no network call to, and no code from, any other service.
- Interception in the relay is small, listed, and falls back to forwarding the original
  message when it fails.
- Every new unauthenticated path has negative tests.

**Non-Goals**

See the proposal's out-of-scope list. In short: no git, no writes by tool argument, no
delete or list tools, no general file reads, no resumable transfers, and no fix for the
client's call timeout.

## Decisions

### D1. Four gateway-local tools, answered inside the relay

The session manager already sees every message in both directions. Three message shapes
are now treated specially; everything else, including every notification, is relayed as
before.

| Direction | Message | Treatment |
|---|---|---|
| client to REA | `tools/call` whose `params.name` is one of the four gateway tools | answered by the gateway; **not forwarded** |
| REA to client | the result of `tools/list` | the four tool definitions are appended; each REA tool's `outputSchema` is removed (D2); a REA tool with a gateway tool's name is dropped, with a warning |
| REA to client | the result of a `tools/call` (not an error) larger than `RESULT_INLINE_LIMIT_CHARS` | replaced by a stub (D3) |

A request answered locally is tracked in the session's in-flight table like any other
and ended with the same bookkeeping, so a cancel, a session end or a reaped session
answers it exactly once (the existing "calls still open" behaviour). To know which
result belongs to which kind of request, the in-flight entry records the method and, for
`tools/call`, the tool name.

If interception fails (a result that is not shaped as expected, a full disk), the
original message is delivered unchanged and the failure is logged by name only. A
message is never lost because the gateway tried to improve it.

If a `tools/list` result carries a `nextCursor`, the gateway tools are appended to the
page that has none (the last). REA reports one page today (Evidence E2).

The initialize result's `instructions` are not touched. The tool descriptions carry the
guidance, so one fewer message is rewritten.

*Alternative considered: a second MCP server behind the same endpoint.* There is no
standard way to merge two servers' tools into one session, and the client would need two
connectors. Rejected.

### D2. Remove `outputSchema` from REA's tools when results can be replaced

Every one of REA's 255 tools declares an `outputSchema`, and most are strict
(`additionalProperties: false`, many required fields; Evidence E2). The MCP TypeScript
SDK's client, which Claude Code uses, refuses a result that has no `structuredContent`
for a tool that declares one, and validates `structuredContent` when it is there
(Evidence E5). A stub cannot satisfy those schemas, so a replaced result would be
rejected by a validating client, which defeats the purpose.

Decision: when `RESULT_INLINE_LIMIT_CHARS` is above `0`, the gateway removes
`outputSchema` from every tool REA reports. The model reads `content`, which carries
the same JSON text as `structuredContent` (observed for two tools; task 1.1 checks more before D2 is relied on). Clients lose the schema, which no current client of this project
uses for anything but validation. With `0`, nothing is removed and nothing is replaced,
so REA's list and results are exactly as before.

Alternatives: a stub flagged `isError` (validators skip errors, but it would tell the
client a successful call failed); never replacing (leaves the client problem unsolved);
stripping `outputSchema` only from tools whose results turn out to be large (the list is
sent once, before any result exists). Rejected.

### D3. Replace an oversized result with a stub and keep the full text on disk

The size of a result is the length in characters of its serialized JSON. That counts
`content` and `structuredContent` both, which is how many bytes the client receives
and so the conservative reading of "what the client's cap sees". Default limit: `40000`
(an inference from the one observed failure; see Unverified assumptions).

When a `tools/call` result is over the limit, the gateway stores the text of the
result's `text` content items (joined by a blank line), or, if there are none, the JSON
of `structuredContent`, and sends this instead (JSON in one text content item, no
`structuredContent`, REA's `_meta` and `isError` kept):

```json
{
  "truncated": true,
  "reason": "result_too_large",
  "result_id": "r_<random>",
  "tool": "list_strings",
  "chars": "<n>",
  "bytes": "<n>",
  "preview": "<the first 2000 characters>",
  "stored": true,
  "note": "The full output is stored. Read it with read_result (result_id, offset, length), or download it with request_download. Narrower tool arguments also give smaller results."
}
```

Non-text content items (images) are left in the result as they were. A result with no
text and no `structuredContent` is not replaced.

The files are `/work/results/<session-id>/<result-id>.txt`, mode `0600`, in a `0700`
directory. A session may store at most 256 MiB (a fixed constant); a result that would
exceed it is not stored, and its stub says `"stored": false`, carries the preview, and
tells the agent to narrow its request. A session's directory is deleted when the
session ends, for any reason, and `/work/results` is emptied at startup (a restart ends
every session). Results are not kept after a session ends: they are a copy, not the
analysis, and the session's REA state dies with it anyway.

### D4. `read_result` pages by byte range, and returns raw text

`read_result(result_id, offset?, length?)` reads a stored result of the calling session.
`offset` and `length` count UTF-8 **bytes**, not characters: `claude-files` counts
characters, but its files are small enough to hold in memory; a result can be tens of
megabytes, and a byte offset needs one positioned read. Boundaries are moved so that a
character is never split: a start inside a character moves forward to the next
character, and an incomplete character at the end is left for the next page, so
`next_offset` is always where the next page starts. `length` defaults to, and is capped
at, `RESULT_INLINE_LIMIT_CHARS`.

The result is two text content items: the metadata as JSON (`result_id`, `offset`,
`returned_bytes`, `total_bytes`, `next_offset`, which is `null` at the end), then the
slice itself, unescaped. Returning the slice as a JSON string would escape every quote
in text that is itself JSON, and make the page about a tenth longer for nothing. The
result carries the `_meta` of the result it was stored from, so REA's marking of its
content as untrusted (`provenance.untrusted_content`) is not lost on the way through.

### D5. One-time tickets

A ticket is created by a tool call and used by a plain HTTP request that carries no API
key. It is kept in memory only: restart means new tickets, as for `claude-files`.

| Field | Meaning |
|---|---|
| `id` | `u_` or `d_` and 16 random bytes, base64url. Public: it names the ticket in `upload_status`. |
| secret | 32 random bytes, base64url. Shown once, in the URL. The gateway keeps only its SHA-256, and compares digests with `timingSafeEqual`. (`claude-files` keeps the secret itself; this is slightly stronger and costs nothing.) |
| `kind`, `sessionId` | upload or download, and the session that asked |
| upload | `name`, `overwrite`, `maxBytes`, optional `expectSha256` |
| download | the stored result, its size, and its SHA-256 (computed when it is stored) |
| `state` | `pending` then `receiving` or `streaming`, then `complete` or `failed`; `expired` is reported when a `pending` ticket is past `expiresAt` |
| progress | `bytesReceived` or `bytesSent`, final `size` and `sha256`, an error `{code, message}` |

A ticket is claimed once: the first request that presents the right secret moves it out
of `pending`; any other request for it gets `409`. A ticket that is past its expiry is
`410` (when the secret is right) and is claimed by nobody. A ticket that started before
its expiry may finish after it. At most 100 tickets are live; finished and expired ones
are dropped one TTL after they ended, and a creation request over the cap is refused.

### D6. Two routes, no key

| Route | Methods | Does |
|---|---|---|
| `/upload/<id>/<secret>` | `PUT`, `POST` | receive the body into the inbox |
| `/download/<id>/<secret>` | `GET` | stream a stored result |

Request pipeline, mirroring `/mcp`: method check (`405` with `Allow`) -> `ALLOWED_HOSTS`
(`403`) -> failed-attempt limit (`429`) -> ticket lookup -> handler. An unknown id and a
wrong secret both get the same bare `404`, and both count as a failure against the
source in the existing limiter (so guessing is limited exactly as key-guessing is). `409`,
`410` and the transfer errors below carry a small JSON body `{code, message}` that never
echoes the request.

The route label that is logged is `/upload` or `/download`, never the path: the existing
logger already records a fixed label instead of the URL, so a secret cannot reach a log.
Neither route sets a cookie or echoes a header.

### D7. Receiving an upload

The body is streamed, never buffered:

1. `Content-Length`, if present and above the ticket's `maxBytes`, is `413` at once.
2. Bytes are written to `/work/inbox/.upload-<random>.tmp` (`O_EXCL | O_NOFOLLOW`, mode
   `0640`), counted, and hashed as they arrive. Passing `maxBytes` is `413`, and the
   temp file is removed. A body that stops for 60 seconds is `408`, and a client that
   hangs up leaves the ticket `failed` with `interrupted`; both remove the temp file.
3. If the ticket has `expect_sha256` and it differs from the computed hash: `422`,
   nothing is committed.
4. The file is `fsync`ed and committed with no-clobber semantics when `overwrite` is
   false (`link` to the final name, which fails with `EEXIST`, then remove the temp name:
   atomic and race-free; `409`) or with `rename` when it is true (after refusing to
   replace a symlink or directory). A reader therefore sees the whole file or none of it.
5. `200 {"ok": true, "upload_id", "name", "path", "size", "sha256"}`. `path` is the
   absolute path to give to `open_binary`.

Node's `server.requestTimeout` defaults to 300 s for receiving a whole request and would
cut a 76 MiB upload from a slow uplink. The gateway sets it to `0` and enforces its own
60-second no-progress limit on the transfer routes. `headersTimeout` stays. On `/mcp`
the key is checked before the body is read, so removing the whole-request limit exposes
only authenticated callers; it is listed under Risks.

### D8. The inbox

`/work/inbox`, created by the entrypoint with the other `/work` directories, writable by
uid 99. Files are named by the caller, so a name is validated when the ticket is
requested (the agent hears about a bad name before it uploads anything) and again before
the write:

- one path component: no `/`, no `\`, no NUL, no control character, not `.` or `..`, not
  starting with `.`, at most 200 bytes in UTF-8;
- the final path is always `/work/inbox/<name>`, and the directory is opened once and
  all writes go relative to it, so no name can reach outside it.

The inbox is **shared by all sessions**, like `/samples` and `/work`: a file uploaded in
one conversation can be opened by a later one, which is what makes a 76 MiB DLL worth
uploading once. (Per-session inboxes were considered; each new Claude Code conversation
is a new session, so the file would have to be uploaded again every time.)

`overwrite` defaults to **false**, unlike `claude-files`, whose files are documents the
agent is meant to revise. Here a file's name is how the agent refers to a binary, and
silently replacing it under a running analysis would be confusing. A failed upload
leaves no file, so a retry with the same name works.

`INBOX_MAX_BYTES` bounds the directory. When a ticket is requested, the bytes in the
inbox plus the `maxBytes` of every live upload ticket plus this ticket's `maxBytes` must
fit, or the request is refused with a message that says the operator has to clear
`/work/inbox`. There is no delete tool: the maintainer asked for none, and an agent that
can delete the evidence it was given is a worse default than a full disk it can report.

Files are never made executable and never executed by the gateway. REA analyses them
statically, as for `/samples`.

### D9. Telling the agent where to upload

`request_upload` returns the URL and the command:

```json
{
  "upload_id": "u_...",
  "upload_url": "https://<host>/upload/u_.../<secret>",
  "curl_command": "curl -sS --fail-with-body -T <LOCAL_FILE> '<upload_url>'",
  "path": "/work/inbox/sample.dll",
  "expires_at": "<ISO 8601 UTC>",
  "max_bytes": 268435456,
  "url_source": "PUBLIC_BASE_URL",
  "next_steps": "Run curl_command ... compare the sha256 ... then open_binary with path."
}
```

The base URL, in order: `PUBLIC_BASE_URL`; else, only when `TRUST_PROXY=true`,
`X-Forwarded-Proto` (`https` or `http`, default `http`) and `X-Forwarded-Host` or `Host`;
else `http://` and the request's `Host`. A `Host` that is not a valid host name is
refused. The request's headers are read when the session's latest authenticated request
arrives and are used only to build this string, never logged. `url_source` says which
rule applied, so a wrong scheme is visible: behind a Cloudflare Tunnel with neither
`PUBLIC_BASE_URL` nor `TRUST_PROXY` the URL would be `http://`, which Cloudflare
redirects, and a redirected `PUT` loses its body. The README says to set `PUBLIC_BASE_URL`.

### D10. A transfer counts as activity

A session with a transfer in `receiving` or `streaming` state that it started is not
idle, and the idle timer restarts when that transfer ends. Without this, a 5-minute
upload would let the idle reaper end the session that is waiting for it, taking its open
binary with it. Tickets themselves do not belong to the session's life: an upload ticket
finishes into the inbox even if its session has ended; a download ticket is revoked when
its session ends, because its file is deleted with the session.

### D11. Configuration

| Variable | Default | Range | Meaning |
|---|---|---|---|
| `PUBLIC_BASE_URL` | empty | an `http(s)` URL with no path, query or credentials | the base of ticket URLs (D9) |
| `MAX_UPLOAD_BYTES` | `268435456` (256 MiB) | 1 to 2^40 | largest single upload (the value `claude-files` uses) |
| `INBOX_MAX_BYTES` | `4294967296` (4 GiB) | 1 to 2^50 | total size of `/work/inbox` |
| `TRANSFER_TICKET_TTL_SEC` | `900` | 30 to 86400 | how long an unused ticket lasts (the value `claude-files` uses) |
| `RESULT_INLINE_LIMIT_CHARS` | `40000` | `0`, or 2000 to 10000000 | the inline limit; `0` turns replacement off (and D2's schema removal with it) |

Fixed, not settings: the live-ticket cap (100), the no-progress limit (60 s), the
per-session result store (256 MiB), the preview (2000 characters). A value that does not
parse stops the gateway at startup, naming the variable, as for the others.

### D12. Logging

Events, with allowlisted fields only: ticket issued (kind, id, session), transfer
started, finished or failed (id, bytes, reason), result stored (session, result id,
characters, tool), session results removed. No file name, no path, no URL, no secret,
no header, and no content of a result is logged at any level.

## Risks / Trade-offs

- **New unauthenticated surface.** The two routes accept a request with no API key. The
  mitigations are the design: 256-bit secrets, constant-time comparison of digests, one
  indistinguishable 404, the shared failed-attempt limit, single use, a 15-minute
  default life, a fixed target (one validated name in one directory, or one stored
  file), a size cap enforced while streaming, a total quota, temp-then-rename, and no
  path or secret in any log. `docs/SECURITY.md` gets a section.
- **The ticket URL is a bearer secret that passes through the model.** It appears in the
  tool result, so in the conversation, and in the agent's shell. Single use and a short
  life are what limit that; it is the same trade `claude-files` made.
- **A wider relay.** The gateway now reads three message shapes. The cost is more code
  on the path every call takes; the control is the fall-back to the original message and
  tests for each shape.
- **Removing `outputSchema`** changes what clients see in `tools/list`. It is tied to the
  one setting that also causes replacement, and `0` restores REA's list exactly.
- **Whole-request timeout off.** Removing Node's 300 s limit means a slow body is held
  open longer. On `/mcp` only after authentication; on the transfer routes the 60 s
  no-progress limit and the ticket's byte cap apply.
- **Shared inbox.** Any session can open any uploaded file, and a file stays until the
  operator removes it. Consistent with the existing "sessions are not a boundary".
- **Disk use** by results is bounded per session and removed with it; by the inbox,
  bounded by `INBOX_MAX_BYTES`.
- **A limit that is too low** makes the agent page results a client could have taken.
  It is a setting.

## Evidence

Collected 2026-11-15 against the published image `ghcr.io/eguthriewastaken/rea-mcp:latest`
(REA 6.9.0), a throwaway container on loopback with a throwaway key, removed afterwards.

- **E1, REA reads files outside `/samples`.** `open_binary` on `/work/inbox/objdump-copy`
  (a copy of the image's `objdump`, made inside the container) succeeded:
  `{"path": "/work/inbox/objdump-copy", "sha256": "1971...03de", "kind": "executable", "format": "elf", "architecture": "x86_64"}`.
  Only `open_binary` was exercised on that path; analysis calls on it are task 1.1.
- **E2, REA's tool list.** 255 tools in one page (no `nextCursor`), each with an
  `outputSchema`. 211 share one evidence-envelope schema with 16 required properties,
  14 are `{result}` with `required: ["result"]`; all of the sampled schemas set
  `additionalProperties: false`. The `initialize` result advertises
  `tools: {listChanged: true}` and carries `instructions`. No tool is named
  `request_upload`, `upload_status`, `request_download` or `read_result`.
- **E3, result shape.** `{"_meta": {"provenance": {"untrusted_content": true, "source": "analysis_target"}}, "content": [{"type": "text", "text": "<JSON>"}], "structuredContent": {...}}`.
- **E4, result size.** `list_strings` on the 371,264-byte `objdump` copy: `content` text
  340,324 characters, and a `structuredContent` of similar size.
- **E5, the SDK client.** In `@modelcontextprotocol/sdk` 1.32.2, `client/index.js`
  (read from the published image, lines 488 to 498): a tool with an output schema and a
  result with neither `structuredContent` nor `isError` throws "has an output schema but
  did not return structured content"; a present `structuredContent` is validated and a
  mismatch throws.
- **E6, the connector test** (the maintainer's overnight report, with this session's
  log analysis): stages 0 to 5 passed; the stage that opened and analysed a 76 MiB DLL
  failed client-side, about 183 s into the call; a 58,842-character `objdump` result
  exceeded the client's output cap. The Cloudflare Tunnel was not the limit: calls of
  170 s and about 300 s returned `200` through it.

## Unverified assumptions

1. The client's output cap. Claude Code's default is believed to be 25,000 tokens
   (recalled, not checked against its documentation here), which is close to the one
   observed failure at 58,842 characters of dense text. The cap of the claude.ai
   connector is unknown. `40000` is a guess below the one failure, not a derived number.
2. `structuredContent` always repeats the parsed `content` text for REA's tools. Seen
   for `open_binary` and `list_strings` only (task 1.1 checks more before D2 is relied on).
3. Whether Claude Code and the claude.ai connector validate `outputSchema` the way the
   SDK's client does. Claude Code is believed to be built on that client; not checked.
   Removing the schemas is safe either way.
4. Node 24 treats `requestTimeout = 0` as no whole-request limit while `headersTimeout`
   still applies (from Node's documentation as remembered; task 4.1 tests it).
5. Cloudflare's request-body limit through a proxied hostname, believed to be 100 MB on
   the Free and Pro plans. Not checked. `MAX_UPLOAD_BYTES` can exceed it; the symptom
   would be a Cloudflare-generated `413` before the request reaches the gateway.
6. Cloudflare Access, if used on the hostname, needs a bypass for `/upload/*` and
   `/download/*`, or `curl` receives a login redirect. How to write that is not verified.
7. The agent's environment can reach the public hostname with `curl`. A local Claude
   Code session can. The claude.ai code-execution sandbox has an egress allowlist
   (stated in `claude-files`'s docs for its own host); whether this host needs adding is
   not verified.
8. The agent's `curl` supports `--fail-with-body` (curl 7.76 or newer).
9. Whether Ghidra checkpoints are keyed by a file's content or its path. If by path,
   replacing an inbox file under the same name could confuse a later open; `overwrite`
   defaults to false for that reason.
10. REA analysis calls (not only `open_binary`) work on files under `/work/inbox`.

## Open Questions

1. Is `40000` the right default for `RESULT_INLINE_LIMIT_CHARS`? Proposed: yes, and tune
   after the first real use.
2. Is a 4 GiB inbox cap with no delete tool right? Proposed: yes; the operator clears it
   from the unRAID share.
3. One shared inbox, or one per session? Proposed: shared (D8).
4. Should `request_download` also hand out inbox or `/samples` files? Proposed: no;
   results only. Say so if a use appears.
5. Is removing `outputSchema` acceptable? Proposed: yes (D2), with `0` as the way back.
6. Should `overwrite` default to `false`? Proposed: yes (D8).
7. Should the transfer routes be subject to `ALLOWED_HOSTS`? Proposed: yes. If the
   maintainer's tunnel serves one hostname, the same list covers all three routes.
8. May the 60-second no-progress limit stay a constant? Proposed: yes.
9. Should the maintainer test the upload through the tunnel, with Access in front if it
   is used, before this is called done? Proposed: yes; it is the one thing a local
   container test cannot show (assumptions 5 to 7).
