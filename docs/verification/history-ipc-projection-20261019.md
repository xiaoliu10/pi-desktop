# Desktop history IPC projection: review and verification

Date: 2026-10-19. Branch: perf/history-wire-images, based on main c119756.

## Claim

Desktop history IPC omits unused toolResult top-level image base64 while keeping text, metadata, details and user attachments. Internal SessionIndex callers (fork, continuation, sidecar, remote) remain lossless. No claim that the user's 2909ms input delay is fixed, and no worker implementation is included.

## Evidence

- Focused tests: renderer-history six cases + session-incremental-tail ten cases = 16 passed.
- Mutation: disabled role matching in RendererHistory, yielding 4 failed / 2 passed; restored, six passed.
- Full suite at implementation head: 1623 passed / 6 skipped (187 files passed / 5 skipped), log /tmp/pi-history-full.log. The first worktree run lacked bundled-runtime resources; its six environment failures were resolved by linking the existing runtime, not by changing tests.
- Both TypeScript configurations passed. Main compile + Vite build passed.
- Actual Electron IPC fixture (Electron 33.4.11, Chromium 130.0.6723.191), no production app/profile or sessions loaded. Initial raw invoke 46–58ms vs projected about1ms; these are machine/fixture observations, not thresholds or a production latency guarantee. JSON proxy sizes 60,940,418 vs124,112 bytes are NOT actual serialized IPC byte counts (entries/branch aliases can be deduplicated).
- Final reproducible smoke entry: env -u ELECTRON_RUN_AS_NODE npm run smoke:history-ipc. It always compiles current main source, preventing stale-dist false passes. Final exact measurements are attached to the PR; smoke exit0. Synthetic fixture keeps500rows with29large tool images and checks projected content/size.

## Review disposition

code-reviewer abfdc9db-c376-41c3-984c-d82ae3c47e31: approve, no blockers. Independently ran six tests and both typechecks; did not rerun Electron/full suite and explicitly marked those as author evidence.

- F1/F2: paged arrays are fresh and require O(n) traversal with entry memo hits; invariant now documented. No extra cache/risky algorithm change added merely to remove a small array allocation.
- F3: no-op self mapping is intentional, now documented (avoids repeat traversal).
- F4: consumer-side comment now warns that future tool image display needs authorized on-demand retrieval, not missing inline data.
- F5: added smoke:history-ipc script with compile-before-launch and fail-fast Node-mode guard.
- F6/F7: evidence/claim distinctions and real IPC measurement confirmed; no change required.
- F8: pre-existing handle() invokes synchronous handlers twice and performs sender validation after the first call; async handlers return before that check. Verified in main c119756, not introduced here. This deserves a separate high-priority correctness/security change with authorization-before-execution tests; this narrow projection PR does not repair or rely on that behavior. No exception to release/review policy is implied.

## Limits

History parsing/scanning remains on main, and the projection does not solve all stalls. Worker isolation, request timing correlation, cold-load input responsiveness and final packaged UI verification remain pending separate work. No app replacement, merge or release has occurred.
