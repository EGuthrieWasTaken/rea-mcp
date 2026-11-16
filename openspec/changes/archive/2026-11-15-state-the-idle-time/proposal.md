# Proposal

## Why

The second desktop-agent test (2026-11-15/16, after `clearer-stored-result-messages`) passed every step, and its report, with the
gateway's log, shows the messages are still vague where it matters:

- **"A few minutes" is not a number.** The idle timeout was 600 s; the agent asked how long a result lives and found only "a few
  minutes". The gateway knows the number and can say it.
- **Losing a session loses the open binary too**, and REA's own answer afterwards ("No app is open...") looks the same as never
  having opened anything. The gateway's messages said "run the call again", not "open the binary again first".
- **A retry overwrote a good download.** Running a spent `request_download` command again with the same `-o` file made curl write
  the error body (`--fail-with-body`) over the file it had downloaded. The command is right to show the error; the tool should say
  to use a fresh file name.
- **The stub advises "a smaller limit"** for tools that have no such argument.
- **`upload_status` for an unknown id** gives no next step.
- The same report showed the desktop app still quoting the previous tool descriptions (no "REA" prefix) after the server had been
  updated: it caches the tool list until the connector is refreshed. That is the operator's step, not a code change.

## What Changes

- The idle time is stated as a number wherever a lifetime is mentioned: the stub's note, the "no such stored result" answer, the
  download `410` message, and the `request_download` and `read_result` descriptions ("after 10 minutes without a request; any
  call to the REA tools restarts the timer").
- Those messages also say that the open binary is gone with the session and must be opened again before the call is repeated.
- The stub's note no longer says "a smaller limit"; it says many REA tools take `detail: "summary"`, a limit or a range.
- `request_download`'s `next_steps` warns that curl writes its error text into the output file when it fails, so a retry needs a
  fresh file name.
- `upload_status` for an unknown id says what to do next.
- README: what an agent sees after a long pause ("No app is open"), and why.

**Out of scope**

- REA's own error text ("No app is open. Ask the user..."): it is REA's, and the relay does not change errors.
- Changing the idle timeout's default (the operator's setting) or keeping results past their session.
- Refreshing the connector's cached tool list (a step in the client).

## Impact

- Modified specs: `result-paging` ("The stub's note"), `file-transfer` ("Only stored results can be downloaded").
- Code: `src/features.ts`, `src/main.ts`, `src/gateway-tools/index.ts`, `src/results/replace.ts`, `src/transfer/download.ts`, a small
  `src/duration.ts`, tests, README.
