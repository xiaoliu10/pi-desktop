# Input latency: evidence, IPC projection, and multicore isolation

Date: 2026-10-19. Status: first slice implemented; multicore split proposed, not implemented.

## 1. Intent and current seams

Keep typing, clicking, scrolling and switching sessions responsive while a large conversation is active. Preserve complete internal history, attachments, fork/continuation, subagent visibility and transcript semantics.

Current paths:

    OS input -> Electron browser/main process -> renderer event handler
    renderer -> ipcRenderer.invoke(history) -> SessionIndex.history -> reply
    main process -> synchronous session scan/read/parse/branch maintenance
    renderer -> recoverSubagents -> history pointers + filesystem snapshots
    renderer -> gitStatus -> asynchronous git child processes -> result parsing

Relevant files: src/main/index.ts (IPC boundary), src/main/pi/session-index.ts (cache, parsing, internal consumers), src/main/pi/official-subagent.ts and subagent-snapshots.ts (recovery), src/main/pi/git-status.ts (git subprocess/cache), src/renderer/perf-probe.ts and pi/adapter.ts (measurement).

SessionIndex.history is NOT merely a renderer transport: backend fork/continuation and sidecar services call it internally. Changing it to omit image bytes would change those internal contracts. The implemented projection therefore sits ONLY in the Desktop history IPC handler, after history has been read. Remote-server responses and internal SessionIndex callers are deliberately unchanged.

## 2. Evidence and corrections

User's two-minute report: text-input p90 520ms, max 2909ms; history-ipc n=29, avg 608.4ms, max 3035ms; messages-rebuild max 3ms; one 73ms renderer long task. These are aggregates, NOT timestamp-correlated samples. Similar maxima do not prove causality. The sum of input delays counts overlapping waits and is not CPU busy time.

history-ipc wraps an asynchronous await. Its duration includes dispatch, queueing, handler, transport and response delivery, not just synchronous execution. Await itself does not block the renderer. Slow asynchronous git/recovery calls also cannot be equated to main-thread CPU time. Historical main-perf.log spans multiple app instances and many hours; its totals cannot be compared directly to a two-minute renderer window. monitorEventLoopDelay's 5-second reporting cadence is a sampling cadence, not proof of a periodic cause.

Local read-only data probe found a roughly 201MiB session with 2344 entries (NOT the separate 32539-entry session). Its last 500 rows serialized to about 47.6MiB JSON per array, including about 46.9MiB image base64. entries and branch may alias, so JSON.stringify repeats them; Electron structured clone may preserve aliases. The 95.2MiB JSON figure is NOT a measurement of actual IPC bytes. JSON.stringify/parse timings are not Electron serialization timings.

The Desktop adapter's historyToMessages toolResult branch consumes text and details, not top-level image content. User image content IS consumed and must remain intact. No raw sessions or private content are committed in this document or fixtures.

### Real Electron experiment

Repro: build main TypeScript, then run:

    env -u ELECTRON_RUN_AS_NODE npm run smoke:history-ipc

The npm script compiles current source before launching Electron, avoiding stale-dist false passes.

It launches an isolated Electron profile/window, does not launch the production application or load user sessions, and uses actual ipcRenderer.invoke. Synthetic fixture: 500 rows, 29 distinct 1MiB base64 blocks, alternating raw/projected batches (six invokes each). JSON proxy sizes: 60,940,418 vs 124,112 bytes. Measured on this machine:

- Raw invoke: 46–58ms; renderer timer maximum gap 29–33ms per batch.
- Projected invoke: about 1ms; timer maximum gap about 6ms per batch.

This is evidence of reduced transport work, NOT proof that the production 2909ms input delay is fixed. Timer gaps are not input Event Timing. No brittle hardware-dependent timing thresholds are used in regression tests.

## 3. External primary references

- Electron performance guide: https://www.electronjs.org/docs/latest/tutorial/performance
  Recommends avoiding blocking main-process work, using worker threads for CPU-heavy tasks and asynchronous I/O. Maps here to SessionIndex parsing/scanning and recovery processing, not merely React memoization.
- Node worker_threads: https://nodejs.org/api/worker_threads.html
  Workers can execute CPU-intensive JavaScript in parallel; asynchronous I/O is generally preferable for I/O-heavy work. Maps to a persistent index owner, not one new worker per refresh.
- Electron ipcRenderer: https://www.electronjs.org/docs/latest/api/ipc-renderer
  Arguments/results use structured clone; invoke is asynchronous. Reducing reply data remains useful even if heavy parsing moves off-thread.
- Electron utilityProcess: https://www.electronjs.org/docs/latest/api/utility-process
  Provides a separate Node-capable process. Candidate if stronger crash/lifetime isolation is needed than worker_threads.

## 4. Options and recommendation

A. More caches/debounce only: small changes, but one cold full parse can still block main. Not sufficient as an architectural solution.
B. Worker per request: can parallelize but repeatedly copies large history, duplicates caches and races appends. Reject.
C. Persistent index worker (recommended next): worker owns parsing, branch/cache and file watching, and returns metadata, selected text rows, deltas and image references. Main brokers authorization/window IPC; renderer does DOM/React only. Small bounded worker pool only if profiling proves independent CPU jobs; the OS schedules workers across cores, no physical-core pinning is required.
D. utilityProcess: stronger failure isolation, larger transport/lifecycle migration. Prefer if memory/crash isolation warrants it; otherwise worker_threads is the smaller initial seam.

The application already uses multiple processes. The missing capability is moving specific CPU-heavy work OFF its UI/main JS event loop, not assigning a second CPU to the same serial function.

## 5. Safe slices

1. Implemented: Desktop IPC-only RendererHistory projection. Omit only toolResult content image data, retain metadata/text/details and user/assistant images. WeakMap memoization preserves immutable entry identities; internal history/files are unchanged. No worker and no claim of full responsiveness recovery.
2. Capture same-window main CPU profile plus renderer Event Timing and correlated request IDs. Split handler time, queue/response time, payload sizes, input dispatch gaps and process/thread CPU. Verify executing app generation before comparing results. Do not infer causality from aggregate maxima.
3. Move persistent SessionIndex ownership to a worker. Define async RPC contract for sessions/history/search/outline/branch and change all synchronous internal consumers (backend, sidecar, remote) together. Preserve ordering, selected leaf, append offsets, incomplete UTF-8 tails, inode replacement, plan round semantics and lossless fork data. Keep full image bytes at the owner; provide authorized on-demand image retrieval rather than deleting user-visible content.
4. Offload recovery CPU only after attribution; existing async filesystem waits are not CPU busy time. Keep subagent live/terminal state and transcript identity/time/containment checks intact. Git already runs outside JS in child processes; profile stdout parsing/launch rates before moving anything further.
5. Validate main and renderer responsiveness under cold open, streaming, many subagents, rapid switching and large image history. Worker crash must reject outstanding RPCs and recover without silently losing history or clearing live indicators. No synchronous parsing fallback on the UI thread. Bound memory and queues.

## 6. Limits / acceptance

R-render-01 remains partially satisfied: this slice reduces redundant transport but does not move cold scans or parsing off main, does not implement get_entries deltas, and does not prove the real app's input p90 target. R-subagent-01/02, R-sidecar-01 and raw attachment/fork semantics must not regress. Implementing the worker service requires a separate reviewed change; this PR does not claim that work is done. No app package overwrite/restart/merge/release is performed.
