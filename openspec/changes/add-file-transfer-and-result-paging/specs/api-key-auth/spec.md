# Spec Delta

## MODIFIED Requirements

### Requirement: Failed-authentication rate limiting
The gateway SHALL count failed authentication attempts per source IP address
and, once a source exceeds the allowed number of failures within the limiting
window, SHALL reject further requests from that source with `429` until the
window expires, without evaluating the presented key or ticket. A failed
authentication attempt is a request to `/mcp` with a missing or wrong key, or a
request to a transfer route whose ticket id is unknown or whose secret is wrong.
Successful requests SHALL NOT count against the limit.

#### Scenario: Limit reached
- **WHEN** one source IP exceeds the allowed number of failed attempts within the window
- **THEN** its next request receives `429`, even if that request carries a correct key

#### Scenario: Failed ticket attempts count
- **WHEN** one source IP sends enough requests to transfer routes with unknown ids or wrong secrets to exceed the limit
- **THEN** its next request to `/mcp` and to a transfer route receives `429`

#### Scenario: A correct ticket does not count
- **WHEN** a source uploads and downloads with valid tickets many times
- **THEN** it is not rate limited

#### Scenario: Window expiry
- **WHEN** a rate-limited source waits until the window has elapsed
- **THEN** its next request with a correct key is authenticated

#### Scenario: Other sources unaffected
- **WHEN** one source IP is rate-limited
- **THEN** a request with a correct key from a different source IP is authenticated
