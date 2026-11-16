# Spec Delta

## MODIFIED Requirements

### Requirement: Only stored results can be downloaded
`request_download` SHALL accept only the id of a result the gateway stored, and the
download route SHALL serve only that file; there SHALL be no download of an inbox file, a
sample, or any other path. When the session that requested a download ticket ends, the
ticket SHALL stop working, and a request that presents its correct secret SHALL receive
`410` with a JSON message that says the session ended and its results were deleted, after
how long without a request a session ends, and what to do next.

#### Scenario: Only stored results
- **WHEN** `request_download` is called with a path, a file name, or an id that is not a stored result
- **THEN** the result is a tool error and no ticket exists

#### Scenario: The session has ended
- **WHEN** the session that requested a download ticket ends before the ticket is used
- **THEN** a request with the ticket's id and secret receives `410` and a JSON message that says the session ended, how long a session lasts without a request, and to open the binary and run the analysis again

#### Scenario: A wrong secret after the session ended
- **WHEN** the session has ended and a request names the ticket's id with a wrong secret
- **THEN** the response is the same bare `404` as for an unknown id

#### Scenario: A transfer already under way
- **WHEN** a download is streaming when its session ends
- **THEN** the download is allowed to finish
