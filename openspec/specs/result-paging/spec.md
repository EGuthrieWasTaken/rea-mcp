# result-paging Specification

## Purpose
Keeps any one REA result from exceeding what the client will take. A result larger than
a configured limit is stored on disk and replaced by a short stub; the agent reads the
rest in byte ranges, or downloads it whole.

## Requirements

### Requirement: Oversized results are replaced by a stub
When `RESULT_INLINE_LIMIT_CHARS` is above `0`, the gateway SHALL replace the result of a
`tools/call` that REA answers successfully, and whose serialized JSON is longer than that
limit, with a result holding one text content item: a JSON stub with `truncated: true`,
`result_id`, the `tool` name, the stored text's size in characters and in bytes, a
`preview` of its first 2000 characters, `stored: true`, and a `note` that names
`read_result` and `request_download`.

#### Scenario: A large result
- **WHEN** REA answers a `tools/call` with a result whose serialized JSON is longer than the limit
- **THEN** the client receives the stub, and the stub's `preview` is the first 2000 characters of the stored text

#### Scenario: A result exactly at the limit
- **WHEN** REA answers with a result whose serialized JSON is exactly the limit
- **THEN** the client receives exactly what REA sent

#### Scenario: A result one character over
- **WHEN** REA answers with a result whose serialized JSON is one character longer than the limit
- **THEN** the client receives the stub

### Requirement: What is stored and what is kept
The stored text SHALL be the text of the result's `text` content items joined by a blank
line, or, if it has none, the JSON of its `structuredContent`. The replacement SHALL omit
`structuredContent`, SHALL keep REA's `_meta` and `isError` as they were, and SHALL leave
any non-text content items in place. Each stored result SHALL be in a file readable only
by the gateway's user, under `/work/results/<session-id>/`.

#### Scenario: The full text is stored
- **WHEN** a result is replaced
- **THEN** the file under `/work/results/<session-id>/` holds the whole text of the result's `text` items

#### Scenario: Evidence flags survive
- **WHEN** a replaced result had `isError: true` and a `_meta` entry
- **THEN** the stub result has the same `isError` and `_meta`

#### Scenario: Only structured content
- **WHEN** a result has no `text` content item and a large `structuredContent`
- **THEN** the stored text is the JSON of `structuredContent`

#### Scenario: Files are private
- **WHEN** a result is stored
- **THEN** its file has mode `0600` and its directory has mode `0700`

### Requirement: Other results are relayed unchanged
A result at or under the limit, a JSON-RPC error response, a result with nothing to
store, and every result when `RESULT_INLINE_LIMIT_CHARS` is `0` SHALL be relayed
unchanged, and no results directory SHALL be created for the session when the setting is
`0`.

#### Scenario: A small result
- **WHEN** REA answers with a result at or under the limit
- **THEN** the client receives exactly what REA sent

#### Scenario: An error is not replaced
- **WHEN** REA answers a `tools/call` with a JSON-RPC error
- **THEN** the client receives the error unchanged

#### Scenario: Replacement is off
- **WHEN** `RESULT_INLINE_LIMIT_CHARS` is `0`
- **THEN** every result is relayed unchanged and no results directory is created for the session

### Requirement: Storage failure and the session cap
When the gateway cannot write a result's file, it SHALL deliver the original result
unchanged and log the failure without the result's content. A session SHALL store at most
256 MiB of results. A result that would exceed that SHALL NOT be stored, and its stub
SHALL have `stored: false`, still carry the preview, and tell the agent to ask for less.

#### Scenario: Storing fails
- **WHEN** the gateway cannot write a result's file
- **THEN** the original result is delivered unchanged and the failure is logged

#### Scenario: A session's store is full
- **WHEN** storing a result would take a session's stored results above 256 MiB
- **THEN** the stub has `stored: false`, still carries the preview, and its note tells the agent to ask for less

### Requirement: Output schemas are not advertised when results can be replaced
When `RESULT_INLINE_LIMIT_CHARS` is above `0`, the gateway SHALL remove `outputSchema`
from every tool in the `tools/list` result it relays, because a replaced result cannot
satisfy it. When the value is `0`, the list SHALL be relayed with REA's schemas intact.

#### Scenario: Schemas removed
- **WHEN** a client lists tools and `RESULT_INLINE_LIMIT_CHARS` is above `0`
- **THEN** no tool in the response has an `outputSchema`

#### Scenario: Schemas kept when replacement is off
- **WHEN** a client lists tools and `RESULT_INLINE_LIMIT_CHARS` is `0`
- **THEN** every REA tool keeps the `outputSchema` REA reported

#### Scenario: A validating client accepts a stub
- **WHEN** a client built on the MCP SDK, which validates output schemas, calls a tool whose result is replaced
- **THEN** the call returns the stub without a validation error

### Requirement: Ranged reads of stored results
The gateway SHALL provide an MCP tool `read_result` that takes a `result_id` and
optionally `offset` and `length`, and returns that range of a result stored by the
calling session. `offset` and `length` SHALL count UTF-8 bytes. `length` SHALL default to
and be capped at `RESULT_INLINE_LIMIT_CHARS`. A range SHALL never split a character: a
start inside a character SHALL move forward to the next character, and an incomplete
character at the end SHALL be left for the next range.

