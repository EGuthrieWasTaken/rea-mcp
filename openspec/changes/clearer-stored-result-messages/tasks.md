# Tasks

Commit after each task, ticking its box in the same commit. Ask the maintainer before pushing or opening a pull request.

## 1. Tickets and downloads

- [ ] 1.1 `TicketStore.revokeDownloads` fails a session's pending download tickets (`session_ended`) instead of deleting them; the download handler answers such a ticket `410 {"code":"gone"}` and a ticket that is streaming is left alone; update the ticket and download tests and the end-of-session test; verify a wrong secret after the session ended is still a bare `404`
- [ ] 1.2 The `409` messages of the upload and download handlers name `request_upload` and `request_download`; verify in the existing tests

## 2. Messages and descriptions

- [ ] 2.1 The stub note names the lifetime and the units (`src/results/replace.ts`); `request_upload` reports `max_bytes_clamped` and says so in `next_steps`; "no such stored result" and "no such upload" explain what probably happened; tool titles and descriptions say REA, and `read_result` says slices are raw bytes; tests for each, including that the unknown, other-session and ended-session answers to `read_result` are still identical
- [ ] 2.2 README: how long stored results live and which setting governs it

## 3. Verify and close

- [ ] 3.1 Lint, typecheck, the full test suite, `openspec validate --all --strict`, the template check, and a run of the stub, paging and download flow on a built image showing the new `410` and note
- [ ] 3.2 With the maintainer's approval, push, open a pull request, merge when green, and pull the image on the unRAID container
- [ ] 3.3 Archive this change
