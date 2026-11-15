# Tasks

Commit after each task, ticking its box in the same commit. Never commit anything under
`samples/` or `work/`. Ask the maintainer before pushing, opening a pull request, or
publishing to GHCR. Any claim not confirmed from a primary source or by running it is
written as UNVERIFIED.

## 1. Evidence before building

- [x] 1.1 In a throwaway container from the published image (loopback, throwaway key, removed afterwards): run analysis calls, not only `open_binary`, on a file under `/work/inbox`; for at least ten different tools check whether `structuredContent` equals the parsed `content[0].text`; confirm again that no REA tool is named `request_upload`, `upload_status`, `request_download` or `read_result`; record the results and the exact commands in a new section of `docs/DESIGN.md`. **If `structuredContent` differs from `content` for any tool, stop and put it to the maintainer, because design D2 assumes they match**
- [x] 1.2 With Node 24, show that a request body sent for longer than a small `requestTimeout` is cut when the option is set and completes when it is `0`, with `headersTimeout` still in force; record it in `docs/DESIGN.md` and settle design assumption 4

## 2. Configuration and image

- [x] 2.1 Add `PUBLIC_BASE_URL`, `MAX_UPLOAD_BYTES`, `INBOX_MAX_BYTES`, `TRANSFER_TICKET_TTL_SEC` and `RESULT_INLINE_LIMIT_CHARS` to `src/config.ts` (`DEFAULT_ENV`, parsing, ranges, the `0`-or-2000-and-up rule) and to `.env.example`; unit-test defaults, a non-numeric value, each range edge, `0`, and a `PUBLIC_BASE_URL` with a path, a query, credentials, a bad scheme and a trailing slash; verify `npm run lint`, `typecheck`, `test` and that the env-example test lists every variable
- [x] 2.2 Make `docker/entrypoint.sh` create `/work/inbox` and `/work/results` and check that they are writable, and have the gateway empty `/work/results` and remove `.upload-*.tmp` files in the inbox at startup; verify by running the built image with an empty `/work`, with a read-only `/work/inbox`, and with leftover files in both

## 3. Tickets and the inbox

- [x] 3.1 Implement the ticket store in `src/transfer/tickets.ts` (D5): ids, 256-bit secrets kept as digests, constant-time lookup, single claim, states, lazy expiry, the 100-ticket cap, dropping finished tickets after one lifetime, revocation by session; unit-test a wrong secret and an unknown id giving the same outcome, a second claim, expiry before and after a claim, the cap, that a stored ticket never holds the secret, and that an accepted API key is not a secret
- [x] 3.2 Implement name validation and the inbox in `src/transfer/inbox.ts` (D7, D8): the name rules, the quota across live tickets, the temporary file, the no-clobber `link` commit and the `rename` commit, refusing symlinks and directories, startup cleanup; unit-test every name rule (a `/`, a backslash, `..`, a leading dot, a NUL, a control character, 200 and 201 bytes, multi-byte names), a file appearing between ticket and commit, a symlink planted at the name, a full inbox, and that a failed write leaves no temporary file
- [x] 3.3 Implement ticket URL construction (D9) in `src/transfer/url.ts`; unit-test the three rules in order, forwarded headers ignored without `TRUST_PROXY`, an invalid `Host`, a missing `Host`, and `url_source`

## 4. HTTP routes

- [x] 4.1 Extend `src/http/server.ts` with the `/upload/<id>/<secret>` and `/download/<id>/<secret>` routes (D6): path classification (exactly two segments), the `/upload` and `/download` log labels, method check, `ALLOWED_HOSTS`, the shared limiter with a failure recorded for an unknown id or a wrong secret, and `requestTimeout = 0`; test a malformed path, `405` with `Allow`, `403` for a disallowed host with a live ticket, the identical bare `404` for an unknown id and a wrong secret, `429` after the limit, and that no log line holds the path
- [x] 4.2 Implement the upload handler (D7) in `src/transfer/upload.ts`: streaming write, size cap while streaming and from `Content-Length`, hash, `expect_sha256`, the no-progress limit (injectable for tests), cleanup on every failure and on client abort, the response codes and body; test success with a multi-megabyte body, `409` on reuse, `410` expired, `413` with and without `Content-Length`, `422` on a hash mismatch, `408` on a stall, a client that hangs up, a file created after the ticket, a symlink planted after the ticket, the `POST` alias, and that no `.upload-*.tmp` is left after any failure
- [x] 4.3 Implement the download handler in `src/transfer/download.ts`: stream with `Content-Length`, `Content-Disposition`, the SHA-256 header and `Cache-Control`; `409`, `410`, revoked `404`, a missing file; test each, and a downloaded body equal to the stored one
- [x] 4.4 Add a log-hygiene test that makes an upload and a download at `LOG_LEVEL=debug` and fails if any log line holds the secret, the URL, the request path, the file name or any result text; make sure it fails when a deliberate leak is added

## 5. Results and the gateway tools

