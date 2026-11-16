# Design

## Context

Evidence: the gateway's own log for the test window. The session that stored result `r__hCF...` at 00:18:04 and issued a
download ticket at 00:18:27 last had a request at 00:19:40 and was ended as `idle` at 00:24:57; the agent's `GET /download`
came at 00:43:17 and was logged as a `404`. Nothing was wrong; the answers were just indistinguishable.

## Decisions

### D1. Ending a session fails its pending download tickets instead of deleting them

`TicketStore.revokeDownloads` used to delete a session's download tickets, so the URL then looked unknown (`404`). It now marks
each pending one `failed` with the code `session_ended` and keeps it until the normal sweep (one lifetime after it ended). The
download handler answers such a ticket `410` with `{"code": "gone", "message": ...}`. A ticket already streaming is left to
finish (its file stays readable through the open handle). Only a request that presents the correct secret reaches this answer;
an unknown id or a wrong secret is still the same bare `404`, so nothing is revealed to a guesser. After the sweep, the URL is
`404` again.

### D2. Messages say what probably happened, not which

`read_result` and `request_download` keep one answer for "unknown", "another session's" and "ended session's" results (the
spec's indistinguishability requirement), but the one answer now explains that a result is deleted when its session ends,
which happens after a period without requests, and that the cure is to run the analysis again. `upload_status` echoes the id
it was given and says records are kept for a limited time.

### D3. The stub note and the tool texts

The stub's note names the units and the lifetime. It does not give the idle timeout's number, which is the operator's setting.
Tool titles gain "REA" and descriptions say the tool is for files and results on the REA server.

## Unverified assumptions

- Whether the claude.ai or desktop client shows a tool's `title` where several connectors expose the same tool name. It does
  not change correctness.

## Open Questions

1. Should stored results outlive their session by a grace period (for example, the download ticket's lifetime)? Proposed: no;
   a reconnect is a new session and the operator can raise `SESSION_IDLE_TIMEOUT_SEC`.
