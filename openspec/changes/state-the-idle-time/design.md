# Design

## Context

Evidence: the second test's report and the gateway log. The agent's session last made a request at 01:48:15Z and was ended
as `idle` at 01:58:23Z (600 s plus the reaper's interval); its download at 02:00:29Z answered `410 gone`, as designed. The agent's
questions were all about wording.

## Decisions

### D1. The gateway says the number

`SESSION_IDLE_TIMEOUT_SEC` is passed to the feature wiring and formatted for people: whole minutes ("10 minutes", "1 minute"),
otherwise seconds ("90 seconds"). It is used in the stub note, in the not-found answer, in the `410` message, and in the tool
descriptions (built when the gateway starts, so a changed setting changes the text after a restart).

### D2. What restarts the timer

Stated in the descriptions, from the code: any request the session makes to the gateway (any tool call, REA's or the gateway's)
restarts it, a transfer the session started keeps it from running while the transfer is under way, and the end of such a transfer
restarts it. A request to a download or upload URL is a transfer, not a request of the session.

### D3. The binary goes with the session

Messages that say a result is gone add that the open binary is gone as well, so the agent calls `open_binary` first.

## Unverified assumptions

- Whether the desktop app refreshes its cached tool list when the connector is reconnected, or only when it is re-added. The
  operator is told to refresh the connector and, if the new descriptions do not appear, to remove and re-add it.

## Open Questions

None.
