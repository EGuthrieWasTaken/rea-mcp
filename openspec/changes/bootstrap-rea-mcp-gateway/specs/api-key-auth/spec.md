# Spec Delta

## Purpose

Controls access to the MCP endpoint with static API keys supplied at runtime,
and guarantees that those keys are never defaulted, weakened, or leaked.

## ADDED Requirements

### Requirement: Runtime-only key sources
The gateway SHALL obtain its accepted API keys only at runtime from
`REA_MCP_API_KEY`, from the file named by `REA_MCP_API_KEY_FILE`, and from the
comma-separated list in `REA_MCP_API_KEYS`. The accepted key set SHALL be the
union of all configured sources. Surrounding whitespace and a trailing newline
SHALL be trimmed from each key, and empty entries SHALL be ignored. The gateway
SHALL NOT contain a built-in or default key.

#### Scenario: Single key from environment
- **WHEN** `REA_MCP_API_KEY` is set to a valid key and no other source is set
- **THEN** the gateway starts and accepts exactly that key

#### Scenario: Key loaded from file
- **WHEN** `REA_MCP_API_KEY_FILE` names a readable file containing a valid key followed by a newline
- **THEN** the gateway starts and accepts the key without the trailing newline

#### Scenario: Multiple keys for rotation
- **WHEN** `REA_MCP_API_KEYS` contains two valid keys separated by a comma
- **THEN** a request presenting either key is authenticated

#### Scenario: Sources are combined
- **WHEN** `REA_MCP_API_KEY` and `REA_MCP_API_KEYS` are both set with different valid keys
- **THEN** every key from both sources is accepted

### Requirement: Startup refusal on missing or weak keys
The gateway SHALL refuse to start, exiting with a non-zero status and without
listening on any port, when no key is configured, when any configured key is
shorter than 32 characters, or when `REA_MCP_API_KEY_FILE` is set but cannot be
read. The startup error SHALL identify which variable is at fault and SHALL NOT
include the key or any part of it.

#### Scenario: No key configured
- **WHEN** the gateway starts with none of the key variables set
- **THEN** it exits non-zero, does not open the listening port, and logs that an API key is required

#### Scenario: Key too short
- **WHEN** the gateway starts with a 31-character key
- **THEN** it exits non-zero and the logged error does not contain the key

#### Scenario: One weak key among several
- **WHEN** `REA_MCP_API_KEYS` contains one valid key and one key shorter than 32 characters
- **THEN** the gateway exits non-zero rather than starting with only the valid key

#### Scenario: Unreadable key file
- **WHEN** `REA_MCP_API_KEY_FILE` names a path that does not exist
- **THEN** the gateway exits non-zero

### Requirement: Header authentication on the MCP endpoint
Every request to `/mcp`, regardless of method, SHALL be authenticated by an
`x-api-key` request header matching one of the accepted keys before any MCP
processing or session lookup takes place. A request that fails authentication
SHALL receive status `401` with a body that carries no detail about why it
failed, and SHALL NOT create, touch, or reveal the existence of any session.

#### Scenario: Correct key
- **WHEN** a request to `/mcp` carries an `x-api-key` equal to an accepted key
- **THEN** the request proceeds to MCP handling

#### Scenario: Missing header
- **WHEN** a request to `/mcp` has no `x-api-key` header
- **THEN** the response is `401` with no explanatory detail

#### Scenario: Wrong key
- **WHEN** a request to `/mcp` carries an `x-api-key` that matches no accepted key
- **THEN** the response is `401` and is indistinguishable from the missing-header response

#### Scenario: Wrong key with a valid session ID
- **WHEN** a request carries an existing `Mcp-Session-Id` but an invalid key
- **THEN** the response is `401`, identical to that for an unknown session ID, and the session's idle timer is not reset

### Requirement: Constant-time key comparison
Key comparison SHALL NOT take time dependent on the content or length of the
presented or accepted keys. The gateway SHALL compare fixed-length digests of
the presented and accepted values using a constant-time primitive, and SHALL
evaluate the presented value against every accepted key rather than stopping at
the first match.

#### Scenario: Length mismatch
- **WHEN** the presented key is shorter or longer than every accepted key
- **THEN** the request is rejected with `401` through the same comparison path as an equal-length wrong key, without throwing

#### Scenario: Match on the last of several keys
- **WHEN** three keys are accepted and the presented key equals the third
- **THEN** the request is authenticated and all three comparisons were performed

### Requirement: Failed-authentication rate limiting
The gateway SHALL count failed authentication attempts per source IP address
and, once a source exceeds the allowed number of failures within the limiting
window, SHALL reject further requests from that source with `429` until the
window expires, without evaluating the presented key. Successful requests SHALL
NOT count against the limit.

#### Scenario: Limit reached
- **WHEN** one source IP exceeds the allowed number of failed attempts within the window
- **THEN** its next request receives `429`, even if that request carries a correct key

#### Scenario: Window expiry
- **WHEN** a rate-limited source waits until the window has elapsed
- **THEN** its next request with a correct key is authenticated

#### Scenario: Other sources unaffected
- **WHEN** one source IP is rate-limited
- **THEN** a request with a correct key from a different source IP is authenticated

### Requirement: Source address resolution
The source IP used for rate limiting and logging SHALL be the socket peer
address unless `TRUST_PROXY=true`, in which case it SHALL be taken from
`CF-Connecting-IP` if present, otherwise from `X-Forwarded-For`.

#### Scenario: Forwarding headers ignored by default
- **WHEN** `TRUST_PROXY` is unset or `false` and a request carries `X-Forwarded-For` or `CF-Connecting-IP`
- **THEN** failures are attributed to the socket peer address and the headers are ignored

#### Scenario: Forwarding headers honored behind a trusted proxy
- **WHEN** `TRUST_PROXY=true` and a request carries `CF-Connecting-IP`
- **THEN** failures are attributed to the address in that header

### Requirement: Keys never appear in output
The gateway SHALL NOT write any API key, presented key, or value derived from a
key (including hashes, prefixes, suffixes, and lengths) to logs, error
messages, HTTP responses, or child-process environments or arguments. The
gateway SHALL NOT log request headers.

#### Scenario: Failed authentication is logged safely
- **WHEN** a request fails authentication
- **THEN** the log entry records the event and source IP but contains neither the presented value nor any request header

#### Scenario: Keys are withheld from the REA child
- **WHEN** the gateway spawns a REA child process
- **THEN** none of the `REA_MCP_API_KEY*` variables are present in the child's environment
