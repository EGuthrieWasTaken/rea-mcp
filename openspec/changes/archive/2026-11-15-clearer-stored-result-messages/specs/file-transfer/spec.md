# Spec Delta

## MODIFIED Requirements

### Requirement: Only stored results can be downloaded
`request_download` SHALL accept only the id of a result the gateway stored, and the
download route SHALL serve only that file; there SHALL be no download of an inbox file, a
sample, or any other path. When the session that requested a download ticket ends, the
ticket SHALL stop working, and a request that presents its correct secret SHALL receive
`410` with a JSON message saying that the session ended and its results were deleted.

#### Scenario: Only stored results
- **WHEN** `request_download` is called with a path, a file name, or an id that is not a stored result
- **THEN** the result is a tool error and no ticket exists

#### Scenario: The session has ended
- **WHEN** the session that requested a download ticket ends before the ticket is used
- **THEN** a request with the ticket's id and secret receives `410` and a JSON message that says the session ended

#### Scenario: A wrong secret after the session ended
- **WHEN** the session has ended and a request names the ticket's id with a wrong secret
- **THEN** the response is the same bare `404` as for an unknown id

#### Scenario: A transfer already under way
- **WHEN** a download is streaming when its session ends
- **THEN** the download is allowed to finish

### Requirement: Upload ticket arguments
`request_upload` SHALL refuse a name that already exists in the inbox when `overwrite`
is false, and SHALL refuse an `expect_sha256` that is not 64 hexadecimal characters.
It SHALL clamp `max_bytes` to `MAX_UPLOAD_BYTES` and say so in its result when it did,
and SHALL refuse a `max_bytes` that is not a positive integer.

#### Scenario: A name that already exists
- **WHEN** `request_upload` is called with `overwrite` false for a name that is already in the inbox
- **THEN** the call returns a tool error naming the conflict and no ticket exists

#### Scenario: Overwrite requested
- **WHEN** `request_upload` is called with `overwrite` true for a name that is already in the inbox
- **THEN** a ticket is issued

#### Scenario: A malformed hash
- **WHEN** `request_upload` is called with an `expect_sha256` that is not 64 hexadecimal characters
- **THEN** the call returns a tool error and no ticket exists

#### Scenario: A limit that was lowered
- **WHEN** `request_upload` is called with a `max_bytes` above `MAX_UPLOAD_BYTES`
- **THEN** the result has the lowered `max_bytes`, `max_bytes_clamped` true, and a sentence saying the server's limit applied

#### Scenario: A limit that was not lowered
- **WHEN** `request_upload` is called with a `max_bytes` at or below `MAX_UPLOAD_BYTES`
- **THEN** the result has `max_bytes_clamped` false
