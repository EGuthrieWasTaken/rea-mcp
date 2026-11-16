# Spec Delta

## MODIFIED Requirements

### Requirement: Oversized results are replaced by a stub
When `RESULT_INLINE_LIMIT_CHARS` is above `0`, the gateway SHALL replace the result of a
`tools/call` that REA answers successfully, and whose serialized JSON is longer than that
limit, with a result holding one text content item: a JSON stub with `truncated: true`,
`result_id`, the `tool` name, the stored text's size in characters and in bytes, a
`preview` of its first 2000 characters, `stored: true`, and a `note`. The note SHALL name
`read_result` and `request_download`, say that stored results are deleted when the session
ends, and say which counts are characters and which are bytes.

#### Scenario: A large result
- **WHEN** REA answers a `tools/call` with a result whose serialized JSON is longer than the limit
- **THEN** the client receives the stub, and the stub's `preview` is the first 2000 characters of the stored text

#### Scenario: The note explains the lifetime and the units
- **WHEN** the client receives a stub
- **THEN** its note says that the stored result is deleted when the session ends, and that `bytes` and `read_result` offsets are UTF-8 bytes

#### Scenario: A result exactly at the limit
- **WHEN** REA answers with a result whose serialized JSON is exactly the limit
- **THEN** the client receives exactly what REA sent

#### Scenario: A result one character over
- **WHEN** REA answers with a result whose serialized JSON is one character longer than the limit
- **THEN** the client receives the stub
