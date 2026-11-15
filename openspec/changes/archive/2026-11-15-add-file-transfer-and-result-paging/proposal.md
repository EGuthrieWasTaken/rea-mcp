# Proposal

## Why

The maintainer's overnight test of the deployed connector (2026-11-14/15, an agent
session on the claude.ai custom connector; its findings are summarized in the design's
Evidence section) passed every stage but one, and had one other problem. Both are about
moving bytes between the agent and the container:

- **Results are too big for the client.** A 58,842-character `objdump` result exceeded
  the client's output cap. This is not rare. On 2026-11-15, `list_strings` on a 371 KB
  ELF returned a result whose `content` text alone was 340,324 characters, and every
  REA result carries its content twice (`content[0].text` and `structuredContent`). The
  agent can ask for less (`detail: "summary"`, `max_output_bytes`), but nothing stops a
  plain call from returning more than a client will take, and nothing lets the agent
  read the rest.
- **The only way to give the agent a file is to put it on the server first.** The
  agent can analyze only paths the container can see, so a file has to be copied into
  the `/samples` share by hand before the conversation can use it. The maintainer wants
  to hand a file to the agent in the chat itself.

The maintainer's sibling project, `claude-files` (private, the maintainer's own code,
used here with their express permission), already solves both with two small designs
that have been used in production: **one-time upload tickets**, where the bytes go from
the agent's shell to the server with `curl` and never pass through the model, and a
**ranged read** of a large file. This change reimplements those two designs in
rea-mcp, in TypeScript, so that the container stays stand-alone: it does not call,
embed or depend on `claude-files`.

## What Changes

- Add four gateway-local MCP tools, appended to the list REA reports:
  `request_upload`, `upload_status`, `request_download` and `read_result`. The gateway
  answers them itself; REA never sees them.
- **Upload.** `request_upload` validates a file name and returns a single-use URL and a
  ready-made `curl` command. The agent runs the command from its own shell. The file
  lands in a new writable inbox, `/work/inbox`, and the tool result names the absolute
  path to give to `open_binary`. `/samples` stays read-only.
- **Large results.** A result from REA that is larger than `RESULT_INLINE_LIMIT_CHARS`
  is written to a per-session file under `/work/results` and replaced by a short stub
  (a preview, the size, and a result id). `read_result` pages through it by byte range;
  `request_download` hands it to the agent's shell as a one-time `curl` download.
- **Two unauthenticated routes**, `PUT|POST /upload/<id>/<secret>` and
  `GET /download/<id>/<secret>`. The secret in the path, 256 random bits compared in
  constant time, is the only authorization, as in `claude-files`. They are single use,
  expire (15 minutes by default), are capped in number, and share the failed-attempt
  rate limit and the `ALLOWED_HOSTS` check with `/mcp`.
- Relax the relay rule. Today the gateway "SHALL relay MCP messages unmodified" and
  "SHALL NOT add, remove, or rename" tools. This change lists exactly what the gateway
  may now touch: it appends its tools to `tools/list`, answers calls to them, removes
  the `outputSchema` of REA's tools (a replaced result cannot satisfy it; see the
  design), and replaces oversized `tools/call` results. Everything else is still
  relayed unchanged.
- Five new settings, all optional: `PUBLIC_BASE_URL`, `MAX_UPLOAD_BYTES`,
  `INBOX_MAX_BYTES`, `TRANSFER_TICKET_TTL_SEC`, `RESULT_INLINE_LIMIT_CHARS` (`0`
  switches result replacement off). They appear in the unRAID template and README.
- A session that has an upload or download in progress is not idle; a session's stored
  results are deleted when it ends.
- Documentation: README usage, SECURITY (the new unauthenticated routes), CLOUDFLARE
  (the public URL, an Access bypass if Access is used, a body-size limit that is
  UNVERIFIED), and evidence in `docs/DESIGN.md`.

This change was written after `bootstrap-rea-mcp-gateway` was archived (commit "Archive
the bootstrap change into the main specs"), so its deltas modify the promoted specs in
`openspec/specs/`.

**Out of scope**

- Anything from `claude-files` other than a ranged read and one-time up/download tickets:
  no git tools, no `write_file` or chunked writes, no delete, move, copy or list tools,
  no worktree gate, no PDF text extraction, no base64 reads.
- A general `read_file` of `/samples` or of the inbox. Ranged reads are only of results
  the gateway itself stored. (An uploaded or sample file is analysed through REA.)
- Resumable or multi-part uploads, `Range` downloads, and any server-side fetch of a
  URL the agent names (it would be an SSRF vector).
- Deleting or expiring inbox files. The inbox is bounded by `INBOX_MAX_BYTES`; clearing
  it is the operator's job, as for `/work/sessions` and the checkpoint directory.
- A search tool over stored results. The agent can download one and search it locally.
- **The client giving up on a long call** (about 3 minutes into a 76 MiB DLL analysis in
  the connector test). Moving bytes does not shorten a call. That is a separate change
  (checkpoints on, progress heartbeats, or a start-and-poll pattern).
- Authentication other than the existing `x-api-key`, TLS, per-session isolation and
  everything else the bootstrap change put out of scope.
- Calling, embedding or vendoring `claude-files` code. The designs are ported, not the
  files.

## Impact

- New specs: `file-transfer`, `result-paging`.
- Modified specs: `mcp-http-gateway` (endpoint and relay rule, unknown paths, host
  allowlist, configuration, logging), `session-management` (idle reaping),
  `api-key-auth` (the failed-attempt limit), `container-image` (volumes),
  `unraid-template` (advanced entries).
- New code under `src/transfer/` and `src/results/`, changes to `src/sessions/manager.ts`,
  `src/http/server.ts`, `src/config.ts`, `docker/entrypoint.sh`, `unraid/rea-mcp.xml`,
  `scripts/check_template.py`, `.env.example`, tests and docs.
- No change to the image's contents or base, no new runtime dependency (Node's own
  `node:crypto`, `node:fs` and `node:http` are enough), and no change to how REA is
  launched.
