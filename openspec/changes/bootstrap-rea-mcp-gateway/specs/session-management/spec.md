# Spec Delta

## Purpose

Governs the lifecycle of the per-session REA child processes so that sessions
are isolated from each other, resource use is bounded, and no analysis process
outlives the session or gateway that owns it.

## ADDED Requirements

### Requirement: One REA process per MCP session
The gateway SHALL start exactly one REA child process for each MCP session, at
session initialization, and SHALL route that session's messages only to that
process. Two sessions SHALL NOT share a REA process. Each child SHALL be
started with `/work` as its working directory.

#### Scenario: Two concurrent sessions
- **WHEN** two clients each initialize a session
- **THEN** two distinct REA processes exist and each client's requests reach only its own process

#### Scenario: Child fails to start
- **WHEN** the REA process cannot be spawned or exits before completing initialization
- **THEN** the client receives an error response, no session is registered, and the failure is logged

### Requirement: Concurrent session cap
The gateway SHALL allow at most `MAX_SESSIONS` live sessions. An authenticated
initialization request that would exceed the cap SHALL be rejected with `503`
and a `Retry-After` header, and SHALL NOT start a REA process or evict an
existing session.

#### Scenario: Cap reached
- **WHEN** `MAX_SESSIONS` sessions are live and another client sends `initialize`
- **THEN** the response is `503` with `Retry-After`, and the process count is unchanged

#### Scenario: Capacity freed
- **WHEN** a live session ends while the cap is reached
- **THEN** a subsequent `initialize` succeeds

### Requirement: Explicit session termination
An authenticated `DELETE /mcp` carrying a live session ID SHALL end that
session, terminate its REA process, and release its slot.

#### Scenario: Client deletes its session
- **WHEN** a client sends `DELETE /mcp` with its session ID
- **THEN** the REA process for that session exits and later requests with that ID receive `404`

### Requirement: Idle session reaping
The gateway SHALL end any session that has had no request activity and no
in-flight request for `SESSION_IDLE_TIMEOUT_SEC` seconds, terminating its REA
process. A session with a request in flight SHALL NOT be considered idle, no
matter how long that request runs.

#### Scenario: Idle session is reaped
- **WHEN** a session receives no requests for longer than the idle timeout
- **THEN** its REA process is terminated and its session ID stops being valid

#### Scenario: Long-running call is not reaped
- **WHEN** a single tool call runs for longer than the idle timeout
- **THEN** the session stays alive until the call completes and the idle timer restarts afterwards

### Requirement: Child exit ends the session
If a REA child process exits unexpectedly, the gateway SHALL end the associated
session, fail its in-flight requests with an error, release its slot, and log
the exit code or signal.

#### Scenario: REA crashes mid-call
- **WHEN** a session's REA process exits while a tool call is in flight
- **THEN** the client receives an error for that call, and subsequent requests with that session ID receive `404`

### Requirement: Reliable child termination
When ending a session the gateway SHALL request graceful termination of the REA
process, and SHALL forcibly kill it if it has not exited within a bounded grace
period. Termination SHALL extend to processes the REA child started (such as
Ghidra), so that none are left running.

#### Scenario: Child ignores the termination request
- **WHEN** a REA process does not exit within the grace period after being asked to terminate
- **THEN** the gateway forcibly kills it

#### Scenario: No orphaned analysis processes
- **WHEN** a session whose REA process had started Ghidra is ended
- **THEN** neither the REA process nor the Ghidra process remains running

### Requirement: Graceful shutdown
On `SIGTERM` or `SIGINT` the gateway SHALL stop accepting new connections and
new sessions, terminate every REA child process, and exit with status `0`
within a bounded shutdown period that fits inside Docker's default 10-second
stop timeout.

#### Scenario: SIGTERM with live sessions
- **WHEN** the gateway receives `SIGTERM` while sessions are live
- **THEN** all REA child processes are terminated and the gateway exits `0` before the stop timeout

#### Scenario: Requests during shutdown
- **WHEN** an `initialize` request arrives after shutdown has begun
- **THEN** it is refused and no REA process is started
