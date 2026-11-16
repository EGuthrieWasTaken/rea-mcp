# Tasks

Commit after each task, ticking its box in the same commit. Ask the maintainer before pushing or opening a pull request.

## 1. Say the number

- [x] 1.1 Add `src/duration.ts` (whole minutes, else seconds) and pass `SESSION_IDLE_TIMEOUT_SEC` through `createFeatures`, `createSessionGateway`, the stub and the download handler; state the idle time in the stub note, the not-found answer, the `410` message and the `request_download` and `read_result` descriptions; tests for the formatter and for each message with a non-default timeout
- [x] 1.2 Say that the open binary is lost with the session in those messages, and drop "a smaller limit" from the stub note; tests

## 2. The other points

- [x] 2.1 `request_download`'s `next_steps` warns that a failed curl writes its error text into the output file; `upload_status` for an unknown id says what to do next; tests
- [x] 2.2 README: what an agent sees after a long pause and why, and that the desktop app caches tool descriptions until the connector is refreshed

## 3. Verify and close

- [x] 3.1 Lint, typecheck, the full suite, `openspec validate --all --strict`, and a run on a built image with a short idle timeout showing the stated time and the `410` text
- [x] 3.2 With the maintainer's approval, push, open a pull request, merge when green, update the container
- [x] 3.3 Archive this change
