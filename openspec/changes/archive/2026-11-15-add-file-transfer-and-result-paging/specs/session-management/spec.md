# Spec Delta

## MODIFIED Requirements

### Requirement: Idle session reaping
The gateway SHALL end any session that has had no request activity, no in-flight
request, and no transfer in progress for `SESSION_IDLE_TIMEOUT_SEC` seconds,
terminating its REA process. A session with a request in flight SHALL NOT be
considered idle, no matter how long that request runs. A transfer in progress is an
upload or download, started through a ticket that the session requested, that is
still receiving or sending; its end SHALL restart the idle timer.

#### Scenario: Idle session is reaped
- **WHEN** a session receives no requests for longer than the idle timeout
- **THEN** its REA process is terminated and its session ID stops being valid

#### Scenario: Long-running call is not reaped
- **WHEN** a single tool call runs for longer than the idle timeout
- **THEN** the session stays alive until the call completes and the idle timer restarts afterwards

#### Scenario: A long upload is not reaped
- **WHEN** an upload started through a session's ticket is still receiving after longer than the idle timeout, and the session sends no other request
- **THEN** the session is not ended, and once the upload ends the idle timer restarts

#### Scenario: A ticket that was never used does not hold a session
- **WHEN** a session requested a ticket that has not been claimed and sends no other request for longer than the idle timeout
- **THEN** the session is reaped
