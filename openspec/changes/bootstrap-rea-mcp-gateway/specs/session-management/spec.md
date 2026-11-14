# Spec Delta

## Purpose

Governs the lifecycle of the per-session REA child processes so that sessions
are isolated from each other, resource use is bounded, and no analysis process
outlives the session or gateway that owns it.

## ADDED Requirements

### Requirement: One REA process per MCP session
The gateway SHALL start exactly one REA child process for each MCP session, at
session initialization, and SHALL route that session's messages only to that
process. Two sessions SHALL NOT share a REA process.

#### Scenario: Two concurrent sessions
- **WHEN** two clients each initialize a session
- **THEN** two distinct REA processes exist and each client's requests reach only its own process

#### Scenario: Child fails to start
- **WHEN** the REA process cannot be spawned or exits before completing initialization
- **THEN** the client receives an error response, no session is registered, and the failure is logged

### Requirement: Per-session working directory
Before spawning a session's REA process, the gateway SHALL create
`/work/sessions/<session-id>` and SHALL start the process with that directory as
its working directory. This keeps sessions' outputs apart; it is not an
access-control boundary, because every child runs as the same user and shares
`/work` and `/samples`.

#### Scenario: Per-session working directory
- **WHEN** a session is initialized
- **THEN** `/work/sessions/<session-id>` exists and is the working directory of that session's REA process

#### Scenario: Sessions have different working directories
- **WHEN** two sessions are live
- **THEN** their REA processes have different working directories

#### Scenario: Working directory cannot be created
- **WHEN** `/work/sessions/<session-id>` cannot be created
- **THEN** the client receives an error response, no REA process is started, and no session is registered

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
When ending a session the gateway SHALL terminate the REA process in this
order: close the child's standard input, which REA treats as a shutdown request
and answers with its own cleanup; wait up to the grace period for it to exit;
send `SIGTERM` to the child's process group and wait 2 seconds; then send
`SIGKILL` to the group. Termination SHALL extend to processes the REA child
started (such as Ghidra), so that none are left running.

#### Scenario: Child ignores the termination request
- **WHEN** a REA process does not exit within the grace period after its standard input is closed and does not exit after `SIGTERM`
- **THEN** the gateway forcibly kills it

#### Scenario: No orphaned analysis processes
- **WHEN** a session whose REA process had started Ghidra is ended
- **THEN** neither the REA process nor the Ghidra process remains running

#### Scenario: Prompt exit is not delayed
- **WHEN** a REA process exits within the grace period after its standard input is closed
- **THEN** the gateway releases the session at once, without sending `SIGTERM` or `SIGKILL`

### Requirement: Termination grace period
The grace period SHALL be 5 seconds, except that when `REA_GHIDRA_CHECKPOINT_DIR`
is set it SHALL be 30 seconds, so that REA can finish saving its analysis
checkpoint before it is signalled.

#### Scenario: Default grace period
- **WHEN** `REA_GHIDRA_CHECKPOINT_DIR` is unset and a REA process has not exited 5 seconds after its standard input is closed
- **THEN** the gateway sends it `SIGTERM`

#### Scenario: Checkpointing extends the grace period
- **WHEN** `REA_GHIDRA_CHECKPOINT_DIR` is set and a session's REA process needs 10 seconds to exit after its standard input is closed
- **THEN** the process is not signalled before it exits

### Requirement: Graceful shutdown
On `SIGTERM` or `SIGINT` the gateway SHALL stop accepting new connections and
new sessions, terminate every REA child process in parallel as described under
reliable child termination, and exit with status `0` within a bounded shutdown
period: 10 seconds or less when `REA_GHIDRA_CHECKPOINT_DIR` is unset, so that it
fits inside Docker's default stop timeout, and 40 seconds or less when it is
set, in which case the container's stop timeout must be at least that long.

#### Scenario: SIGTERM with live sessions
- **WHEN** the gateway receives `SIGTERM` while sessions are live and checkpointing is not enabled
- **THEN** all REA child processes are terminated and the gateway exits `0` within 10 seconds

#### Scenario: SIGTERM with live sessions and checkpointing
- **WHEN** the gateway receives `SIGTERM` while sessions are live and `REA_GHIDRA_CHECKPOINT_DIR` is set
- **THEN** all REA child processes are terminated and the gateway exits `0` within 40 seconds

#### Scenario: Requests during shutdown
- **WHEN** an `initialize` request arrives after shutdown has begun
- **THEN** it is refused and no REA process is started