#### Scenario: Reading in pages
- **WHEN** `read_result` is called repeatedly, each time with the previous `next_offset`
- **THEN** the slices concatenate to exactly the stored text, and the last call's `next_offset` is `null`

#### Scenario: A multi-byte character at a boundary
- **WHEN** a range would end in the middle of a multi-byte character
- **THEN** the slice ends before that character and `next_offset` points at its first byte

#### Scenario: A start in the middle of a character
- **WHEN** `offset` points into the middle of a multi-byte character
- **THEN** the returned `offset` is the start of the next character and no partial character is returned

#### Scenario: Length is capped
- **WHEN** `length` is larger than `RESULT_INLINE_LIMIT_CHARS`
- **THEN** at most `RESULT_INLINE_LIMIT_CHARS` bytes are returned

### Requirement: Shape of a ranged read
The `read_result` result SHALL be two text content items: a JSON item with `result_id`,
`offset`, `returned_bytes`, `total_bytes` and `next_offset` (`null` at the end of the
result), then the slice itself without any escaping. It SHALL carry the `_meta` of the
result that was stored, so that REA's marking of its content as untrusted is not lost.

#### Scenario: The slice is not escaped
- **WHEN** the stored text contains double quotes and backslashes
- **THEN** the second content item is the stored bytes exactly, not a JSON-escaped form

#### Scenario: Untrusted content stays marked
- **WHEN** a result stored with `_meta.provenance.untrusted_content` is read with `read_result`
- **THEN** the `read_result` result carries the same `_meta`

### Requirement: Ranged read errors and scope
`read_result` SHALL return a tool error for an `offset` past the end, an `offset` that is
not a non-negative integer, a `length` that is not a positive integer, an unknown
`result_id`, and a `result_id` stored by another session. The last two SHALL be
indistinguishable. It SHALL accept only values that have the form of a result id, and
SHALL NOT open any other path.

#### Scenario: Past the end
- **WHEN** `offset` is greater than the stored size
- **THEN** the result is a tool error

#### Scenario: Another session's result
- **WHEN** a session calls `read_result` with a `result_id` that another session stored
- **THEN** the result is a tool error that does not reveal whether that id exists

#### Scenario: A path instead of an id
- **WHEN** `read_result` is called with a value that contains a `/`, `..` or any character other than those of a result id
- **THEN** the result is a tool error and no file is opened

#### Scenario: A bad length
- **WHEN** `read_result` is called with a `length` of `0` or a negative number
- **THEN** the result is a tool error

### Requirement: Stored results belong to their session
Stored results SHALL be reachable only by the session that produced them and SHALL be
deleted when that session ends, for any reason. At startup the gateway SHALL remove
everything under `/work/results`.

#### Scenario: Session ends
- **WHEN** a session that stored results ends
- **THEN** its directory under `/work/results` no longer exists and `read_result` with one of its ids is a tool error in any session

#### Scenario: Startup cleanup
- **WHEN** the gateway starts and `/work/results` holds directories from a previous run
- **THEN** they are removed

### Requirement: Gateway tools are answered by the gateway
The gateway SHALL answer `tools/call` requests for `request_upload`, `upload_status`,
`request_download` and `read_result` itself and SHALL NOT forward them to REA. It SHALL
append their definitions to the `tools/list` result it relays, to the last page when the
result is paginated. Their definitions SHALL NOT include an `outputSchema`.

#### Scenario: Tools listed
- **WHEN** a client lists tools
- **THEN** the four gateway tools appear in addition to those REA reports

#### Scenario: Not forwarded
- **WHEN** a client calls `read_result`
- **THEN** REA receives no message for that call

#### Scenario: A paginated list
- **WHEN** REA's `tools/list` result has a `nextCursor`
- **THEN** the gateway tools are added to the page that has none

#### Scenario: Everything else is relayed
- **WHEN** a client calls any tool REA reports, with a result under the limit
- **THEN** REA's answer reaches the client unchanged

### Requirement: Gateway tool names are reserved
If REA reports a tool with the name of one of the gateway's tools, the gateway SHALL drop
REA's tool from the list and log a warning, so that a name is never ambiguous.

#### Scenario: A name clash
- **WHEN** REA reports a tool named `read_result`
- **THEN** the list the client receives holds one `read_result`, the gateway's, and a warning is logged

### Requirement: Gateway tool errors and answers
The gateway tools SHALL report failures as MCP tool errors (a result with
`isError: true`) that name the offending argument, not as JSON-RPC errors, so that the
agent can correct its call. A gateway tool call SHALL be answered exactly once, even if
the session ends or the request is cancelled while it runs.

#### Scenario: A bad argument
- **WHEN** a gateway tool is called with an argument of the wrong type, a missing required argument, or an unknown argument
- **THEN** the response is a tool error that names the argument

#### Scenario: The session ends during a call
- **WHEN** the session ends while a gateway tool call is being answered
- **THEN** the call receives exactly one answer, an error, and never two

#### Scenario: A cancelled call
- **WHEN** a client cancels a gateway tool call before it has been answered
- **THEN** no answer is sent for it afterwards
