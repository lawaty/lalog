# Architecture Decision Records

[Home](README.md) > **decisions**

> Why Worklog is built the way it is. Each decision records the context, options considered, and rationale.

---

## Table of Contents

- [ADR-001: Sessions Are NOT Day-Bound](#adr-001-sessions-are-not-day-bound)
- [ADR-002: Session-Centric Reporting](#adr-002-session-centric-reporting)
- [ADR-003: Gap-Based Active Time Model](#adr-003-gap-based-active-time-model)
- [ADR-004: JSONL Append-Only Storage](#adr-004-jsonl-append-only-storage)
- [ADR-005: Local-Only / Zero Telemetry](#adr-005-local-only--zero-telemetry)
- [ADR-006: Breakpoint-Aligned Prompt Delivery](#adr-006-breakpoint-aligned-prompt-delivery)
- [ADR-007: Auto-Close Uses lastActivityAt](#adr-007-auto-close-uses-lastactivityat)
- [ADR-008: debugTimeScale for Testing](#adr-008-debugtimescale-for-testing)
- [ADR-009: Heartbeat + Snapshot Persistence](#adr-009-heartbeat--snapshot-persistence)
- [ADR-010: The Only Boundary Is ~2h Idle](#adr-010-the-only-boundary-is-2h-idle)
- [ADR-011: Optional AI Assistance (amends ADR-005)](#adr-011-optional-ai-assistance-amends-adr-005)
- [ADR-012: Active-Only Tracking with Idle Confirmation](#adr-012-active-only-tracking-with-idle-confirmation)
- [ADR-013: Anonymous Sessions as a Conscious Choice](#adr-013-anonymous-sessions-as-a-conscious-choice)
- [ADR-014: Projects as a Derived Workspace Registry](#adr-014-projects-as-a-derived-workspace-registry)
- [ADR-015: Insights as Pure Aggregations](#adr-015-insights-as-pure-aggregations)
- [ADR-016: Describe Before Exit via Focus-Loss Prompt (removed)](#adr-016-describe-before-exit-via-focus-loss-prompt-removed)
- [ADR-017: Never Prompt About a Closed Session](#adr-017-never-prompt-about-a-closed-session)
- [ADR-018: Technical Detail Capture](#adr-018-technical-detail-capture)
- [ADR-019: No Description Prompts on Close + Text-First Describe](#adr-019-no-description-prompts-on-close--text-first-describe)
- [ADR-020: Remove the Describe-Before-Exit Prompt](#adr-020-remove-the-describe-before-exit-prompt)
- [ADR-021: Remove the On-Start Description Prompt](#adr-021-remove-the-on-start-description-prompt)

---

## ADR-001: Sessions Are NOT Day-Bound

**Status**: Accepted

**Context**: Most time-tracking tools split sessions at midnight. A coding session from 22:00 to 02:00 becomes two sessions: "Sep 3, 22:00–23:59" and "Sep 4, 00:00–02:00". This fragments the narrative.

**Decision**: Sessions are continuous engagement threads. They span midnight, weekends, and holidays. The only boundary is ~2h idle.

**Rationale**:
- A coding session is a cognitive thread, not a calendar event
- Splitting at midnight breaks the narrative: "What was I working on?" becomes two separate questions
- Overnight sessions are common (late-night debugging, weekend projects)
- Reporting can still group by day (start-date attribution) without splitting the session

**Implementation**:
- `Session.startedAt` and `Session.endedAt` are absolute timestamps, not day-bound
- Reports attribute sessions to the day they started (see [ADR-002](#adr-002-session-centric-reporting))
- The `files_by_day.txt` export handles midnight-spanning sessions by listing files under both days if edits happened on both

**Test coverage**: `test/stateMachine.test.ts` includes an "overnight session spanning midnight" test that verifies `startedAt` doesn't change across midnight.

---

## ADR-002: Session-Centric Reporting

**Status**: Accepted

**Context**: Reports can be organized by day (time spent on each day) or by session (what got done in each engagement thread).

**Decision**: Reports are session-centric. Sessions are never split across days or months. A session that starts at 23:00 and ends at 01:00 appears entirely under the day it started.

**Rationale**:
- Sessions are the unit of work, not days
- "What did I do this week?" is better answered by listing sessions than by aggregating daily totals
- Start-date attribution is simpler and more intuitive than split attribution
- The `files_by_day.txt` export provides a day-based view for downstream consumers that need it

**Implementation**:
- `generateReport()` filters sessions by `startedAt` within the range
- Sessions are listed chronologically, each showing start/end time, duration, workspace, type, description, top files, git branch, and commits
- Reports are saved to `~/.lalog/reports/YYYY-MM.md` (monthly file)

---

## ADR-003: Gap-Based Active Time Model

**Status**: Accepted

**Context**: Active time can be measured by:
1. **Interval timers** — `setInterval` every second, increment a counter
2. **Event gaps** — measure time between events, only count gaps < threshold
3. **Heartbeat** — periodic "are you there?" pings

**Decision**: Use event gaps. Active time is computed from the time between consecutive events. Only gaps < `idleGap` (default 5 min) count as active.

**Rationale**:
- **Never trust interval timers** — `setInterval` is unreliable (throttled in background, paused when laptop sleeps)
- **Event gaps are ground truth** — if you're typing, saving, running commands, you're active
- **Idle detection is natural** — a 10-minute gap means you stepped away, not that you worked for 10 minutes
- **No false positives** — interval timers can count "active" time when you're actually AFK

**Implementation**:
```typescript
// In stateMachine.onActivity():
if (m.lastActivityAt !== null) {
  const gap = now - m.lastActivityAt;
  if (gap < th.idleGap) {        // idleGap default: 5 min
    m.activeMinutes += gap;
  }
}
m.lastActivityAt = now;
```

**Edge cases**:
- First event after session start: no gap to measure, so no accrual
- First event after recovery: `lastActivityAt` is reset to `now` to avoid accruing a giant gap
- Idle gap ≥ 2h: session auto-closes (see [ADR-007](#adr-007-auto-close-uses-lastactivityat))

---

## ADR-004: JSONL Append-Only Storage

**Status**: Accepted

**Context**: Session data can be stored in:
1. **SQLite** — relational, queryable, but requires a binary dependency
2. **JSON files** — human-readable, but read-modify-write is not crash-safe
3. **JSONL (JSON Lines)** — append-only, human-readable, grep-friendly

**Decision**: Use JSONL for closed sessions, atomic JSON snapshots for active sessions.

**Rationale**:
- **Crash-safe** — append-only means no partial writes corrupt the file
- **Human-readable** — `cat sessions.jsonl | jq .` works
- **Grep-friendly** — `grep '"workspaceKey":"abc"' sessions.jsonl`
- **No dependencies** — pure Node.js `fs` module, no SQLite binary
- **Append-only** — no read-modify-write cycles for normal operation
- **Exception**: `updateSession()` rewrites the full file (used by "Edit session" command) — acceptable because edits are rare

**Implementation**:
- `appendLine(file, data)` — POSIX near-atomic append (open, write, close)
- `saveSnapshot(file, data)` — atomic write (write `.tmp` → rename)
- `streamLines(file, onLine)` — streaming reader that skips malformed lines

**Active sessions**: Stored as atomic JSON snapshots in `~/.lalog/active/<wsKey>.json`. Deleted when session closes.

---

## ADR-005: Local-Only / Zero Telemetry

**Status**: Accepted

**Context**: Many VS Code extensions phone home for analytics, crash reporting, or cloud sync.

**Decision**: LaLog is 100% local. All data stays in `~/.lalog/`. No telemetry, no cloud sync, no external services.

**Rationale**:
- **Privacy** — work logs contain sensitive information (file paths, commit messages, descriptions)
- **Simplicity** — no network code, no auth, no sync conflicts
- **Reliability** — works offline, no server downtime
- **User control** — data is in plain files, user can backup/sync however they want (e.g., point `lalog.dataDir` at a synced folder for Remote-SSH)

**Implementation**:
- No `fetch()`, no `http`, no telemetry SDK
- All storage is local filesystem
- `lalog.dataDir` can be pointed at a synced path for cross-machine sync (user's responsibility)

---

## ADR-006: Breakpoint-Aligned Prompt Delivery

**Status**: Accepted

**Context**: Prompts can be delivered:
1. **On fixed timers** — every 90 minutes, show a prompt
2. **On breakpoints** — wait for a natural pause (terminal command ends, debug session terminates, return from idle)

**Decision**: Deliver prompts at natural breakpoints. Hold the prompt until a breakpoint arrives, or force it after 30 minutes.

**Rationale**:
- **Don't interrupt flow** — a prompt in the middle of typing is annoying
- **Natural pauses exist** — terminal commands end, debug sessions terminate, you return from a break
- **30-minute force** — if no breakpoint arrives, the prompt is forced (user is probably stuck or forgot)

**Implementation**:
- `BreakpointDetector` listens for:
  - `onDidEndTerminalShellExecution` → `terminal` or `git-commit` breakpoint
  - `onDidTerminateDebugSession` → `debug` breakpoint
  - `checkReturnIdle()` on each activity → `return-idle` breakpoint
- `SessionManager.schedulePrompt()` sets a force timer (30 min after prompt threshold)
- When a breakpoint arrives, if a prompt is pending, deliver it immediately

---

## ADR-007: Auto-Close Uses lastActivityAt

**Status**: Accepted

**Context**: When a session auto-closes (idle ≥ 2h), what should `endedAt` be?
1. **Detection time** — `endedAt = now` (when the idle was detected)
2. **Last activity** — `endedAt = lastActivityAt` (when the user last did something)

**Decision**: `endedAt = lastActivityAt`. The session ended when the user stopped working, not when we noticed.

**Rationale**:
- **Accuracy** — the session didn't continue for 2h after you stopped; it ended when you stopped
- **Reporting** — reports show accurate end times
- **Consistency** — `activeMinutes` doesn't include the idle gap, so `endedAt` shouldn't either

**Implementation**:
```typescript
// In stateMachine.autoClose():
export function autoClose(m: Machine, now: number): { activeMinutes: number; endedAt: number } {
  const endedAt = m.lastActivityAt ?? now;
  return { activeMinutes: m.activeMinutes, endedAt };
}
```

**Test coverage**: `test/stateMachine.test.ts` includes an "autoClose uses lastActivityAt not detection time" test.

---

## ADR-008: debugTimeScale for Testing

**Status**: Accepted

**Context**: Testing a "4-hour session" requires waiting 4 hours. This is impractical for development and automated tests.

**Decision**: Provide a `lalog.debugTimeScale` setting that divides all time thresholds by a factor. Set it to 60 to test a 4-hour session in 4 minutes.

**Rationale**:
- **Fast iteration** — developers can test the full session lifecycle in minutes
- **No code changes** — just a settings change, no conditional logic in the code
- **Consistent scaling** — all thresholds scale together, so the relative timing is preserved

**Implementation**:
```typescript
// In config.ts:
export function thresholdsMs(cfg: WorklogConfig): ThresholdsMs {
  const scale = cfg.debugTimeScale || 1;
  const m = (min: number) => Math.round((min * 60 * 1000) / Math.max(1, scale));
  return {
    idleGap: m(cfg.idleGapMinutes),
    describeAt: m(cfg.describeAfterMinutes),
    // ... all thresholds scaled
  };
}
```

**Usage**: Set `lalog.debugTimeScale: 60` in VS Code settings. Now:
- 90-minute describe prompt → 90 seconds
- 210-minute wrap prompt → 210 seconds (3.5 minutes)
- 2-hour auto-close → 2 minutes

**Test coverage**: `test/stateMachine.test.ts` uses real thresholds (not scaled) to test the state machine in isolation.

---

## ADR-009: Heartbeat + Snapshot Persistence

**Status**: Accepted

**Context**: Active sessions need to survive VS Code restarts, crashes, and window closes.

**Decision**: Persist active sessions as atomic JSON snapshots every 60 seconds (heartbeat) and on every state change.

**Rationale**:
- **Crash recovery** — if VS Code crashes, the snapshot is at most 60 seconds old
- **State change persistence** — important transitions (describe, wrap) are persisted immediately
- **Atomic writes** — write to `.tmp` → rename, so a crash mid-write doesn't corrupt the snapshot
- **No zombie sessions** — any leftover snapshot (abnormal exit only) is auto-closed on load, never resumed

**Implementation**:
- `SessionManager.scheduleSave()` — called on every state change
- `SessionManager.heartbeatTimer` — `setInterval` every 60 seconds
- `SessionStore.saveActive(session)` — atomic snapshot write
- `SessionStore.loadActive(wsKey)` — load snapshot on recovery

**Recovery flow** (see ADR-017 — past sessions are never re-probed):
1. Load snapshot
2. Auto-close as `recovery-skip` (`endedAt = lastActivityAt`) — no prompt
3. Start a fresh session

---

## ADR-010: The Only Boundary Is ~2h Idle

**Status**: Accepted

**Context**: Sessions can be bounded by:
1. **Day boundaries** — midnight splits sessions
2. **Fixed duration** — sessions auto-close after 4h
3. **Idle time** — sessions auto-close after 2h of no activity

**Decision**: The only boundary is ~2h idle. Sessions are not day-bound, not duration-bound. They continue as long as the user is active.

**Rationale**:
- **Cognitive threads** — sessions represent engagement, not calendar time
- **Overnight sessions** — common for debugging, weekend projects
- **User control** — the user can manually end a session anytime
- **Idle is the natural boundary** — if you stop for 2h, the session is effectively over

**Implementation**:
- `lalog.autoEndAfterIdleMinutes` (default 120) — idle time before auto-close
- `stateMachine.autoClose()` — returns `endedAt = lastActivityAt`
- `SessionManager.openWorkspace()` — auto-closes any leftover snapshot on recovery (see ADR-017)

**Edge cases**:
- **Restart vs. crash** — a session only survives to "recovery" through an abnormal exit; normal quits end it as `vscode-shutdown`, so a reopen always starts fresh
- **Leftover snapshot** — always closed as `recovery-skip` without prompting, then a fresh session starts

---

## ADR-011: Optional AI Assistance (amends ADR-005)

**Status**: Accepted · **Amends**: [ADR-005](#adr-005-local-only--zero-telemetry)

**Context**: ADR-005 committed LaLog to "100% local, no AI". Revisiting that, the user wants optional AI assistance to reduce the friction of writing session descriptions, enrich reports, and surface work patterns (wins, improvements, stalls). The tension is that ADR-005's promise ("nothing leaves the machine") is incompatible with a cloud model. The chosen model, `opencode/big-pickle`, is cloud-hosted on OpenCode Zen and, during its free period, its data may be used to improve the model.

**Decision**: Keep AI **optional and off by default**, and amend the local-only philosophy to **"local-first, AI-optional, egress-explicit"**. The core (tracking, state machine, storage, base reports) stays 100% local and AI-free and never depends on the AI. AI lives in a separate one-way module (`src/opencode/*`) that is only instantiated when `lalog.ai.enabled` is true. AI output is always labeled as AI-generated and is never silently persisted as ground truth — the human remains the author of record.

**Egress contract** (what the AI can see):
- Sent: workspace name, edit/save/terminal counts, file paths, git branch, commit subjects (toggleable).
- Never sent: file contents, terminal output, commit diffs/bodies, anything at all while AI is disabled.

**Transport**: A one-shot `opencode run --format json` subprocess (spawn, no shell — preventing prompt-argument injection). No server, no ports, no auth storage; model credentials come from the user's own `opencode auth login`. The model is pinned to `opencode/big-pickle` by default but is a setting, because it is a stealth, promotional "free for a limited time" model that may be renamed or retired.

**Rationale**:
- Human descriptions remain the source of truth; AI produces **drafts/narratives/analyses**, never automatic replacements.
- `spawn` with `stdio: ['ignore','pipe','pipe']` is used because `execFile`/`exec` were found to hang waiting on `opencode run`.
- The dependency is one-way: `src/opencode/*` may import from `src/core` and `src/reporting`; nothing in `core`/`reporting` imports `src/opencode`. With AI disabled, no opencode code path is even instantiated.

**Implementation**:
- `src/opencode/` — `bridge.ts`, `runTransport.ts`, `prompts.ts`, `redact.ts`, `modelPolicy.ts`, `service.ts`, `types.ts`.
- Settings under `lalog.ai.*`; the `lalog.analysis` command and describe-flow "Draft with AI" option are gated on `lalog.ai.enabled`.
- Tested end-to-end against the real `opencode` CLI with `opencode/big-pickle`.

**Future**: The deliberately-deferred live "proactive suggestions" and managed `opencode serve` lifecycle are covered later and remain experimental (see roadmap).

---

## ADR-012: Active-Only Tracking with Idle Confirmation

**Status**: Accepted

**Context**: Session time must equal the user's real engagement, never `close_time − start_time` (a session left open over lunch would inflate hours). But "active" is ambiguous — a user can be engaged *outside* VS Code (reading docs, reviewing a branch) while idle in the editor. LaLog also previously stored `activeMinutes` in inconsistent units (accrued as milliseconds but consumed as minutes), inflating reported durations ~60000×.

**Decision**:
1. **Active-only time**: `Session.activeMinutes` is the sum of gap-based active runs (contiguous activity ≤ `idleGapMs` apart), stored as **milliseconds**.
2. **Idle confirmation**: after `idleConfirmAfterMinutes` (15) of no VS Code activity, the heartbeat fires "Are you still there?". *Yes* keeps the current span open — the idle stretch is counted as active, but is **not** VS Code activity. *I was away and came back* trims the idle window back to the moment the prompt was asked (so time spent away after the prompt doesn't count) and keeps the session running. *No* ends the session, also trimming to the prompt moment first. This makes confirmed-outside work count while keeping it separable.
3. **Untagged spans, classified at filter time**: `Session.activeSpans` store contiguous runs without a source tag. A span is *in VS Code* iff its `end` timestamp is present in `Session.activityTs` (outside spans end at a confirmation timestamp, never at a recorded activity). Legacy sessions without spans are reconstructed from `activityTs` gap analysis.

**Rationale**:
- Storing spans without source keeps persistence simple and append-only; classification happens only when a report is generated, so it can change without rewriting history.
- Checking `end ∈ activityTs` is cheap and deterministic, and directly encodes "the last thing that happened during this run was VS Code activity".
- Confirming idle as active acknowledges that "are you still working?" is the right human question and avoids the false negative of counting nothing.

**Implementation**:
- `src/core/spans.ts` (`updateActiveSpan`), `src/core/sessionManager.ts` (`accrueActivity`, `checkIdle`, `accrueOutsideConfirmed`, `closeOpenSpanAt`), `src/reporting/spans.ts` (`splitActiveMinutes`).
- `Session.activityTs` capped at 20 000 entries to bound file size; older entries are dropped oldest-first (span classification then falls back to gap analysis for those spans individually).
- Unit fix: `activeMinutes` is milliseconds end-to-end; all `* 60000` consumers (report, aggregate, sessions view, status bar, prompts, redact) corrected in the same change.

**Test coverage**: `test/spans.test.ts` — span open/extend/close, in/outside classification, legacy reconstruction, confirmed-idle-outside, and a round-trip run.


## ADR-013: Anonymous Sessions as a Conscious Choice

**Status**: Accepted

**Context**: LaLog tracks continuously and asks for descriptions, but not every stretch of work deserves a label — yet the periodic describe/progress prompts treat every session alike. Nagging a user about cleanup sessions (deleting a branch, fiddling with CI) trains them to dismiss prompts. The user asked for a way to say *"record what I did, but keep it anonymous."*

**Decision**:
1. **`Session.anonymous` flag**: a session can be marked anonymous ("background work") — from the describe checkpoint's **Keep as background work** option, the panel detail action, or the status-bar quick action (`lalog.background`).
2. **Anonymous sessions are never prompted**: the describe checkpoint (`checkProgress`) skips them; the wrap prompt still applies but hides its "Add/update description" option.
3. **Describing clears the flag**: any real description (checkpoint, progress note, or edit) sets `anonymous = false`, so labeling and prompting resume normally. A manual `Describe now` on an anonymous session always works — the flag only suppresses *automatic* prompting.

**Rationale**:
- The choice happens at decision time rather than being toggled silently, so the user never "loses" tracking — anonymous still records time, events, and files; it only stops the labeling prompts.
- Clearing on describe keeps the flag an explicit, reversible statement, avoiding permanently-dimmed sessions the user forgot about.

**Implementation**: `src/core/types.ts` (`anonymous`), `src/core/sessionManager.ts` (`applyBackgroundWork`, guards in `checkProgress`/`presentDescribe`), `src/prompts/promptCoordinator.ts` + `describeFlow.ts` (describe-checkpoint `background` choice, wrap option hidden when anonymous), `src/ui/panelView.ts` (dimmed `○` state, "Keep as background work" row action), `src/extension.ts` (`lalog.background`).

**Test coverage**: manual (panels/prompts not host-testable); pure helpers covered via `test/projects.test.ts`/`test/insights.test.ts` for reporting of anonymous sessions (`*(background work)*`).


## ADR-014: Projects as a Derived Workspace Registry

**Status**: Accepted

**Context**: "Projects" let many workspaces share a name and color (the same repo cloned twice, a design repo + a backend repo for one product). Storing a `projectId` on every session is a migration; asking an AI to infer projects is over-engineered. GLM's review suggested a *flat registry* keyed on workspace identity, derived at read time.

**Decision**:
1. **`ProjectRegistry`** keeps the curated list in a small JSON file (`~/.lalog/projects.json`, version 1) — separate from the append-only `sessions.jsonl`, rewritten atomically via tmp+rename (same pattern as active snapshots).
2. **Derive-on-read**: `resolveProject(session, projects)` maps a session by its `workspaceKey` when that key is claimed by *exactly one non-archived* project. No session data is rewritten when projects change.
3. **Explicit override wins**: `Session.projectId` (set from the panel's assign picker) beats any derived claim — including archived projects — so a "wrong" auto-match can be corrected per session without touching the registry.
4. **Archiving** removes a project from derivation (its explicit assignments and history stay); `PROJECT_COLORS` (10-color palette) picks stable colors by creation index.

**Rationale**:
- Derivation means projects can be created, renamed, archived, and re-claimed with zero migration of the append-only log — the JSONL stays immutable.
- A single workspace key matching one project is unambiguous; multiple claims are only resolvable by explicit per-session override or by a curated pick, which is what the UI offers.

**Implementation**: `src/core/projects.ts` (pure `Project`, `resolveProject`, palette), `src/storage/projectRegistry.ts` (CRUD + atomic save), `src/ui/panelView.ts` (Projects tab, chips, assign picker, claim/archive actions), `src/reporting/report.ts` + `insights.ts` (scoping by `resolveProject`).

**Test coverage**: `test/projects.test.ts` — derivation, archived exclusion, explicit-override precedence, color palette.


## ADR-015: Insights as Pure Aggregations

**Status**: Accepted

**Context**: The user wants "a glimpse on what takes most of my time" without opening a report file, and an hourly report "whenever I want". Range math and aggregates were previously entangled in `report.ts`, which imported the vscode-bound prompt coordinator — making them untestable and forcing a dataset/profile cycle (`insights.ts → report.ts → insights.ts`).

**Decision**:
1. **Pure aggregation module** `src/reporting/insights.ts`: `insightsFor()` turns closed (+ the live session) `Session[]` + `Project[]` into a UI-ready snapshot (totals, in/out split, per-project, per-day, top files, 24-cell day timeline). `effectiveMs()` adds a live session's tail capped at the idle gap; `hourlyBreakdown()` gives the report its per-hour lines.
2. **Range math moved to pure `src/reporting/ranges.ts`** and re-exported by `report.ts` — breaking the insight↔report cycle and letting tests import aggregates without the vscode-bound module.
3. **Live session included**: the in-progress session joins today's insights/report figures with its idle-gap-capped tail, so "today" is always right while you work.
4. **Report UX**: range picker gains a 31-day custom range; next picker scopes to any project; single-day ranges print the hourly log; `saveReport` writes date-prefixed, non-overwriting files (`reports/<start-date>-<rangekey>[-<slug>].md`, local date), so each period/custom range gets its own file instead of overwriting the month's.

**Rationale**:
- Aggregates over plain data with `now`/`idleGap` injected are deterministic and unit-testable in node without VS Code — the whole panel/report stack feeds off one aggregation layer.
- Deriving everything at render time keeps the append-only log the single source of truth (classifying a span, resolving a project, and injecting the live tail all happen when a snapshot/report is built).

**Implementation**: `src/reporting/ranges.ts` (pure), `src/reporting/insights.ts` (aggregates + timeline + hourly log), `src/reporting/report.ts` (scoping, custom range, hourly log, filenames), `src/ui/panelView.ts` (Insights tab, timeline cells, period toggle), `src/extension.ts` (`lalog.report` rework, CSV export).

**Test coverage**: `test/insights.test.ts` — effectiveMs tails/cap, per-range totals, per-project aggregation with explicit+derived mapping, vscode/outside split, 24-hour timeline, hourly breakdown, month boundaries.

## ADR-016: Describe Before Exit via Focus-Loss Prompt (removed)

**Status**: Superseded by ADR-020 — removed entirely.

**Context**: The user reported being asked to describe "the previous session" on every VS Code launch, by which point context is cold — they wanted the question asked *before* exiting, like VS Code's unsaved-changes prompt. There is **no stable pre-shutdown extension API** (`workspace.onWillShutdown` is a proposed API only; `deactivate()` is synchronous and time-limited), so a blocking close dialog is impossible in a published extension.

**Decision** (historical — the feature was removed in ADR-020):
1. **Focus-loss trigger** `src/core/sessionManager.ts::onWindowFocusLost()`: subscribed to `window.onDidChangeWindowState` in `activate()`; when the window loses focus (~about to exit) and the live session is already due-for-description, `presentDescribe(null)` runs immediately while context is fresh.
2. **Conservative guard** `src/core/focusPrompt.ts::shouldPromptOnFocusLost()`: only `describePending` sessions without a description (and not anonymous) trigger — a quick alt-tab never nags.
3. **Per-session cooldown** (`focusPrompted`): the prompt fires at most once per describe-due window; reset on a fresh session and after `described`/`background`.
4. **No startup fallback**: the launch-time `describeShutdownSession()` fallback (recovering descriptions of crash/force-quit sessions) was removed by ADR-017 — LaLog never asks about a closed session again.

**Rationale**: The focus-loss event is the closest stable proxy for "about to quit"; it fires before process death, letting the user answer in-context. The conservative guard + cooldown keep it quiet. (The original rationale also relied on the startup fallback for lost descriptions; per ADR-017 the user explicitly prefers never being asked retroactively, so a missed focus-loss prompt is simply accepted.) Later experience showed the prompt still fired at the wrong moments (alt-tab, closing the window) — see ADR-020.

**Implementation** (historical): `src/core/focusPrompt.ts` (pure guard), `src/core/sessionManager.ts` (trigger + cooldown), `src/extension.ts` (event subscription), `test/focusPrompt.test.ts`.

**Test coverage** (historical): `test/focusPrompt.test.ts` — guard matrix (describe-due, no session, cooldown, anonymous, existing description, non-due states).

## ADR-017: Never Prompt About a Closed Session

**Status**: Accepted

**Context**: The user wants LaLog to **never** ask about a session that is already closed. Previously three paths did exactly that: (1) `describeShutdownSession()` offered an optional description for the most recent `vscode-shutdown`-ended session at every launch; (2) `finishRecovered()` asked a closing note for any leftover snapshot on recovery; (3) an auto-idle-ended session got an `offerPendingCloseNote()` closing note on the next activity. Separately, a leftover snapshot within `resumeWindowMinutes` (30 min) was resumed instead of closed.

**Decision**:
1. **No prompts about past sessions** — the startup shutdown-description prompt, the recovery closing-note prompt, and the pending-closing-note prompt are all removed (`askShutdownDescription`, `askClosingNote` deleted).
2. **Leftover snapshots always auto-close** — on launch, any active snapshot (only possible after an abnormal exit) is closed as `recovery-skip` with `endedAt = lastActivityAt`, **without prompting**, and a fresh session starts. The resume branch is removed along with `resumeWindowMinutes`/`recoverActiveMachine`.
3. **Closure is the only boundary** — a reopened window always begins a new session; a session left undescribed stays flagged (`needsDescription`) for the sessions view but is never re-probed.
4. **Explicit ends still ask** — `recordCloseNote` (`askSessionClose`) survives: the user is present at the moment they manually end/wrap a session, so a closing note there is not "about a closed session". *(Superseded by ADR-019 — even explicit ends no longer prompt.)*

**Rationale**: Descriptions are best gathered while a session is still live (checkpoint, progress notes). Once closed, context is gone and retroactive prompts were the exact complaint addressed here; any formatting gap is the user's accepted trade-off.

**Implementation**: `src/core/sessionManager.ts` (`openWorkspace`, `finishRecovered`, removal of `describeShutdownSession`/`pendingClose`/resume branch), `src/prompts/promptCoordinator.ts` (removed `askShutdownDescription`, `askClosingNote`), `src/core/config.ts` (removed `resumeWindowMinutes`). ADR-016's "startup fallback" is superseded.

**Test coverage**: typecheck + full suite (no runtime path change to pure modules).



## ADR-018: Technical Detail Capture

**Status**: Accepted

**Context**: LaLog's session model captures *counters* (edits, saves, terminal events) but not the *content* of work. A session showing "142 edits, 23 saves, 8 terminal commands" tells you *that* you worked but not *what* you did. Reports and AI descriptions lack the technical detail needed to reconstruct what actually happened.

**Decision**:
1. **Per-session sidecar JSONL** (`~/.lalog/technical/<sessionId>.jsonl`): technical detail lives in a separate file per session, not in the main `sessions.jsonl`. This keeps the main store compact (it stores counters, descriptions, git data) while preserving full technical context.
2. **File diffs at save time**: unified diffs are generated from successive file saves using the `diff` package. First save for a path produces a new-file diff; subsequent saves produce standard patches. Binary files (null byte in first 8KB) are skipped. Diffs are redacted and capped at 16,000 chars.
3. **Terminal capture via shell integration**: command line, exit code, duration, and cwd are always captured when `onDidStartTerminalShellExecution` is available (VS Code ≥ 1.93). Stdout capture is **opt-in** (`lalog.captureTerminalStdout`, default off) because: (a) `read()` must attach at command start to not miss data, (b) stdout may contain sensitive data, and (c) ANSI sequences are lossy to strip.
4. **AI interaction metadata only**: char counts, latency, model, and task name are logged. Prompt and response text are never stored — this maintains the data-policy contract that only compact summaries enter the AI.
5. **Six config toggles**: `captureDiffs`, `captureTerminal`, `captureTerminalStdout`, `captureAiLog`, `maxDiffChars`, `maxStdoutChars` — all independently controllable.

**Rationale**:
- **Sidecar vs main store**: diffs and terminal output are large and rarely needed for aggregate queries. A separate file avoids bloating `sessions.jsonl` (which is read in full for reports) while keeping technical detail available for drill-down and AI context.
- **Diffs at save time**: capturing at save (not edit) ensures the diff represents a deliberate checkpoint. The `diff` package produces standard unified patches that are human-readable and AI-parseable.
- **Stdout opt-in**: `TerminalShellExecution.read()` returns an `AsyncIterable` that must be consumed immediately in the start handler. This is a fire-and-forget async operation. Stdout may contain ANSI escape sequences that are stripped (lossy), and may contain sensitive data. The opt-in default protects users who don't want this level of detail.
- **AI log counts only**: storing prompt/response text would violate the local-first privacy model and bloat the sidecar. Char counts and latency are sufficient to understand AI usage patterns.
- **Map-based diff tracking**: the `DiffCapture` class keeps a `Map<string, string>` of last-saved content (capped at 100 paths with LRU eviction). This is in-memory only and resets on session end.

**Implementation**: `src/capture/diffCapture.ts`, `src/capture/terminalCapture.ts`, `src/capture/aiLog.ts`, `src/capture/redactText.ts` (pure modules), `src/storage/technicalStore.ts` (sidecar storage), `src/core/sessionManager.ts` (wiring), `src/opencode/service.ts` (AI interaction logging), `src/extension.ts` (service-to-manager wiring).

**Test coverage**: `test/diffCapture.test.ts` (first-save newFile, subsequent patches, binary skip, redaction, cap, reset, LRU), `test/terminalCapture.test.ts` (stripAnsi, confidence mapping, duration, stdout absent/capped/redacted, clearInFlight), `test/aiLog.test.ts` (shape, truncated passthrough), `test/redactText.test.ts` (compile, invalid skip, case-insensitive global), `test/technicalStore.test.ts` (append+read round-trip, rotation, malformed skip, delete, pathFor shape).

## ADR-019: No Description Prompts on Close + Text-First Describe

**Status**: Accepted

**Context**: Two UX problems surfaced in practice. (1) The "closing note" prompt (`askSessionClose` via `recordCloseNote`) asked "what did you get done?" whenever a session was explicitly ended, restarted, wrapped, or answered "end" on the idle check — a prompt the user wanted gone entirely. (2) The describe flow was two-step but asked the **task type via QuickPick first**: a typed description landed in the QuickPick's *filter box* and pressing Enter either matched the wrong type (discarding the text) or returned `undefined` (recorded as "skipped"). With no buttons anywhere, the description never submitted and the user could only skip.

**Decision**:
1. **No description prompts when a session closes** — `askSessionClose`/`recordCloseNote`/`endSessionWithNote` are deleted. Explicit end, end-restart, the idle-check "end", and wrap-new all close silently. `anonymous` and description state are whatever they were at close — sessions are never probed after closing (extends ADR-017 to explicit ends; supersedes ADR-017 item 4).
2. **Text-first describe flow** (`src/prompts/describeFlow.ts::runDescribeFlow`): the **InputBox comes first**, pre-filled with live session data (`buildPrefill`). **Enter saves the text immediately**; Esc only appears *after* text is confirmed, and an empty/Esc submission opens a small fallback QuickPick that keeps **Same as last**, **Draft with AI**, **Keep as background work**, and **Later** reachable without typing. After text is entered, a second QuickPick picks the task type with **"other" pre-selected** via the low-level `createQuickPick` (which supports `activeItems` — `showQuickPick` cannot) so Enter accepts the default instead of closing with `undefined`.
3. **Same reorder for the on-start prompt** (`askSessionStart`): InputBox first, then a `Keep as background work` / `Not now` fallback when skipped. All previously reachable outcomes (`described`, `background`, `later`) were preserved. *(Subsequently removed entirely — see ADR-021.)*

**Rationale**: A description typed into a filter box is lost by design — the only robust fix is to make the text box the first (and Enter-submittable) step. The low-level QuickPick is required only because the high-level `showQuickPick` has no `activeItems` option; without a pre-selected default, Enter on the type picker would close with `undefined` and silently drop the description all over again. Removing the close note keeps `endSession` side-effect free: it closes and reopens, nothing prompts.

**Implementation**: `src/prompts/promptCoordinator.ts` (deleted `askSessionClose`; reordered `askSessionStart` — subsequently removed, ADR-021), `src/prompts/describeFlow.ts` (text-first `runDescribeFlow`, `quickPickWithDefault` helper), `src/core/sessionManager.ts` (deleted `recordCloseNote`/`endSessionWithNote`; `endAndRestart`, `checkIdle`, `applyWrapResult` now call `endSession` directly), `src/extension.ts` (`lalog.endSession` → `manager.endSession`).

**Test coverage**: typecheck + full suite — the removed prompt paths had no pure-code unit tests, and the reorder keeps `DescribeResult`/`applyDescribeResult` shapes unchanged.

## ADR-020: Remove the Describe-Before-Exit Prompt

**Status**: Accepted

**Context**: ADR-016 added a focus-loss "describe before exit" prompt as the closest proxy for closing VS Code. In practice it still fired at the wrong moments: any focus loss (alt-tab, opening another app, the palette stealing focus) while a session was `describePending` surfaced the description prompt. The user no longer wants a description prompt at the moment of closing at all.

**Decision**:
1. **Delete the focus-loss trigger** — `onWindowFocusLost()` is removed from `SessionManager`, and the `window.onDidChangeWindowState` subscription is removed from `extension.ts`. Losing window focus no longer prompts anything.
2. **Delete the guard module** — `src/core/focusPrompt.ts` (`shouldPromptOnFocusLost`) and its test file are removed; the `focusPrompted` cooldown field and its resets are deleted.
3. **No replacement** — as with ADR-017/ADR-019, closing never asks about a description. The describe checkpoint remains the primary automatic description entry point while a session is live (the on-start prompt was subsequently removed — see ADR-021); anything undescribed stays flagged in the sessions view.

**Rationale**: A prompt that fires on alt-tab and window close alike is more annoying than helpful. The user prefers no prompt at closing; context for a description is best gathered while still working (checkpoint), never at the leave moment.

**Implementation**: `src/extension.ts` (removed `onDidChangeWindowState` subscription), `src/core/sessionManager.ts` (removed `onWindowFocusLost`, `focusPrompted`, focus import), deleted `src/core/focusPrompt.ts` and `test/focusPrompt.test.ts`.

**Test coverage**: typecheck + full suite — `focusPrompt.test.ts` removed with its module.

## ADR-021: Remove the On-Start Description Prompt

**Status**: Accepted

**Context**: ADR-006/ADR-013 added an optional on-start description prompt (`askSessionStart`) that fired ~5 minutes (`startDescriptionAfterMinutes`) after a session started, asking "Session started · <workspace> — what are you working on?". Combined with the focus-loss prompt removed in ADR-020, the user no longer wants any description prompt at the moment of opening VS Code — context is cold and the prompt interrupts the first thing they actually want to do.

**Decision**:
1. **Delete the on-start prompt** — `askSessionStart()` and the `StartPromptResult` type are removed from `PromptCoordinator`. The `scheduleStartDescription` / `offerStartDescription` / `clearStartDescription` / `applyStartDescription` methods and the `startDescTimer` / `startDescEligibleAt` fields are removed from `SessionManager`.
2. **Delete the config** — `lalog.askDescriptionOnStart` and `lalog.startDescriptionAfterMinutes` settings (and the `startDescAt` threshold) are removed.
3. **No replacement** — the describe checkpoint (~90 min), progress notes (hourly), manual edit, and the "Keep as background work" quick action remain as description entry points. Sessions that go undescribed stay flagged (`needsDescription`) in the sessions view.

**Rationale**: A prompt that fires minutes after opening VS Code interrupts the user before they've settled into work. The describe checkpoint at ~90 minutes provides context-rich description gathering without the interruption. The user prefers zero description prompts on open.

**Implementation**: `src/core/config.ts` (removed fields + threshold), `src/prompts/promptCoordinator.ts` (removed `askSessionStart`, `StartPromptResult`), `src/core/sessionManager.ts` (removed constructor param, timer fields, four methods, all call sites), `src/extension.ts` (removed constructor arg), `package.json` (removed config contributions), `test/sessionStore.test.ts` + `test/stateMachine.test.ts` (removed `startDescAt` from threshold literals).

**Test coverage**: typecheck + full suite — no runtime path change to pure modules; `startDescAt` removed from test threshold literals to satisfy the type.

---

## Related Pages

- [Architecture](architecture.md) — module overview and data flow
- [Features](features.md) — detailed feature documentation
- [Data Format](data-format.md) — JSONL schema and snapshot format
- [Roadmap](roadmap.md) — what's NOT built