- [x] 5.1 Implement the result store in `src/results/store.ts` (D3): `/work/results/<session-id>/<result-id>.txt`, modes `0600` and `0700`, the 256 MiB per-session cap, removal with the session, startup cleanup; unit-test a write and a read back, the cap giving `stored: false`, removal, a result id that is a path (`../x`, an absolute path, a name with a slash), and modes
- [x] 5.2 Implement result replacement in `src/results/replace.ts` (D3), as pure functions: the size measure, text extraction, the stub, `_meta` and `isError` kept, non-text items left, no-text results left alone, the preview cut at a character boundary; unit-test each, a result exactly at the limit and one character over, and a result with astral characters at the preview boundary
- [x] 5.3 Implement the byte-range reader in `src/results/read.ts` (D4): offset and length in bytes, boundaries that never split a character, `next_offset`, the length cap; unit-test multi-byte text at every offset, the property that pages concatenate to the stored text for random text and random page sizes, an offset past the end, and `length` above the cap
- [x] 5.4 Add the interception to `src/sessions/manager.ts` (D1, D2): the in-flight entry records method and tool name, the `tools/list` rewrite (append, remove `outputSchema`, drop a clashing name, `nextCursor`), local dispatch of gateway tool calls, result replacement, delivery of the original message on any failure, and a single answer when a session ends or a request is cancelled mid-call; extend the fake REA fixture with a tool that returns a large result and tools with `outputSchema`; test each, that REA receives nothing for a gateway tool call, and that an SDK `Client` accepts a stub (Evidence E5)
- [x] 5.5 Implement the four tools in `src/gateway-tools/` (`request_upload`, `upload_status`, `request_download`, `read_result`) with JSON Schemas and argument validation that returns tool errors naming the argument; bind stored results and download tickets to their session, revoke them and delete results when the session ends, and make a transfer in progress count as activity for the idle reaper (D10); test the schemas, every error path, another session's `result_id` giving an error that does not reveal whether it exists, and a session kept alive by a slow upload and reaped without one

## 6. Template and packaging

- [x] 6.1 Add the five variables to `unraid/rea-mcp.xml` as advanced entries, with defaults equal to `DEFAULT_ENV` and a `PUBLIC_BASE_URL` description that says what it is for; verify `scripts/check_template.py` passes under Python 3.9 and 3.13 and fails when a default is changed

## 7. Documentation

- [ ] 7.1 README: a section on giving the agent a file (`request_upload`, then `curl`, then `open_binary` with the returned path) and on reading large results; the five settings; a sample instruction for the agent; why `PUBLIC_BASE_URL` matters behind a tunnel
- [ ] 7.2 `docs/SECURITY.md`: the two unauthenticated routes, what a ticket URL can and cannot do, the limits, the shared inbox; `docs/CLOUDFLARE.md`: `PUBLIC_BASE_URL`, a bypass for `/upload/*` and `/download/*` if Access is used (UNVERIFIED how), the request-body limit (UNVERIFIED), and a test the maintainer can run through the tunnel
- [ ] 7.3 `docs/DESIGN.md`: the evidence of 1.x and 8.x, the overnight connector findings (E6), and the choices that differ from `claude-files` and why

## 8. Verification

- [ ] 8.1 Build the image and run it as the template does (`--cap-drop=ALL`, `no-new-privileges`, `/samples` read-only); upload a file of at least 76 MiB with the returned `curl_command` over loopback; check the response, the SHA-256 and the file in `/work/inbox` agree, call `open_binary` and one analysis tool on it, and check the log holds no secret, path or file name
- [ ] 8.2 With the same container, call a tool that returns a large result: check the stub, page through it with `read_result` until `next_offset` is `null` and compare the concatenation's SHA-256 with a `request_download` of the same result; check `/work/results/<session-id>` is gone after the session ends
- [ ] 8.3 Against the running container, check each refusal with `curl`: reuse `409`, wrong secret `404` (same as an unknown id), over-size `413`, hash mismatch `422`, a short `TRANSFER_TICKET_TTL_SEC` expiring `410`, a disallowed `Host` `403`, and a burst of wrong secrets `429`
- [ ] 8.4 Check idle reaping: with `SESSION_IDLE_TIMEOUT_SEC` set low, a rate-limited upload that outlasts it keeps its session, and the session is reaped afterwards
- [ ] 8.5 Run Claude Code against the container, as in the earlier end-to-end run (subscription login only, never API credits): an agent uploads a file with `curl`, opens it, makes a call whose result is replaced, and reads the rest with `read_result`; record what it did and where it was confused
- [ ] 8.6 Re-run the earlier seeded-violation checks and the full CI gate locally, and add one for the new unauthenticated routes (a seeded log of a secret must fail 4.4's test)

## 9. Reconcile and hand over

- [ ] 9.1 Reconcile the specs with what was built, as bootstrap task 8.4 did: list every difference, put it to the maintainer, and fix the spec or the code; verify `npx @fission-ai/openspec validate --all --strict` passes
- [ ] 9.2 With the maintainer's approval, push the branch, open a pull request, and merge it when CI is green; the `latest` image then rebuilds from `main`
- [ ] 9.3 **Maintainer step.** After pulling the new image on unRAID, set `PUBLIC_BASE_URL`, and upload a file through the tunnel from the machine the agent runs on (with the Access bypass in place if Access is used); report whether the request-body limit, the Access bypass and the agent sandbox's reach (design assumptions 5 to 7) held, and record the answer in `docs/DESIGN.md`
- [ ] 9.4 Archive this change with `openspec archive`, once 9.3 is recorded
