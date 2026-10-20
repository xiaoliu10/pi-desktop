# Live subagent transcript verification (2026-10-19)

## Claim and failure

The detail panel must read a single async child's live transcript before it completes. Existing code only reads status.sessionFile even though the installed plugin publishes the live pointer on status.steps[0].sessionFile. The screenshot's run was single mode in status.json but rendered as the Desktop workflow adapter (expected UI representation).

Read-only production-data probe through the actual compiled subagentChildTranscript:

- Running run abfdc9db-c376-41c3-984c-d82ae3c47e31: topLevelSession=false, stepSession=true, file exists. Before fix: error=no-snapshot.
- Same running run after fix: 59 messages, 36 tool calls, truncated=false. No change to status or session files.
- Paused run af05ce99-6135-4de4-94da-e337a972c364: 60 messages, 36 tool calls, truncated=true.
- Completed run b341a066-dbf8-416a-9012-3baf850c25a9: 60 messages, 37 tool calls, truncated=true.

No private transcript text is included here. State is sampled at probe time, not a promise of the current run state.

## Scope and security

Resolve top-level pointer first; only if absent, accept the sole step of a mode=single status after runId/sessionId/toolCallId/time checks. Never choose among multiple steps. Workflow child statuses retain parentWorkflowRunId/workflowKey checks. The existing filesystem containment, no-follow open, inode verification and bounded sanitization remain in force. No transcript directory scan or guessed path is added.

## Regression evidence

Four new backend cases cover live unique-step reading plus appends; ambiguous/mismatched identity rejection; top-level priority plus outside-root rejection; workflow child step pointers. Before implementation 3 new assertions failed; after implementation all 44 snapshot tests passed. UI error mapping has two tests and does not echo arbitrary server errors/paths.

Browser fixture runs real SubagentPanel against controlled API responses via Vite :5189 (no user sessions): initial live text and tools appear, subsequent polling appends progress, transient read failure retains prior transcript, completion shows final messages and removes spinner, outside-root displays a specific safety error. Command:

    playwright-cli -s=live-transcript run-code --filename tests/subagent-live-transcript.browser.cjs

Focused tests: 62 passed (snapshot, transcript error, existing activity). Full serial suite (`vitest run --no-file-parallelism`): 1623 passed, 6 skipped (187 files passed, 5 skipped). Default parallel suite failed one existing workflow-stale-recovery signature assertion; an isolated async-root parallel run hit a different existing pinned-workflow assertion. These failures are not hidden by the serial result. Main and renderer type checks passed. Browser fixture returned explicit PASS; screenshot: `output/playwright/live-subagent-transcript.png` (local, not committed). No production app restart, disk replacement or release performed. Running packaged UI verification remains pending release; production CDP port in DevToolsActivePort was stale (connection refused).
