# Spec Delta

## MODIFIED Requirements

### Requirement: The stub's note
The stub's `note` SHALL name `read_result` and `request_download`, say that stored
results are deleted when the session ends and after how long without a request a session
ends, say that the open binary goes with the session, and say which counts are characters
and which are bytes.

#### Scenario: The note explains the lifetime and the units
- **WHEN** the client receives a stub
- **THEN** its note says that the stored result is deleted when the session ends, that `bytes` and `read_result` offsets are UTF-8 bytes, and that `chars` counts characters

#### Scenario: The note gives the idle time
- **WHEN** `SESSION_IDLE_TIMEOUT_SEC` is 600 and the client receives a stub
- **THEN** its note says that a session ends after 10 minutes without a request

#### Scenario: The note says to open the binary again
- **WHEN** the client receives a stub
- **THEN** its note says that the open binary is lost with the session, so it must be opened again
