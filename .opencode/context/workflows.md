# Workflows

The full narrative for each flow (with diagrams) is in
[`docs/architecture.md`](../../docs/architecture.md) — *Session Lifecycle*, *Prompt
Flow*, *Recovery Model*, *Data Flow*. This file is the short version: enough to know
which files a trace touches.

---

## 1. Activation

`activate()` → build paths + `ensureDirs` → `SessionStore` / `TechnicalStore` /
`SessionManager` / `ProjectRegistry` → status bar + panel → register commands →
`manager.start()` → startup sweeps (diff retention prune, per-workspace project
resolution, `.pre-split.bak` split, dangling-`projectId` heal) → `openWorkspace()`
auto-starts a session.

Files: `src/extension.ts`, `src/storage/*`, `src/core/sessionManager.ts`.

## 2. An activity event becomes tracked time

VS Code listener (`core/activityTracker.ts`) → `SessionManager.onActivityEvent` →
`ensureSessionOnActivity` (start a session if none — never untracked) →
`stateMachine.onActivity(m, now, th)` decides the state →
`accrueActivity` extends the active span via `core/spans.ts` →
`syncSessionActive` → periodic `saveActive` snapshot (60s).

Idle gaps larger than `idleGap` accrue nothing — that is the whole active-only model
(ADR-003). `now` is threaded down; pure modules never read the clock.

Files: `core/activityTracker.ts`, `core/sessionManager.ts`, `core/stateMachine.ts`,
`core/spans.ts`, `storage/sessionStore.ts`.

## 3. Breakpoint-aligned prompting

`core/breakpoints.ts` detects a natural pause (terminal command ended, git commit, debug
terminated, return from idle) → `SessionManager.onBreakpoint` →
`schedulePrompt('describe' | 'wrap')` → `promptCoordinator.acquire()` gates on mutex +
min spacing → `describeFlow` (InputBox first, then task-type QuickPick with a
pre-selected default) or the wrap QuickPick.

Prompts are *held*, never fired on a timer. Nothing here may ask about a closed session.

Files: `core/breakpoints.ts`, `core/sessionManager.ts`,
`prompts/promptCoordinator.ts`, `prompts/describeFlow.ts`.

## 4. Idle confirmation and trimming

Heartbeat → `checkIdle` → past `idleConfirmAfterMinutes` → "Are you still there?"
"Still working" → `accrueOutsideConfirmed` bills the stretch as outside-VS-Code time
(classified at report time). "I was away" → `trimIdleAwayWindow` → `trimToCutoff` rewrites
the open span so the phantom is not billed.

Files: `core/sessionManager.ts`, `core/spans.ts`, `prompts/promptCoordinator.ts`.

## 5. Closing a session

`endSession(reason)` (command, wrap choice, auto-close, stale cutoff, `deactivate`) →
clear timers → git annotation via `integrations/git.ts` (branch + commit subjects) →
`sessionStore.close()` appends the final line to `sessions.jsonl` → sidecar finalized in
`technical/<id>.jsonl`. `autoClose` uses `lastActivityAt`, never wall-clock (ADR-007);
stale cutoff is hard with no continuation (ADR-022).

Files: `core/sessionManager.ts`, `storage/sessionStore.ts`,
`storage/technicalStore.ts`, `integrations/git.ts`.

## 6. Crash recovery

On activation, `loadActive()` reads `active/<key>.json`; if a snapshot exists, it is
reconciled into a closed session (`finishRecovered`) — a snapshot is a live session, not
a record of intent.

Files: `core/sessionManager.ts`, `storage/sessionStore.ts`, `storage/store.ts`.

## 7. Rendering: panel, documents, reports, exports

Nothing is cached. `store.loadAll()` → pure functions:
`reporting/insights.ts` (totals, per-day/hour timeline with session identity),
`reporting/sessionDetail.ts` (`renderSessionDetail` → untitled markdown preview;
`renderDayDiffs` → one day of file changes), `reporting/report.ts` (markdown),
`reporting/pdfReport.ts` + `pdf.ts` (PDF). Day bucketing always via `dayKey()`.

Files: `src/reporting/*`, `src/ui/panelView.ts`, `src/extension.ts`
(`lalog.sessionDetail`, `lalog.dayDiffs`, `lalog.report`, `lalog.exportCsv`,
`lalog.exportPdf`).

## 8. AI paths (only when enabled)

`extension.ts` lazily builds `LaLogAiService` → `opencode/runTransport.ts` spawns the
local `opencode` CLI over JSON lines (timeout + retry from `AiConfig`) →
`opencode/redact.ts` / `modelPolicy.ts` constrain what is sent → result is shown for
approval or appended to a report, always labeled AI-generated; interaction metadata only
is written to the sidecar via `manager.logAiInteraction`.

Human-authored descriptions and base reports never depend on AI availability.

Files: `src/opencode/*`, `src/extension.ts`, `src/core/sessionManager.ts`.

## 9. Testing a change

Add or extend a file in `test/userStories/`, reuse `test/helpers/harness.ts`, drive time
with `tick()`. Then `npm run typecheck && npm test`. To exercise real timing gates, set
`lalog.debugTimeScale` (ADR-008) rather than waiting.