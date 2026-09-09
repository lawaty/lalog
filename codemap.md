# LaLog Code Map

Local-first VS Code work-session tracker. Extension entry is `src/extension.ts`; most session logic (state, prompts, persistence, prompts) is orchestrated by `SessionManager`.

## Layout

| Area | Files | What lives there |
|------|-------|------------------|
| **Entry / wiring** | `src/extension.ts` | `activate()`/`deactivate()`, command registration, status bar, event subscriptions (terminal/editor listeners), AI bridge + git annotation wiring |
| **Orchestrator** | `src/core/sessionManager.ts` | The big one. Session lifecycle: `openWorkspace`, `endSession`, `startFresh`, `endAndRestart`, heartbeat (`checkIdle`, `checkAutoEnd`, `checkProgress`), prompt scheduling (`presentDescribe`, `presentWrap`, breakpoints), describe application (`applyDescribeResult`, `applyBackgroundWork`), recovery (`finishRecovered`), technical-capture wiring |
| **Pure state machine** | `src/core/stateMachine.ts` | `Machine`, `onActivity`, `startSession`, `autoClose`. Transitions to `describePending` (≥90 active min), `wrapPending` (≥210), `grace`, hard split at 5h |
| **Prompts (UI)** | `src/prompts/promptCoordinator.ts` | Mutex + min-spacing (`acquire`/`release`), `askWrap`, `askProgressUpdate`, `askStillWorking`. No prompt asks on close (ADR-019) |
| **Describe flow** | `src/prompts/describeFlow.ts` | Text-first describe UI: InputBox first (Enter submits), then task-type QuickPick via `quickPickWithDefault` (low-level, pre-selects "other"). `SESSION_TYPES`, `buildPrefill`, `DescribeResult`. AI draft + "same as last" reachable from the no-text fallback |
| **Breakpoints** | `src/core/breakpoints.ts` | `BreakpointDetector` (`terminal`/`git-commit`/`debug`/`return-idle`/`force`) — prompts are delivered at natural pauses |
| **Config** | `src/core/config.ts` | `readConfig`/`readAiConfig` from VS Code settings, `ThresholdsMs` (all time gates with `debugTimeScale`) |
| **Types** | `src/core/types.ts` | `Session`, `TrackedEvent`, session state, technical entry types |
| **Activity capture** | `src/core/activityTracker.ts` | Editor/edit/save/fileop/task/debug event listeners → `TrackedEvent`s (data) |
| **Spans** | `src/core/spans.ts` | Active-time span building, gap-based accrual, `trimToCutoff` (used at idle-end), outside-VS-Code classification |
| **Storage** | `src/storage/store.ts` | FS primitives (`appendLine`, atomic rename), `workspaceKey`, `LaLogPaths` |
| | `src/storage/sessionStore.ts` | Session CRUD: `newSession`, `saveActive` (60s snapshots), `close` → `sessions.jsonl`, `loadActive`, `updateSession` |
| | `src/storage/projectRegistry.ts` | `projects.json` — claim folders, explicit session assignment, derive-on-read |
| | `src/storage/technicalStore.ts` | Per-session sidecar JSONL (`technical/<id>.jsonl`) with rotation |
| **Technical capture** | `src/capture/diffCapture.ts` | Unified diffs at save (redacted, capped at `maxDiffChars`) |
| | `src/capture/terminalCapture.ts` | Shell-integration command/stdout capture (`read()` to async iterator), ANSI strip |
| | `src/capture/aiLog.ts` | AI interaction metadata (char counts/latency only — never prompt/response text) |
| | `src/capture/redactText.ts` | `compileRedactPatterns` from `lalog.redactPatterns` |
| **UI** | `src/ui/panelView.ts` | Sessions/Insights tabs, Now box footer (pause/resume/end), session rows, project filter chips |
| | `src/ui/statusBar.ts` | Status bar item + quick-actions menu |
| **Reporting** | `src/reporting/report.ts` | Markdown report generation, scoping |
| | `src/reporting/insights.ts` | Pure aggregations: totals, in/out split, per-project/day, hour timeline (`insightsFor`, `effectiveMs`) |
| | `src/reporting/ranges.ts` | Range math (today/week/month/31-day) |
| | `src/reporting/aggregate.ts` | `todayActiveMs`, `todayUntrackedMs` |
| | `src/reporting/spans.ts` | Report-span helpers |
| **Integrations** | `src/integrations/git.ts` | `annotateSessionWithGit` — branch + commit subjects on close |
| | `src/integrations/legacyExport.ts` | `files_by_day.txt` export |
| **opencode (AI)** | `src/opencode/service.ts`, `bridge.ts`, `runTransport.ts` | Runs the local `opencode` CLI, JSON-line transport, retries/timeouts |
| | `src/opencode/prompts.ts` | Prompt templates for description drafting |
| | `src/opencode/redact.ts`, `modelPolicy.ts`, `types.ts` | Data-policy redaction, model allowlist/contract, request types |
| **Tests** | `test/*.test.ts` | node:test, bundled by `esbuild.test.js`. `stateMachine`, `spans`, `trim`, `sessionStore`, `projects`, `insights`, `diffCapture`, `terminalCapture`, `aiLog`, `redactText`, `technicalStore`, `opencode` |
| **Docs** | `docs/` | `features.md` (behavior), `architecture.md` (diagrams), `decisions.md` (ADRs), `data-format.md`, `development.md`, `roadmap.md` |
| **Build** | `esbuild.js`, `esbuild.test.js`, `package.json` | Bundle to `dist/`, tests to `dist-test/`, `vsce package` for `.vsix` |

## Common tasks → where to go

| Task | Path |
|------|------|
| Change when/what prompts appear (describe/wrap/progress/idle) | `sessionManager` schedule + `stateMachine` thresholds + `promptCoordinator` methods |
| Change the describe prompt UX | `src/prompts/describeFlow.ts` |
| Remove/user-out a prompt | delete from `src/prompts/promptCoordinator.ts` + its callers in `sessionManager`; keep `endSession` prompt-free |
| End / close / restart a session | `SessionManager.endSession`, `endAndRestart`, `startFresh` (`src/core/sessionManager.ts`) |
| Add a setting / time gate | `package.json` contributes + `src/core/config.ts` (`LaLogConfig`, `ThresholdsMs`) |
| Change what's captured | `src/capture/*` + toggles in `sessionManager` constructor |
| Change report/insights output | `src/reporting/*` (pure, testable) |
| Change sessions view UI | `src/ui/panelView.ts` |
| Add AI behavior | `src/opencode/*`, gated by `lalog.ai.enabled` |
| Describe an upcoming ADR/diagram change | `docs/decisions.md` / `docs/architecture.md` |

## Key invariants (don't break)

- **Never ask about closed sessions** (ADR-017 + ADR-019). No prompt at end/restart/wrap-close/idle-end. `endSession` closes silently.
- **Never lose a typed description.** The describe flow is text-first on purpose; the task-type picker must pre-select a default (`quickPickWithDefault`), because `showQuickPick` without a selection returns `undefined` on Enter.
- **Never untracked.** Every event starts a session if none is open (`ensureSessionOnActivity`); sessions always auto-start on `openWorkspace`.
- **Local-first / zero telemetry** (ADR-005). AI data policy: only compact summaries, never file contents / stdout / prompt-response text.
- **Only one prompt at a time**, min spacing, never blocking (PromptCoordinator mutex).
- Reporting derives everything at render time from the append-only `sessions.jsonl`; don't cache derived aggregates.

## Commands

- `npm run typecheck`, `npm test`, `npm run build`, `npm run watch`, `npm run package` (see `package.json`).