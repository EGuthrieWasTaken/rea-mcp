# Proposal

## Why

The desktop-agent test of the new tools (2026-11-15/16, Claude desktop app, REA connector through the tunnel) passed every step but
one, and the agent's report showed where the tools are unclear:

- **A download URL and a stored result vanished, and nothing said why.** The agent asked for a download, then waited about 24
  minutes (its shell was blocked on approvals). The gateway log shows the session was ended as idle after 5 minutes
  (`SESSION_IDLE_TIMEOUT_SEC`), which by design deletes the session's stored results and revokes its download URLs. The
  download URL then answered a bare `404`, the same as a URL that never existed, and `read_result` said "no such stored
  result", the same as an id that never existed. The agent could not tell an expired result from a typo, and the stub never
  said how long a result lives.
- **A silent clamp.** `request_upload` with `max_bytes` 200000000 returned 104857600 with no word that it had lowered it.
- **Two numbers that differ by one** (`chars` and `bytes` in the stub) with no explanation, and `read_result` offsets in bytes
  while the stub shows characters.
- **Same-named tools from other connectors.** Four other connectors in that session also expose `request_upload`,
  `request_download` and `upload_status`; the REA ones are not recognisable by title.
- **`409` messages** say "Ask for a new one" without naming the tool to ask.

## What Changes

- A download URL whose session has ended is answered `410` with a JSON message that says so, instead of a bare `404`. (The
  secret is already known to the caller, so this tells a guesser nothing: an unknown id and a wrong secret are still the same
  bare `404`.)
- The stub's `note` says that stored results are deleted when the session ends (after a period without requests), and that
  `chars` counts characters while `bytes` and `read_result` offsets count UTF-8 bytes.
- `request_upload` says when it lowered `max_bytes` (`max_bytes_clamped` and a sentence in `next_steps`).
- The "no such stored result" and "no such upload" answers say what likely happened (a session that ended takes its results
  with it; an upload record is kept only for a while) without saying which, so they still reveal nothing about other sessions.
- The gateway tools' titles and descriptions say they are for the REA server; `read_result`'s says a slice is raw bytes and not
  whole records, and that a smaller `length` samples cheaply; `request_download`'s says the URL stops working if the session ends.
- The `409` messages name `request_upload` or `request_download`.
- README: a sentence on how long stored results live and which setting governs it.

**Out of scope**

- Keeping stored results after their session ends. They belong to a session, and a new session (a reconnect) is a new
  principal; this change only makes the loss explicit. Raising `SESSION_IDLE_TIMEOUT_SEC` is the operator's trade-off (slots
  against pauses).
- Dropping the repeated secret URL from tool results, and adding an HTTP status line to `curl_command`.
- Anything in REA's own results.

## Impact

- Modified specs: `file-transfer` ("Only stored results can be downloaded", "Upload ticket arguments"), `result-paging`
  ("Oversized results are replaced by a stub").
- Code: `src/transfer/tickets.ts`, `src/transfer/download.ts`, `src/transfer/upload.ts`, `src/results/replace.ts`,
  `src/gateway-tools/index.ts`, tests, README.
