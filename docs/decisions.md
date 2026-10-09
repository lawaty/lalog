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
- [ADR-022: Hard 1h Stale-Session Cutoff — No Continuation](#adr-022-hard-1h-stale-session-cutoff--no-continuation)
- [ADR-023: Confirmed Session Deletion (Full-File Rewrite, No Fallback)](#adr-023-confirmed-session-deletion-full-file-rewrite-no-fallback)
- [ADR-024: Hand-Rolled PDF Writer (Zero New Dependencies)](#adr-024-hand-rolled-pdf-writer-zero-new-dependencies)
- [ADR-025: Session Detail as an Untitled Markdown Document](#adr-025-session-detail-as-an-untitled-markdown-document)
- [ADR-026: Diffs-Only Technical Retention](#adr-026-diffs-only-technical-retention)
- [ADR-027: One Local Day Key Everywhere](#adr-027-one-local-day-key-everywhere)
- [ADR-028: Timeline Slots Carry Session Identity](#adr-028-timeline-slots-carry-session-identity)
- [ADR-029: A Single Implicit Workspace Project; Multi-Project Is Opt-In](#adr-029-a-single-implicit-workspace-project-multi-project-is-opt-in)
- [ADR-030: Per-Workspace Projects Replace the Single-Project Union](#adr-030-per-workspace-projects-replace-the-single-project-union)
- [ADR-032: opencode serve Activity Is Observed, Never Managed](#adr-032-opencode-serve-activity-is-observed-never-managed)
- [ADR-033: Reuse-First opencode serve Lifecycle, Owned or Not At All (amends ADR-032)](#adr-033-reuse-first-opencode-serve-lifecycle-owned-or-not-at-all-amends-adr-032)
- [ADR-034: opencode Chat Activity Is On by Default (amends ADR-032, ADR-033)](#adr-034-opencode-chat-activity-is-on-by-default-amends-adr-032-adr-033)

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

**Test coverage**: `test/userStories/tracking.test.ts` includes an "US-1.7 · overnight session is not day-bound" test that verifies `startedAt` doesn't change across midnight.

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

**Decision**: Use event gaps. Active time is computed from the time between consecutive events. Only gaps < `idleGap` (default 15 min) count as active.

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
  if (gap < th.idleGap) {        // idleGap default: 15 min
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

**Test coverage**: `test/userStories/tracking.test.ts` includes an "US-1.2 · idle gap not counted; endedAt = lastActivityAt" test.

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

**Test coverage**: `test/userStories/tracking.test.ts` exercises the pure state-machine and span helpers (`updateActiveSpan`, `trimToCutoff`, `isStale`) in isolation using real thresholds (not scaled); `test/userStories/privacyConfig.test.ts` covers the scaling itself (US-8.6).

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

**Test coverage**: `test/userStories/tracking.test.ts` — span open/extend/close, in/outside classification, legacy reconstruction, confirmed-idle-outside, and a round-trip run.

---

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

**Test coverage**: manual (panels/prompts not host-testable); pure helpers covered via `test/userStories/projects.test.ts`/`test/userStories/insightsReporting.test.ts` for reporting of anonymous sessions (`*(background work)*`).

---

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

**Test coverage**: `test/userStories/projects.test.ts` — derivation, archived exclusion, explicit-override precedence, color palette.

---

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

**Test coverage**: `test/userStories/insightsReporting.test.ts` — effectiveMs tails/cap, per-range totals, per-project aggregation with explicit+derived mapping, vscode/outside split, 24-hour timeline, hourly breakdown, month boundaries.

---

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

---

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

---

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

**Test coverage**: `test/userStories/capture.test.ts` — US-2.5 (first-save newFile, subsequent patches, binary skip, redaction, cap, reset, LRU), US-2.3/2.4 (stripAnsi, confidence mapping, duration, exit code, stdout absent/capped/redacted), US-2.6 (AI-log shape, truncated passthrough), and the sidecar append+read round-trip; `test/userStories/privacyConfig.test.ts` — US-8.3 (`redactText`: compile, invalid skip, case-insensitive global) and US-8.4/8.5 (append-only JSONL, snapshot cleanup on close, capture toggles). Sidecar deletion is covered with the session delete in `test/userStories/ui.test.ts` (ADR-023).

---

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

---

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

---

## ADR-021: Remove the On-Start Description Prompt

**Status**: Accepted

**Context**: ADR-006/ADR-013 added an optional on-start description prompt (`askSessionStart`) that fired ~5 minutes (`startDescriptionAfterMinutes`) after a session started, asking "Session started · <workspace> — what are you working on?". Combined with the focus-loss prompt removed in ADR-020, the user no longer wants any description prompt at the moment of opening VS Code — context is cold and the prompt interrupts the first thing they actually want to do.

**Decision**:
1. **Delete the on-start prompt** — `askSessionStart()` and the `StartPromptResult` type are removed from `PromptCoordinator`. The `scheduleStartDescription` / `offerStartDescription` / `clearStartDescription` / `applyStartDescription` methods and the `startDescTimer` / `startDescEligibleAt` fields are removed from `SessionManager`.
2. **Delete the config** — `lalog.askDescriptionOnStart` and `lalog.startDescriptionAfterMinutes` settings (and the `startDescAt` threshold) are removed.
3. **No replacement** — the describe checkpoint (~90 min), progress notes (hourly), manual edit, and the "Keep as background work" quick action remain as description entry points. Sessions that go undescribed stay flagged (`needsDescription`) in the sessions view.

**Rationale**: A prompt that fires minutes after opening VS Code interrupts the user before they've settled into work. The describe checkpoint at ~90 minutes provides context-rich description gathering without the interruption. The user prefers zero description prompts on open.

**Implementation**: `src/core/config.ts` (removed fields + threshold), `src/prompts/promptCoordinator.ts` (removed `askSessionStart`, `StartPromptResult`), `src/core/sessionManager.ts` (removed constructor param, timer fields, four methods, all call sites), `src/extension.ts` (removed constructor arg), `package.json` (removed config contributions). The shared test harness derives every threshold centrally from `thresholdsMs(cfg)`, so dropping `startDescAt` needed no per-test edits.

**Test coverage**: typecheck + full suite — no runtime path change to pure modules, and the removed prompt path had no pure-code unit test of its own.

---

## ADR-022: Hard 1h Stale-Session Cutoff — No Continuation

**Status**: Accepted

**Context**: The user wants a hard inactivity boundary: *"If a session was inactive for more than 1h, then automatically close it when I come back and don't allow continuing. Only end and start new is there."* The existing idle model (ADR-010, ADR-012) keeps a session alive as long as the user confirms "Are you still there?" — including the "I was away and came back" continue path — so a session could stay open across arbitrarily long absences. That conflicts with a hard 1h cutoff.

**Decision**:
1. **New setting `lalog.staleSessionAfterMinutes` (default 60)** — after this many idle minutes a session is force-closed as `auto-idle` with `endedAt = lastActivityAt` (ADR-007) and a fresh tracked session starts immediately, silently. No continue/resume/"I was away" option is ever offered for a stale session.
2. **Trigger points** — the stale check runs (a) first in the heartbeat (before `checkIdle`/`checkAutoEnd`) and (b) at the top of `onActivityEvent`, so the first event after a >1h gap closes the old session and starts fresh ("when I come back"). The event is re-dispatched so it lands in the fresh session.
3. **`autoEndIdle` is clamped to at most `staleAfter`** in `thresholdsMs()` — the stale cutoff always takes effect first; the 2h safety net can never fire after it.
4. **No re-open/resume** — a stale session is closed permanently; the fresh session is the only path forward.

**Rationale**:
- A hard cutoff matches the user's mental model: after an hour away, the old session is over; the only way forward is a new session.
- Closing with `auto-idle` and `endedAt = lastActivityAt` keeps reporting accurate (ADR-007) — no idle time is ever counted.
- Starting the fresh session immediately keeps the "never untracked" guarantee.
- Clamping `autoEndIdle` makes the invariant explicit and testable: the stale cutoff is the effective boundary.

**Implementation**: `src/core/config.ts` (`staleSessionAfterMinutes`, `staleAfter`, clamped `autoEndIdle`), `src/core/stateMachine.ts` (`isStale` pure predicate), `src/core/sessionManager.ts` (`checkStale`, heartbeat + `onActivityEvent` triggers, `checkIdle` guard), `package.json` (setting contribution, removed stale `lalog.resumeWindowMinutes`).

**Test coverage**: `test/userStories/tracking.test.ts` — US-1.4 (`isStale` boundary tests: null, exactly-at, just-under, past cutoff, plus `staleAfter` winning over `autoEndIdle` and the force-close starting a fresh session). Thresholds come from the harness's `thresholdsMs(cfg)`, so the new `staleAfter` gate applies to every test without per-test literals.

---

## ADR-023: Confirmed Session Deletion (Full-File Rewrite, No Fallback)

**Status**: Accepted

**Context**: `sessions.jsonl` is append-only (ADR-004), and `updateSession` already rewrites the whole file when a description changes. But there was no way to remove a session: a mistracked or noise session stays in the history forever, inflating every total. `TechnicalStore.delete(sessionId)` existed but was never called, so orphaned sidecars accumulated too.

**Decision**:
1. **Always confirm, modally** — `lalog.deleteSession` shows a modal `showWarningMessage` naming the session; anything other than "Delete" is a no-op. Deletion is destructive and unrecoverable (no tombstone, no undo).
2. **`SessionStore.deleteSession` filters RAW lines** — not `loadAll()`, which dedupes (last occurrence per id wins), drops malformed lines, and re-sorts. A destructive operation must mutate *exactly* the target lines: all lines for the id are removed, while blank lines, malformed lines, and other sessions' lines (including their duplicates) are preserved verbatim. Not-found → `false`, and no write happens.
3. **Sidecar cleanup via `TechnicalStore.delete`** — the same id is removed from `technical/<id>.jsonl` (a no-op when absent).
4. **The live session is blocked** with "End the session first" — the in-progress session only reaches `sessions.jsonl` when it ends, so there is nothing to delete and deleting it would orphan the snapshot.
5. **No fallback-to-latest id** — unlike `lalog.editSession`, delete requires an *exact* id match and silently no-ops otherwise. A stale/bogus id from a stale webview row must never be able to delete the newest session by accident.
6. **Refresh flows through `refreshStatus()` from the command** — it updates the status bar, `cachedTodayMs` (the "today" total in the panel footer), and calls `panel.refresh()`, which re-derives rows, day groups, and insights from the rewritten file. The panel stays a thin router: the 🗑 button posts `{ type: 'delete', id }` and the command owns confirm + delete + refresh. If this logic ever moved *into* the panel, an `onChanged` constructor callback wired to `refreshStatus` would become the right escape hatch.

**Rationale**:
- Raw-line filtering is the only approach that is safe for both directions: it cannot resurrect a session via a stale duplicate line, and it cannot collateral-damage a malformed or duplicated line belonging to another session.
- Exact-id matching turns a class of silent data loss (delete the wrong session) into a silent no-op.
- Routing refresh through the single existing `refreshStatus()` path keeps one source of truth and preserves the invariant that reporting is derived at render time from the append-only store.

**Implementation**: `src/storage/sessionStore.ts` (`deleteSession`), `src/extension.ts` (`lalog.deleteSession`; `lalog.editSession` now ends with `await refreshStatus()` instead of `panel.refresh()` so edits also refresh the "today" total), `src/ui/panelView.ts` (🗑 row button, `case 'delete'`), `package.json` (command contribution).

**Future**: The whole-file rewrite is non-atomic — a crash mid-`writeFileSync` truncates `sessions.jsonl`. Writing `sessionsFile + '.tmp'` then `renameSync` (as `saveSnapshot` already does) would fix this for both `deleteSession` and `updateSession`; out of scope here, noted for a future hardening pass.

**Test coverage**: `test/userStories/ui.test.ts` — US-4.7 (3 tests: confirmed delete with a stale duplicate line + auto-updating stats, cancel no-op, live/unknown/missing id not deletable).

---

## ADR-024: Hand-Rolled PDF Writer (Zero New Dependencies)

**Status**: Accepted

**Context**: PDF export is wanted for two audiences — personal examination and client abstract sheets. The repo's philosophy is minimal dependencies (the only runtime dependency is `diff`), and PDF libraries are heavy. A report writer also has to be testable without pulling a parser into the test suite.

**Decision**:
1. Own a ~250-line PDF 1.4 writer in `src/reporting/pdf.ts`: base-14 fonts only (Helvetica / Helvetica-Bold / Helvetica-Oblique with `/WinAnsiEncoding`), uncompressed content streams, no `/Info` dictionary (no `/CreationDate`, no `/Producer`) so output is **byte-deterministic**. Text escaping, latin-1 encoding, word wrap, and a correct 20-byte-per-entry xref table with a `startxref` offset live here.
2. `pdfReport.ts` stays a pure layer mirroring ADR-015: `buildPdfModel()` takes `now` / `idleGapMs` as parameters and stamps them on the model, so `renderPdfReport()` never reaches for `Date.now()` internally and rendering is reproducible in tests.
3. Options are 13 boolean content toggles plus `dayMode` (`grouped` | `separate`) and two presets (`personal` / `client`). Durations always render — a time report without durations is useless.
4. Output goes to `reportsDir` using `saveReport`'s date-prefixed, non-overwriting filename with a `.pdf` extension, and is opened via `vscode.env.openExternal`.

**Rationale**:
- Dependency-free, and testable without a PDF parser: uncompressed streams make text assertions possible, and a `startxref` slice check proves the xref offsets without parsing the document.
- Deterministic bytes let tests assert on rendered content instead of snapshots.
- Presets keep the common cases one click away while the checkbox list keeps full control for the unusual ones.

**Implementation**: `src/reporting/pdf.ts` (writer), `src/reporting/pdfReport.ts` (model, presets, options, render, save), `src/extension.ts` (`lalog.exportPdf`, sharing `pickReportRange` with `lalog.report`), `package.json` (command contribution).

**Known limitation**: non-latin1 text is transliterated to `?` by the WinAnsi encoder.

**Test coverage**: `test/userStories/pdfExport.test.ts` — US-6.6 / US-6.7 (7 tests: writer determinism, page-tree/xref structural validity, `buildPdfModel` day bucketing and scoping, the full command flow, the client vs personal presets, option overlay, and cancel/empty-selection handling).

---

## ADR-025: Session Detail as an Untitled Markdown Document

**Status**: Accepted

**Context**: The sidebar used to render an inline, collapsible detail block per session — split times, type, closed reason, event counters, top files, notes, git. It was the only place that detail existed, it was a second rendering path to maintain alongside the markdown report, and it made the session list expensive to scan: a handful of expanded rows buried every other session. The user asked for the *document*, not the widget: open a session and read what happened, in full, with diffs.

**Decision**:
1. **One pure renderer** — `src/reporting/sessionDetail.ts` exports `renderSessionDetail(input): string`, which takes the session, the resolved project, the **raw** sidecar entries, the retention window, `now`, and `idleGapMs`. No I/O, no internal `Date.now()`, everything derived at render time (codemap invariant: no cached derived aggregates).
2. **Multiple entry points, one document** — `lalog.sessionDetail <sessionId>` is the only command; the session-list row click posts `{ type: 'openSessionDetail', id }` and the panel forwards it. Later entry points (timeline slot, hour picker, day view) call the same command rather than adding a renderer.
3. **Ephemeral untitled document, `preview: true`** — `openTextDocument({ language: 'markdown', content })` then `showTextDocument(doc, { preview: true })`. Nothing is written to disk, no file is added to the workspace, and closing the tab leaves no trace. The document is a *view* of the log, not an export.
4. **Editing the document is scratch-only** — it does not write back. The editable surface for a session stays `lalog.editSession` (description) and the progress-update notes, both of which go through `SessionStore.updateSession`. A future "save as" is a separate decision; today the document is read-and-scratch.
5. **The session list is simplified to a summary** — the entire inline `.detail` block, the `groupRow()` helper, and the `open.sessions` / `open.files` / `open.notes` sets are gone. A row is now: status icon, clickable project dot, time · workspace — description, duration, ✎ and 🗑. Below it, one always-visible timestamped row per progress-update note (oldest first), plus at most one conditional action row (un-background / keep-as-background). The row click opens the detail document.
6. **`SessionSummary` in the `state` payload is unchanged** — the panel still derives and ships exactly the same fields. Simplifying the *rendering* must not change the payload other surfaces and tests depend on.

**Rationale**:
- One renderer means the sidebar and the document can never disagree about what a session contains, and adding a new entry point costs a click handler, not a second implementation.
- An untitled preview document respects the local-first philosophy: viewing history creates no artifacts, and the markdown is the same thing the report already produces.
- Keeping derivation at render time (ADR-015) is what makes the document safe to re-derive every time it is opened — nothing can drift from `sessions.jsonl`.
- The list shrank to what a scan actually needs. Everything else is one click away, and the notes stay visible because they are the only part of a session that is written *by the user* and therefore worth scanning for.

**Implementation**: `src/reporting/sessionDetail.ts` (`renderSessionDetail`, `fmtHM`, `diffRetentionView`, `DIFF_PREVIEW_CHARS`), `src/extension.ts` (`lalog.sessionDetail` — exact-id lookup, no fallback, per ADR-023), `src/ui/panelView.ts` (`case 'openSessionDetail'`, reworked `sessionNode()`, `.updates` container), `package.json` (command contribution), `test/helpers/mockVscode.ts` (`_openedDocs` / `_shownDocs` recording, object-form `openTextDocument`).

**Test coverage**: `test/userStories/sessionDetail.test.ts` — US-4.4 (section-by-section rendering, empty-technical, the four `diffRetentionView` branches, the `DIFF_PREVIEW_CHARS` cap, and the key property that terminal entries still render next to an aged-out File-changes note) and US-4.8 (row click → document; unknown id → no document).

---

## ADR-026: Diffs-Only Technical Retention

**Status**: Accepted

**Context**: File diffs are the only unbounded growth in `~/.lalog/technical/` — they embed whole file contents, capped at 16 KB each but written on every save, forever. Terminal commands and AI-interaction metadata are tiny and are the parts of a session that stay *readable* long after you no longer care about the exact bytes of a line. A blanket age-out would throw both away together.

**Decision**:
1. **Only `type:'diff'` entries expire**, keyed on **each entry's own `ts`** — not on the session's `startedAt`. A long-running session that is still being written to never loses its recent diffs just because it started weeks ago.
2. **`lalog.diffRetentionDays` (default 14, `0` = keep forever)** prunes the window. The sweep runs once at activation, right after `manager.start()`.
3. **Terminal and AI-interaction entries are kept forever.** They are the durable record of *what you ran and how much you prompted*; the diffs are the disposable part.
4. **Per-file atomic rewrite** — read the sidecar, filter, write `<file>.tmp`, `renameSync` over the original (the same pattern as `saveSnapshot`, `store.ts:86-91`). A re-stat guard (`size` + `mtimeMs`) between the read and the rename skips any file that was appended to mid-sweep, so a concurrent capture can never lose entries. A crash before the rename leaves the original intact plus a stray `.tmp`, which the next sweep cleans up first; a crash after it means the new content is live. There is no window in which a sidecar is partially written.
5. **A sidecar left with zero entries is deleted**; files that do not match the sidecar pattern are never read, stat'ed, or rewritten. Malformed lines are kept **verbatim** — a hand-edited or half-written line is not something the sweep is allowed to "clean up".
6. **Best-effort, per file** — any error is swallowed; a prune failure must never break activation.
7. **Aged-out signalling is diff-specific** (`diffRetentionView` in `reporting/sessionDetail.ts`): the document shows the captured diffs while any of them are inside the window; when diffs exist but all are older, or when the sweep already removed them and the session is older than the window with `events.saves > 0`, it renders an explicit "no longer available" note *instead of* an empty section. The `saves > 0` guard prevents a false positive on an old read-only session that never produced a diff to begin with. Terminal and AI sections render unconditionally, so a document can legitimately show a terminal command and an aged-out File-changes note side by side.
8. **Rejected: per-session-age pruning** (`pruneBefore(cutoffStartedAt, keepIds)`) — it couples data removal to when a session *began*, silently drops diffs from long sessions that are still in use, and needs a `keepIds` escape hatch that is only ever populated by callers who happen to think about it.

**Rationale**:
- Diff content is the only part that meaningfully duplicates the workspace itself; once it is gone the *shape* of the work (files touched, commands run, prompts sent) is still answerable from the counters and the retained metadata.
- Rewriting files at all is the risky part, so it is made atomic and guarded; the cheap alternative (deleting whole sidecars) would have cost the terminal and AI record.
- Showing "no longer available" is honest. Silently rendering an empty *File changes* section would be indistinguishable from a session where diff capture was off.

**Implementation**: `src/storage/technicalStore.ts` (`pruneDiffEntriesBefore`, `SIDECAR_RE`), `src/core/config.ts` + `package.json` (`lalog.diffRetentionDays`), `src/extension.ts` (activation sweep; `lalog.sessionDetail` passes `retentionDays`), `src/reporting/sessionDetail.ts` (`diffRetentionView`).

**Test coverage**: `test/userStories/capture.test.ts` — US-8.7 (5 pure tests: mixed sidecar keeps old terminal/AI, all-old-diff sidecar deleted, terminal/AI-only sidecar byte-identical with no rewrite, non-sidecar filenames untouched, malformed line preserved verbatim); `test/userStories/privacyConfig.test.ts` — US-8.7 (activation sweep, `diffRetentionDays: 0`, default of 14); `test/userStories/sessionDetail.test.ts` — US-8.7 (command honours the window / retention off).

---

## ADR-027: One Local Day Key Everywhere

**Status**: Accepted

**Context**: LaLog groups things by day in several places — the Sessions tab, the insights day totals and timeline, `files_by_day.txt`, the markdown report header, the PDF day sections, and the CSV filename. That used to be **five or six independent implementations** of "which day is this timestamp on", and three of them were **UTC** while the rest were local. For a session started at 23:30 the Sessions tab filed it under tomorrow, insights filed it under today, and the two disagreed on screen. The user experiences days in local time; `toISOString().slice(0, 10)` is a UTC day and was simply wrong.

**Decision**:
1. **One definition, in `src/reporting/ranges.ts`** — `dayKey(ts)` returns a zero-padded local `YYYY-MM-DD`. `ranges.ts` already owns every local calendar-day computation (`rangeStart`, `rangeEnd`, `calendarDaysAfter`) and is already imported by the consumers that need a day, so it is the natural home. Rejected: a new one-function `days.ts` module; exporting from `insights.ts` (which would make `report` / `pdfReport` / `panelView` / `legacyExport` import "up" for a date primitive).
2. **Zero-padded** so lexicographic sort === chronological sort — every consumer sorts day strings.
3. **Fix the three UTC sites**: `panelView.ts` `groupByDay` (the Sessions tab), and both `legacyExport` day keys in `files_by_day.txt`.
4. **Consolidate the five local duplicates**: delete the local `dayKey` in `insights.ts`, the `dayStamp` helper in `extension.ts`, and `localDayKey` in `pdfReport.ts`; make `report.ts`'s exported `localStamp` a one-line delegation to `dayKey` (it is part of that module's surface, used by `pdfReport` and `saveReport`).
5. **Deliberately left alone** — `rangeStart`/`rangeEnd` and `calendarDayCount` (already local, DST-safe); `aggregate.ts`'s `todayActiveMs`/`todayUntrackedMs`; `extension.ts`'s `parseDay` (the inverse of `dayKey`); `insights.ts`'s `localHourStart`/`dayStartMs`/`hourlyBreakdown` (an hour grid, not day keys); the full-ISO `iso()` helpers in `git.ts`/`extension.ts`; the `store.ts` session-id prefix (id generation, not grouping).
6. **No range-membership change** — the range bounds were already local, so this only changes *which day string* a session files under. No session enters or leaves an insights range because of it.

**Rationale**:
- One definition means the Sessions tab, the insights timeline, and the day exports cannot drift apart again. A late-evening session is the case that actually bites, and it is now covered by a test.
- `ranges.ts` sits below every consumer in the dependency graph, so the import direction stays clean.
- The `YYYY-MM-DD` output format is unchanged everywhere, including `files_by_day.txt` — downstream consumers of the legacy format keep working.

**Implementation**: `src/reporting/ranges.ts` (`dayKey`), `src/ui/panelView.ts`, `src/integrations/legacyExport.ts`, `src/reporting/insights.ts`, `src/reporting/report.ts`, `src/reporting/pdfReport.ts`, `src/extension.ts`.

**Test coverage**: `test/userStories/ui.test.ts` — US-4.3 (TZ-independent local fixtures, plus a 23:30 session asserting the Sessions tab group, the insights timeline day, and the insights day totals all agree); `test/userStories/insightsReporting.test.ts` — US-6.5 (`files_by_day.txt` keys a 23:30 edit under its local day).

---

## ADR-028: Timeline Slots Carry Session Identity

**Status**: Accepted

**Context**: The insights timeline showed, per hour, only *how much* time was spent and which project dominated the hour. That is enough to see shape, but not to act on it: the panel's "where did this hour go?" question had no answer, and the only route to a session was the Sessions tab, which is grouped by day, not by hour. The 0.6.0 timeline also merged the old "Time per day" list into the day rows, so a day's total now sits on the same row as its hours — which makes the row, rather than a separate widget, the obvious place to hang a day's file diffs (US-6.9).

**Decision**:
1. **`HourCell.parts: HourPart[]`** — one `HourPart` (`{ ms, projectName, sessionIds }`) per project present in that hour. The cell-level `ms` / `projectName` / `color` fields stay, unchanged, as the dominant slice, so every existing consumer (tooltips, tests, the day total) keeps working.
2. **Identity, not just magnitude.** `sessionIds` is what makes the slot actionable: the webview posts `{ type: 'openHourSessions', ids }`, the extension opens the session detail directly when the hour holds one session, and shows a QuickPick when it holds several. One slot → one click → one document.
3. **Client-side filtering, not a server round-trip.** The project filter chips filter the already-posted `parts`, re-rendering the grid and the day totals in the webview. A `pushState` re-derives all three insight snapshots, so filtering must not add a message or widen the payload (ADR-015: render-time aggregation, no cached derived aggregates).
4. **An hour axis** (00:00, 03:00 … 21:00) and a per-day total on each row, replacing the separate "Time per day" section that duplicated numbers the timeline already implied.
5. **Empty cells are explicitly empty** (`ms: 0`, transparent, `parts: []`) rather than omitted, so the grid is always a full day wide and hour *n* is always `cells[n]`.
6. **Colour comes from `byProject`**, not from the cell, so the timeline palette and the project legend (and the sessions-tab chips) cannot disagree.

**Rationale**:
- Aggregating into `parts` at render time — where the timeline is already built — costs one pass and no new state, and it keeps the shape of the data ("which sessions were active in this hour") available to any future consumer, not just to this one click.
- Hover tooltip + click target per cell, with the day label itself opening that day's diffs, means every number the timeline shows is now either explained or navigable.

**Implementation**: `src/reporting/insights.ts` (`HourPart`, `HourCell.parts`, `buildTimeline`), `src/ui/panelView.ts` (`renderInsights`, `tlFilter` state, `openHourSessions` / `openDayDiffs` handlers, `.tlval` / `.tlaxis`).

**Test coverage**: `test/userStories/insightsReporting.test.ts` — US-6.8 (5 pure tests: per-project slices, deduplicated `sessionIds` across overlapping sessions, empty cells, dominant-slice compatibility, and parts agreeing with `byProject`); `test/userStories/ui.test.ts` — US-6.8 (timeline cells reach the session id; a single-slot click opens the document and a multi-slot click offers a picker, with unresolvable ids doing neither).

---

## ADR-029: A Single Implicit Workspace Project; Multi-Project Is Opt-In

**Status**: Superseded by [ADR-030](#adr-030-per-workspace-projects-replace-the-single-project-union) (the union/collapse behavior below is no longer how the default mode works; this record stays as the historical rationale)

**Context**: Projects were a full management surface (create / claim / archive) that nobody had asked for, and the derived model had a sharp edge. `resolveProject` matches `session.workspaceKey` against a project's claims with **no basename fallback**, so renaming or moving the folder you work in produces a *new* workspace key: every historical session silently stops resolving, and — because the common case is "two folders, two projects, one of them historical" — a naive auto-create claiming only the *current* key would orphan the history. The user hit exactly this: `worklog` held the history, the folder is now `lalog`, and both appeared in the panel.

**Decision**:
1. **One project per window by default**, named after the open folder, renameable, created automatically. `lalog.multiProject: false`.
2. **The claim union is the actual fix**, not the auto-create. On every activation (when multi-project is off) the single project claims the current workspace key **and** every `workspaceKey` found in `sessions.jsonl`. After that, a historical session resolves by claim, a session whose explicit `projectId` was collapsed away is re-pointed, a new session resolves by the current key, and a *future* folder rename simply adds one more key to the same project.
3. **Collapse, not delete.** More than one project → a survivor is chosen (folder-name match, else oldest non-archived, else oldest), every other project's `workspaceKeys` and `pathHints` are unioned into it, and the rest are removed. The survivor keeps its own `id`, `color` and `createdAt`.
4. **Data-preserving and idempotent.** `projects.json.pre-collapse.bak` is written once (only if absent) so the earliest pre-collapse state survives; explicit `projectId`s pointing at removed projects are rewritten via `updateSession`; the `projects.json` schema is unchanged (no version marker) and every branch of `ensureSingleProject` is safe to re-run on the next activation.
5. **Never auto-rename.** With exactly one project, the name is user-owned: a folder rename must not silently relabel a project the user called "Client X".
6. **The Projects tab shrinks to match.** Default mode renders one card (dot, name, stats) and a **Rename…** action. Create/claim/archive stay behind `lalog.multiProject`, and the `newProject` / `newProjectFromWorkspace` / `claimWorkspace` / `archiveProject` messages are gated off. Renaming is deliberately *not* gated — it is the one project action the default mode needs. Project names still flow through `resolveProject` / `resolveProjectName` at render time, so a rename shows up in the panel, the reports, the PDF and the CSV on the next refresh with no extra wiring.
7. **Opt-in multi-project keeps the old ambiguity.** With `lalog.multiProject` on, nothing is collapsed and a workspace claimed by several projects still resolves to the first match; "Add workspace" is the manual remedy. Known limitation, not a bug to fix later.

**Rationale**:
- The rename-orphaning bug is structural, so the fix is structural: a claim set that grows instead of a lookup that guesses. Nothing downstream of `resolveProject` changes.
- Naming the project after the folder makes the model legible ("this project is this workspace") and makes the *rename* action meaningful instead of decorative.
- The migration is cheap (a handful of key unions, once) and re-runnable, which is what makes it safe to run on every activation rather than behind a one-shot prompt.

**Implementation**: `src/storage/projectRegistry.ts` (`EnsureSingleOpts`, `EnsureSingleResult`, `ensureSingleProject`), `src/extension.ts` (activation migration between `manager.start()` and the first `refreshStatus()`, `lalog.renameProject`), `src/core/config.ts` + `package.json` (`lalog.multiProject`), `src/ui/panelView.ts` (`PanelNow.multiProject`, payload flag, gated handlers, `renderProjects` branch).

**Test coverage**: `test/userStories/projects.test.ts` — US-5.5 (registry: create-from-empty, one-project claim/restore with the name untouched, name-match survivor + backup, oldest-live survivor, idempotency across three calls; activation: the rename round-trip with a pre-seeded `worklog`/`lalog` registry and a pre-seeded `sessions.jsonl`, asserting one project named `lalog` claiming both keys, the two-project backup, the re-pointed session, the resolution of the old-key session, and the panel payload; and the gated Projects tab); US-5.6 (`lalog.multiProject: true` keeps both projects, writes no backup, reports the flag, and still allows `newProjectFromWorkspace`).

---

## ADR-030: Per-Workspace Projects Replace the Single-Project Union

**Status**: Accepted

**Context**: ADR-029 solved folder renames by unioning, but it had the side effect of making *every* workspace on the host share one project. With five workspaces open over time, `ensureSingleProject` claimed all of their keys into a single record, so every session resolved to whichever project was created first — the user saw one project called `lalog` containing Daftra work, unrelated repos, everything. The naming was also wrong: the project was labelled after whichever folder happened to be opened, not after the workspace the user is actually in. Meanwhile `Session.workspaceName` (the VS Code `folder.name` recorded at session time) was already correct per workspace — only the *project* was shared.

**Decision**:
1. **One project per workspace.** `ensureWorkspaceProject` finds the project that claims the current `workspaceKey` (un-archiving it, attaching the path hint, tracking the name) or creates one named from the VS Code workspace name. Other projects are never collapsed, their keys never unioned, nothing is ever dropped.
2. **The default name is the VS Code workspace name**, resolved as `vscode.workspace.name ?? workspaceFolders[0].name ?? basename(wsPath)`. A single-file window has no `workspace.name`, so it falls back to the folder basename; a `.code-workspace` / multi-root window gets the `.code-workspace` name (e.g. `Daftra Consulting`), which is exactly the name the user sees in the title bar.
3. **`nameSource: 'auto' | 'user'` decides who owns the name.** Records created by `create()` are `'auto'` and may be renamed live to follow the workspace (`setNameTracked`); `lalog.renameProject` sets `'user'` and the name is then never touched again. A **missing** flag reads as `'user'` for *renaming* — LaLog never stomps a name it did not generate — but as *splittable* for the one-time migration below, because every real 0.6.0 record predates the flag. The two readings are consistent: conservatism about names, authorization for the migration.
4. **No global union — a folder rename is a new identity.** Renaming `lalog/` to `lalog2/` produces a new workspace key: old sessions keep resolving to the old project, new sessions get the new one. This is deliberate: guessing that two paths are "the same" work (sibling-path heuristics, key unioning) is what produced the single-project mess. Users reconcile manually by renaming, or by assigning sessions explicitly.
5. **One-time split migration, not a collapse.** If the registry holds exactly one **flag-less** (pre-0.7) project claiming several keys, it is split into one project per key: each is named from the most recent session `workspaceName` of that key, its matching `pathHint` (basename equals the name) is attached, and the old id/color are dropped. Keys with no session and no matching hint are skipped. `~/.lalog/projects.json.pre-split.bak` holds the collapsed file byte-for-byte, written once, and a single atomic write lands the whole split (no partial intermediate file). Idempotent by construction: the next activation sees more than one project, so the guard fails. Records written after 0.7 always carry `nameSource`, so a multi-key `'auto'`/`'user'` project there is a deliberate union and is never split.
6. **Dangling explicit assignments are healed per key.** After the split, a session whose `projectId` points at a removed record is re-pointed at whichever project claims *its own* workspace key (not at one global survivor), via `updateSession`. The live-session heal of ADR-029 is gone — there is no survivor to heal towards.
7. **Opt-in multi-project is unchanged.** `lalog.multiProject: true` still skips the whole thing and keeps the full management surface.

**Rationale**:
- The registry lives in one global file, so "one project per workspace" is a per-machine model that happens to be keyed by workspace identity — no scoping rework, no new storage.
- Names should come from the place the user already names things: the VS Code window. Deriving from `folder.name` (and, when present, the `.code-workspace` name) makes the Projects tab legible in a multi-root window.
- Splitting rather than collapsing keeps the migration reversible: the pre-split backup is the original file, and sessions are only re-pointed when their key has an unambiguous new owner. Because `nameSource` did not exist in 0.6.0, a user who hand-**renamed** the collapsed project left no `'user'` trace, so such a record still splits — a known limitation, recoverable from `projects.json.pre-split.bak` plus a rename.
- Reporting is untouched — project names still resolve at render time (`resolveProject` / `resolveProjectName`), so the split shows up in the panel, reports, PDF, CSV and insights on the next refresh with no extra wiring.

**Implementation**: `src/core/projects.ts` (`Project.nameSource`, `isAutoNamed`), `src/storage/projectRegistry.ts` (`EnsureWorkspaceOpts`/`EnsureWorkspaceResult`, `ensureWorkspaceProject`, private `splitLegacyCollapse`, `setNameTracked`, `rename` marking `'user'`, `create` marking `'auto'`), `src/extension.ts` (activation block between `manager.start()` and the first `refreshStatus()`; `lalog.renameProject` unchanged externally), `test/helpers/mockVscode.ts` (`workspace.name` + `setWorkspaceName`), `test/helpers/harness.ts` (`vscWorkspaceName` opt).

**Test coverage**: `test/userStories/projects.test.ts` — US-5.5 (registry: create-from-empty never absorbing another workspace's history key, exact auto-name tracking with un-archive + path hint, user/flag-less names kept, several projects never collapsed, the legacy split incl. a skipped key / backup / idempotency across three calls, a user-named collapsed record never split, flag-carrying multi-key unions never split in either mode, a renamed folder becoming a new identity while the old project is preserved; activation: the VS Code workspace name as the default and the folder-basename fallback, the rename command marking `'user'` and surviving a later activation, the collapsed-data regression where each workspace's sessions resolve to their own project and the dangling `projectId`s are re-pointed per key, and activation never re-pointing an explicit assignment that already resolves; panel: single mode pushing only the current window's project) and US-5.6 (multi mode keeps both projects, writes no backup, reports the flag, still allows `newProjectFromWorkspace`).

---

## ADR-031: Tracked Time Is Reduction-Only, With Outside-Window-First Removal

**Status**: Accepted

**Context**: the idle prompt (US-1.3) asks whether the user is still working, and "Yes, still working" bills the idle stretch as outside-VS-Code work — the one prompt whose answer permanently changes the number. Answer it wrong and the away window is now a closed active span with no way back: `lalog.editSession` only edits text, so the total stays inflated for that session and for every report, insight, and project rollup derived from it. The tracked total was otherwise the one figure the user could not touch, which is exactly backwards for a log whose whole promise is that the human is the author of record.

**Decision**:
1. **One pure reducer, `truncateToTotal` in `src/core/spans.ts`** — `(spans, activeMinutes, activityTs, targetMs, preferredSuffix?)` returns the surviving spans, the honest `sum(spans)`, `activityTs` filtered to `<= tailEnd`, and `tailEnd` (via the exported `tailEndOf`). It is a function of its arguments only: no clock, no store, no manager, so the same code serves the live and closed paths and the test suite needs no harness to prove the arithmetic.
2. **Reduction only.** `0 <= targetMs <= activeMinutes`, `RangeError` otherwise, and the input box validates a whole number of minutes in `0..current`. LaLog never invents tracked time it did not observe, and `sum(spans) === activeMinutes` is the invariant that gets written back.
3. **The confirmed-outside window is removed first.** `accrueOutsideConfirmed` remembers the span it closed as `lastOutsideSpan`; the reducer consumes its length before touching the tail. A wrong "Yes, still working" is therefore rolled back exactly: the away window vanishes, and the real work recorded after the return is spared and keeps accruing from the corrected base. Everything else is plain backward truncation from the tail, shrinking each span only from its `end`; a span's `start` is never moved, so no new time is fabricated to fill a hole.
4. **Live edits route through `SessionManager.adjustTrackedTime`, never the store.** Writing `active/<wsKey>.json` (or `sessions.jsonl`) directly would be undone by the very next heartbeat save, since the manager's in-memory total is the source of truth for the live session. The method first finalizes the in-progress run (`closeOpenSpanAt`) so the still-open stretch takes part in the truncation instead of being silently zeroed — a continuous four-hour session has no closed spans at all, and dropping them would answer every target with `0:00` — then rewrites the session and machine together, resets `lastActivityAt` to now (the gap since the last event is never billed), clears `lastOutsideSpan` so a second adjust can't hit a span that no longer exists, re-bases `lastProgressActiveMin` to avoid a duplicate progress prompt, and downgrades `wrapPending → active` when the corrected total is back under `th.wrapAt`. `lastOutsideSpan` is also cleared wherever a session is finalized or a fresh one starts.
5. **Closed sessions take a plain path.** The command runs `truncateToTotal` without a `preferredSuffix` (closed sessions carry no outside-window metadata) and writes only `activeSpans` / `activeMinutes` / `activityTs` / `lastActivityAt` through `SessionStore.updateSession` — every other field, and the technical sidecar, is left exactly as it was — then refreshes via the existing `refreshStatus()`.
6. **Targeting is exact; the palette falls back.** A string argument is matched exactly against `store.loadAll()` ("Session not found." otherwise), consistent with ADR-023. With no argument (command palette, Now box) the target is the live session, else the latest closed one, else "No sessions recorded yet."

**Rationale**:
- Append-only storage (ADR-004) buys credibility: nothing in the log is quietly re-derived or re-timed, and the codemap's in/outside split stays a pure function of spans. A user who disagrees with a number must be able to correct it without editing JSON by hand, but only downward — the tracker cannot certify work that never happened, and a symmetric "add time" feature would be a time-entry tool, not a tracker.
- Removing the outside window first is what makes the feature a *rollback* rather than a generic shave. Tail-only truncation would delete the user's genuine post-return work to pay for an away window; the saved `lastOutsideSpan` spends the correction where the mistake was made.
- Routing live edits through the manager keeps exactly one writer per session, so a correction can never race the heartbeat.

**Implementation**: `src/core/spans.ts` (`TrackedAdjust`, `tailEndOf`, `truncateToTotal`), `src/core/sessionManager.ts` (`lastOutsideSpan` set in `accrueOutsideConfirmed` and cleared in `openWorkspace` / `ensureSessionOnActivity` / `endSession` / `startFresh` / `adjustTrackedTime`; `adjustTrackedTime`), `src/extension.ts` (`lalog.adjustTrackedTime`), `src/ui/panelView.ts` (⏱ row button, `btnAdjust` in the Now box, `case 'adjust'` / `case 'adjustLive'`), `test/helpers/mockVscode.ts` (`showErrorMessage`), `package.json` (command contribution).

**Future**: `lastOutsideSpan` is in-memory only, so a *closed* session's wrongly-billed window is no longer distinguishable from real work and is trimmed like any other tail. Persisting the confirmed-outside window on the session would make the rollback exact after a restart too; that is a schema change, so it waits for a real report of the gap.

**Test coverage**: `test/userStories/adjustTime.test.ts` — US-4.9 (pure reducer: single-span cut, multi-span cut with an emptied span, outside-window-first with the post-return tail spared, outside-window plus extra demand, a stale suffix ignored, no-op, zero target, `activityTs` filtering, the `sum === target` invariant, and `RangeError` on both out-of-range ends; live: the wrong-confirm rollback through the manager with only the new gap accruing afterwards and the heartbeat unable to resurrect the dropped time, a second adjustment, and growth refused; command: closed-session rewrite, live targeting from the Now box, cancel / unchanged / growth writing nothing, and an unknown id never falling back to the latest session).

## ADR-032: opencode serve Activity Is Observed, Never Managed

**Status**: Accepted · **Amended by** [ADR-033](#adr-033-reuse-first-opencode-serve-lifecycle-owned-or-not-at-all-amends-adr-032) — the "observe, never manage" clause now reads "never manage a serve you did not start"

**Context**: LaLog's AI integration is a one-shot CLI subprocess (`opencode run`, ADR-011), so the growing way of actually using opencode — a long-lived `opencode serve` driven from the TUI or app — is invisible to the tracker. The human is working, often for hours, and LaLog records nothing: no session, no active minutes, no event. That is the same honesty failure ADR-031 fixed for wrongly-billed idle windows — the log stops being a log exactly when the work moves somewhere LaLog refuses to look. Two boundaries are non-negotiable while fixing it: LaLog stays local-only (architecture rule 5), and it never manages an `opencode serve` lifecycle (roadmap exclusion). `opencode serve` closes the gap from its own side: it exposes a localhost HTTP API whose `GET /session` returns pure metadata — id, directory, title, `time.updated` — with no message content, and reading it mutates nothing.

**Decision**:
1. **Observe, never manage.** LaLog polls `GET /session` on a user-configured localhost URL (`lalog.opencode.activity.url`, default `http://127.0.0.1:4096`) every 20s by default. It never starts, stops, restarts, or otherwise manages the server; if nothing is listening it retries silently and re-baselines. The server is the user's process on the user's port — LaLog is only a client. (**Amended by ADR-033**: reuse-first — a serve LaLog starts itself it also stops, a discovered one is never signalled; and polling is now two-tier with a 30s cadence.)
2. **The signal is `time.updated`, not content.** A poll reports activity when a previously-observed session whose `directory` is at or under a VS Code workspace root has a strictly larger `time.updated`. Message bodies and model output are never read: the watcher consumes four metadata fields and nothing else. Sessions titled `LaLog …` (the bridge's own one-shot runs) are skipped so LaLog cannot observe itself into fake activity.
3. **Observation-only accrual (ADR-031 ethos).** First sight is a baseline, not an event: a session appearing on a poll is recorded internally and emits nothing. Any failed poll breaks observation continuity, so the baseline is dropped and the next successful poll re-baselines — LaLog never fabricates time for a gap it did not observe. At most one `opencode` event is emitted per poll, however many sessions bumped.
4. **A new `opencode` TrackedEvent, full support.** Not an overload of `terminal` or `task`: the counter is honest data, the ripple is bounded (~6 files, no exhaustive switches), and zero new accrual code is needed — the event flows through `SessionManager.onActivityEvent`, so auto-start, idle-arm, stale-cutoff, and pause guards all apply unchanged.
5. **A pure-Node watcher, injected at the composition root.** `src/opencode/serveWatcher.ts` imports no `vscode` and no `node:http` — global `fetch` with a per-request ~5s abort, a `setTimeout` chain (never `setInterval`), `unref`ed timers cleared in `dispose()`, response shape-validation, silent retry with ×5 backoff after ≥3 consecutive failures, and a stop-with-one-time-warning on 401/403/404 or a malformed body (recovered by the next `start()`). It is constructed by `extension.ts` only when `lalog.opencode.activity.enabled` is true and injected into `SessionManager` as a two-method `ServeActivityWatcher` interface owned by `src/core/types.ts` — keeping ADR-011's one-way rule (`core` never imports `opencode`) intact. `SessionManager.start()` starts it; `dispose()`/`shutdown()` dispose it.
6. **Config is its own opt-in namespace.** `lalog.opencode.activity.*` (`enabled` false, `url`, `pollIntervalSec` 20, `authUser` "opencode", `authPassword` "") is independent of `lalog.ai.enabled` — serve observation works with AI off, and both are off by default. The interval resolves through the `thresholdsMs` machinery like every time gate — `debugTimeScale` divides it, a ≥5s floor and a ≤ `idleConfirm`/3 ceiling keep mock-timer tests runnable — and auth is HTTP Basic, sent only when a password is configured.

**Rationale**:
- Polling beats SSE for v1 because it is stateless: no reconnect, backoff-window, or heartbeat-timeout machinery, one failed fetch is simply the next poll, and a serve restart costs at most one re-baseline. SSE `GET /event` (v2) buys real-time and long-stream robustness later, at the price of a connection to keep alive.
- Metadata-only is the privacy position: the watcher cannot leak what it never reads, and `GET /session` is a read that mutates nothing on the server.
- The observation rule is what makes the data trustworthy: an event means "LaLog saw work happening," not "LaLog inferred work probably happened."
- Injecting the watcher as a core-owned interface preserves ADR-011's dependency direction (opencode → core, never core → opencode) while `SessionManager` keeps single-owner lifecycle control.

**Implementation**: `src/opencode/serveWatcher.ts` (new), `src/core/types.ts` (`'opencode'` in `TrackedEvent`, `Session.events.opencode`, `ServeActivityWatcher`), `src/core/config.ts` (`OpencodeActivityConfig`, `OPENCODE_ACTIVITY_DEFAULTS`, `readOpencodeActivityConfig()`, `opencodePollMs`, `ThresholdsMs.opencodePoll` via `thresholdsMs(cfg, act?)`), `src/core/sessionManager.ts` (optional watcher ctor arg, `start()`/`dispose()`/`shutdown()` hooks, public `recordServeActivity()`), `src/storage/sessionStore.ts` (`newSession` init, `recordEvent` branch, `normalizeSession` backfill), `src/reporting/pdfReport.ts`, `src/reporting/sessionDetail.ts`, `src/ui/panelView.ts` (counter plumbing), `src/extension.ts` (read + construct + inject), `package.json` (`lalog.opencode.activity.*` contributions), `test/userStories/opencodeServeActivity.test.ts`, scan-test exceptions in `test/userStories/nonGoals.test.ts` and `test/userStories/privacyConfig.test.ts`, docs (`features.md`, `architecture.md`, `data-format.md`, `README.md`).

**Future**: v2 switches to SSE `GET /event` (`message.part.delta` etc., with a sessionID→directory map from `/session`) for real-time accrual, long-stream robustness, and auto-dismiss of a pending idle prompt; auto-discovery of running serve instances (observed on ephemeral ports) is a v2 candidate. Known v1 residual: a single stream longer than the idle-confirm window with zero `time.updated` bumps can still fire one idle prompt.

**Test coverage**: `test/userStories/opencodeServeActivity.test.ts` — unit (fake `fetchImpl` + mock timers): baseline-without-emit, bump-emits-once-per-poll with dedupe, new-session-is-baseline, out-of-root and `LaLog `-titled sessions never emit, failed-poll → re-baseline without emit, ×5 backoff after ≥3 failures, 401/403 and malformed body stop with one warning, invalid entries skipped, auth header only with a password, dispose stops polling; config: `opencodePoll` scales with `debugTimeScale` and clamps to [5s, `idleConfirm`/3]; integration (harness with an injected watcher): serve activity auto-starts a session and accrues active minutes, keeps a session alive past the idle-confirm window, is ignored while paused, and never fetches when disabled.

---

## ADR-033: Reuse-First opencode serve Lifecycle, Owned or Not At All (amends ADR-032)

**Status**: Accepted · **Amends**: [ADR-032](#adr-032-opencode-serve-activity-is-observed-never-managed) · **Reconciles with**: [ADR-005](#adr-005-local-only--zero-telemetry), [ADR-011](#adr-011-optional-ai-assistance-amends-adr-005)

**Context**: ADR-032 made `opencode serve` activity observable but left the server entirely to the user, which is exactly the step nobody takes: the feature is off by default, so a fresh install observes nothing until someone manually starts a server on a remembered port. ADR-032 also answered a question that had not been asked yet ("does *seeing* mean *managing*?") and answered it before the measurements existed.

Three measurements change the picture.

- **A session-aware server can be started reliably.** A serve launched with `cwd` set to the repository returned 100/100 of the sessions the user's own TUI server knew about that directory, because `/session` filters on the process's launch directory. Auto-start therefore produces the *same* answer as a hand-started server, not a second, partial truth.
- **An instance is expensive.** A `ps`-sample of opencode processes showed several instances at 0.8–1.6 GB RSS on top of one shared `~/.local/share/opencode/opencode.db`. Starting a serve per VS Code window would multiply the worst cost in the system, so reuse is not a nicety — it is the requirement.
- **Polling is heavier than ADR-032 assumed.** One `GET /session` on a 70-session server is ~68 KB, every poll, against a documented cap of 100 sessions, over a single shared SQLite database. A flat 20 s poll of a `serve` nobody is working in is real, pointless load.

**Decision**:
1. **Reuse first; spawn only when there is nothing to reuse.** `ensureServer()` is: discover a serving process for a workspace root → verify it answers → poll it. Only if discovery finds nothing does LaLog spawn `opencode serve` itself, in the workspace root. Every ensure failure is silent apart from one debug line and is retried with backoff, never in a tight loop.
2. **Ownership is structural, not a convention.** A serve LaLog spawned is an `OwnedServe`, branded by a symbol private to `src/opencode/serveProcess.ts`; `stopServe(handle)` takes no pid argument and accepts only that brand. A discovered serve is a `DiscoveredServe` with `owned: false`, so signalling it is not a mistake that survives review — it does not type-check. There is no API anywhere in the codebase that takes a pid.
3. **Never foreign, never prompting, never off-loopback.** Discovery only adopts a server whose launch directory is a workspace root and whose port is bound to loopback; a serve listening on a routable interface is left alone and a new one is started instead. The spawned instance is always `opencode serve --hostname 127.0.0.1` with `cwd` = the workspace root. `GET /session` is a read: no prompt, no message, no mutation. Discovery failure of any kind yields nothing, quietly.
4. **Reuse means *never signalling*.** A discovered server is read-only for the rest of its life — not restarted, not killed, not reconfigured, not stopped on deactivate. A serve LaLog owns is stopped when no LaLog session is being tracked, when the feature is switched off, and on deactivate — because otherwise LaLog would leak the very RSS it refuses to multiply.
5. **A spawned serve is authenticated by default.** The child gets `OPENCODE_SERVER_PASSWORD` from `crypto.randomBytes`, sent in its environment, held in memory for the request's Basic auth, and never written to settings or the log. No password is configured ⇒ random; an explicitly empty password is the only way to run unsecured. An unauthenticated localhost server is trivially reachable by anything else running as that user, so the insecure case must be chosen.
6. **No port to collide, and no orphan on failure.** `spawnPort` defaults to `0` (opencode picks), the real port is parsed from its own line `opencode server listening on http://127.0.0.1:<port>`, and readiness is one verified `GET /session` with backoff under a bounded ceiling. Every failure path — no listening line, unreadable port, timeout, child exit — stops the child it started (SIGTERM, then SIGKILL) and throws a typed `ServeProcessError`. LaLog never leaves a server running that nobody asked for.
7. **Polling is gated and adaptive.** Nothing runs without an open LaLog session: with no session the watcher keeps no timer and issues no requests at all. While a workspace session is alive the cadence is ADR-032's fast interval; each quiet poll doubles it, up to `slowMs` (5 minutes, scaled like every other time gate). Any bump — or any newly seen session — resets it to fast. Only `{ directory, updated }` is retained per workspace session, so the watcher cannot be a transcript store. **Polling is the transport on measured evidence, not SSE:** the obvious fix for the cost of a poll was `GET /event`, and sampling `/proc/<pid>/stat` in interleaved idle/loaded blocks showed an open SSE connection costs **~283 ms of server CPU per second** for 3 events in 25 s (the ~10 s heartbeat does server-side work) — *worse* than polling. `GET /session` costs **~164-283 ms per poll for 68,037 B** (it serializes all 100 sessions; no `ETag`, so no 304s) against **~48 ms and 540 B** for `GET /session/{id}`, which still carries `time.updated`. So the cost is per *session*, not per tick, and the poll is tiered accordingly: the fast cadence asks only for sessions LaLog already tracks (`GET /session/{id}`, skipping any untouched for a whole window) and the full list runs only every `discoverySec` (default 180 s, clamped to `floor(idleConfirm / 2)`) — the only way a brand-new chat can be found, so that setting is the detection latency. The fast interval also went 20 s → 30 s (a 30x margin on idle confirmation) to halve request volume, and a tick's requests are issued sequentially, never as a fan-out.
8. **Config: `manageServe` (true), `spawnPort` (0), `opencodePath` ("opencode").** `enabled` stays the opt-in and stays false by default; `manageServe: false` is a full revert to ADR-032's observe-only behavior, polling the configured URL and touching no process. `opencodePath` exists for managed installs and wrappers.
9. **Pure Node, injectable seams.** `src/opencode/serveProcess.ts` imports no `vscode`, no `node:http` client, and uses global `fetch` only through injected dependencies (`readdir`, `readFile`, `readlink`, `execFile`, `spawn`, `fetchImpl`, `sleep`), so every test is hermetic: no test spawns a real process, reads `/proc`, or touches the network.

**Reconciliation with ADR-005 and ADR-011**: this ADR does **not** amend ADR-005. Everything stays on `127.0.0.1` on the user's own machine, nothing new leaves it, and no telemetry is added; spawning a CLI the user already installed is local execution, exactly like `opencode run` in ADR-011. ADR-011's one-way rule is likewise intact: `core` never imports `opencode/`, `src/core/types.ts` still owns the two-method `ServeActivityWatcher` the manager depends on, and `extension.ts` is still the only composition root. What ADR-032 decided against was *foreign* process management, and ownership-by-construction is what makes this version of it safe.

**Rationale**:
- Reuse is the cheapest win available: it makes the feature work out of the box while keeping the number of `opencode` processes at exactly what the user would have had by hand.
- Branding ownership in the type means the dangerous operation — killing a server the user may be typing into — cannot be expressed, not merely that it is avoided by convention.
- A random password costs nothing (it is a local server) and removes the default-insecure configuration that ADR-032 shipped.
- Adaptive polling follows ADR-032's first sight-is-a-baseline rule into time: the watcher is told to be precise while work is happening and cheap while it is not. The cadence ceiling (~15 min across three polls) still sits well inside the `idleConfirm` window.
- Silence on failure preserves ADR-032's tone: a tracker that cannot see the server must not nag, and it must certainly not report time it did not observe.

**Implementation**:
- `src/opencode/serveProcess.ts` (new) — `discoverServe` (Linux `/proc` scan, `ps` fallback, cwd and loopback matching, one verified `GET /session`), `spawnServe`, `stopServe`, `parseServeCmdline`, `parseListeningUrl`, `normalizeFsPath`, `ServeProcessDeps`, `OwnedServe`/`DiscoveredServe`, `ServeProcessError`.
- `src/opencode/serveWatcher.ts` — the injectable `ServeLifecycle` seam, `manageServe`/`opencodePath`/`spawnPort`/`slowMs`/`discoveryMs`/`shouldObserve` options, `ensureServer`, `releaseOwned`, the two-tier `tick()` (`fetchSessionList` on the `discoveryMs` cadence, one `fetchSession(id)` per tracked session otherwise, both sequential), `wake()`, `armed`, `retainedSessionIds()`, adaptive `nextDelayMs`, and the `SELF_TITLE_PREFIX` skip that ADR-032 specified but v1 never applied.
- `src/core/config.ts` — `OpencodeActivityConfig.manageServe`/`.spawnPort`/`.opencodePath`, their defaults, and `opencodeSlowPollMs(cfg)` (the `idleConfirm`/3 clamp stays on the fast end only); plus `discoverySec` (default 180) and `opencodeDiscoveryMs()`, clamped to `floor(idleConfirm / 2)`.
- `src/extension.ts` — constructs the watcher with the new options and `shouldObserve: () => manager.getSession() !== null`, calls `wake()` on state changes, and stops/disposes it on deactivate.
- `package.json` — the three new `lalog.opencode.activity.*` contributions, and later `discoverySec` (default 180).
- Tests — `test/userStories/serveProcess.test.ts` (new: cmdline recognition, discovery incl. foreign cwd and routable interface, silent failure, spawn args/password, readiness, timeout-and-kill, child exit, stop escalation, ownership) and `test/userStories/opencodeServeActivity.test.ts` (gating, idle release, reuse-without-spawn, spawn, re-ensure after child exit, ensure backoff, observe-only mode, cadence doubling/cap/reset, workspace-only retention).

**Future**:
- SSE `GET /event` was measured and rejected (decision 7): it costs the server more than the polls it would replace. Revisit only if opencode's event stream stops doing server-side work per heartbeat.
- Discovery is best-effort: on platforms without a cheap cwd lookup, or for a serve started without `--port`, LaLog sees nothing and simply starts its own (never two for the same window, because the next poll discovers it). A visible "reusing the serve on :4096" status line would make reuse legible instead of invisible.
- Deliberately not done: remembering a spawned pid across restarts (the brand is per-process, by design) and reusing the `OPENCODE_SERVER_PASSWORD` of a discovered serve (it is never readable, so a discovered server is polled only when it is unauthenticated or already configured to match).

---

## ADR-034: opencode Chat Activity Is On by Default (amends ADR-032, ADR-033)

**Status**: Accepted · **Amends**: [ADR-032](#adr-032-opencode-serve-activity-is-observed-never-managed) (the opt-in), [ADR-033](#adr-033-reuse-first-opencode-serve-lifecycle-owned-or-not-at-all-amends-adr-032) (decision 8: "`enabled` stays the opt-in and stays false by default") · **Reconciles with**: [ADR-005](#adr-005-local-only--zero-telemetry), [ADR-011](#adr-011-optional-ai-assistance-amends-adr-005)

**Context**: ADR-033 built the machinery that makes the feature work without effort — discover a serve for this workspace and reuse it, spawn one only if there is nothing to reuse, authenticate it with a random password, stop only what it started. All of it sits behind `lalog.opencode.activity.enabled`, which shipped `false`. The result is that a feature engineered to be invisible is invisible by default: a fresh install launches a server manager, a poller and an authenticator and never runs any of it.

The cost is not a missing feature, it is a wrong bill. `SessionManager.checkIdle` fires "Are you still there?" off `lastActivityAt`, and that field only advances from VS Code capture and from `onActivityEvent('opencode', …)`. With the watcher off, a developer working entirely inside an opencode chat with no keyboard activity is asked whether they are present while they demonstrably are — and if they answer "I was away", `trimIdleAwayWindow` deletes tracked time that was real. The product's central promise is that tracked time is time actually worked; a default that lets a live opencode session be trimmed away as phantom breaks it.

The opt-in was defensible when observing meant *connecting to a server on a port the user had to remember* (ADR-032's world). After ADR-033 it does not describe the remaining cost. That cost is already bounded: nothing runs at all without an open LaLog session (`shouldObserve`), reuse means the common case — a user already running opencode — spawns no extra process, and the only data crossing the wire is the four metadata fields ADR-032 fixed.

**Decision**:
1. **`lalog.opencode.activity.enabled` defaults to `true`.** Observation is the expected behavior for an extension whose job is to know when you are working. `false` remains a supported, documented one-setting opt-out for a fully local, zero-request install, and `package.json` says so in the setting description.
2. **Nothing else moves.** `manageServe` (true), `spawnPort` (0), `opencodePath`, the metadata-only contract, the loopback-only binding, the random password for a spawned serve, reuse-before-spawn, ownership-by-brand, and the adaptive two-tier cadence are all unchanged from ADR-033. This amendment changes *when the feature starts*, not what it is allowed to do.
3. **Independence from `lalog.ai.enabled` is unchanged and still asserted.** AI off must not turn observation off, and observation on must not turn AI on — both directions are covered by tests, because the two opt-ins answer different questions.
4. **Hermeticity is a test concern, not a product concern.** The test harness pins `lalog.opencode.activity.enabled: false` unless a test opts in, so the new product default cannot make `activate()` build a live watcher. ADR-033's decision 9 invariant — no test spawns a real process, reads `/proc`, or touches the network — survives the flip, and that is the only reason the flip is safe to make.
5. **The settings-default assertions were rewritten, not deleted.** `nonGoals.test.ts` and `privacyConfig.test.ts` still assert the setting's default and the loopback `url` default; they now assert `true`. A privacy carve-out whose guard was deleted would be worse than no guard, and "on by default" is exactly the kind of claim that needs a test pinning it.

**Reconciliation with ADR-005 and ADR-011**: still no amendment to ADR-005. Everything remains on `127.0.0.1` on the user's own machine, no telemetry is added, message content is never read, and no prompt is ever sent. The single new default behavior is a localhost metadata read plus — only when the user is already running opencode against this workspace and has no reusable serve — a local process the user could have started by hand. ADR-011's one-way rule is untouched: `core` still never imports `opencode/`, `core/types.ts` still owns `ServeActivityWatcher`, and `extension.ts` is still the only composition root.

This is a deliberate reversal of a privacy-adjacent default, and it is recorded as one. The case for it is that the previous default made the extension misreport the user's working time, and a tool that bills phantom time as real is broken in a way a localhost read is not.

**Rationale**:
- **A default that silently under-reports is worse than a default that reads localhost.** The failure mode of `false` was invisible and wrong; the failure mode of `true` is visible, documented, and one setting away.
- **ADR-033 already removed the scary part.** "LaLog will start a server" was the objection that justified opt-in; reuse-first, the random password and the owned-stop guarantee answered it. Keeping the opt-in after that answered it was inertia, not caution.
- **`shouldObserve` keeps the blast radius at zero when idle.** No open LaLog session means no timer, no request, and no serve of its own — the on-by-default path is inert in an idle window, so the default costs nothing when there is nothing to observe.
- **Reuse means the default usually adds no process.** A developer using opencode already has a serve for the workspace; ADR-033's `discoverServe` finds it by cwd and polls it read-only, so the common case is a few hundred bytes every 30 s against a server already in memory.

**Implementation**:
- `src/core/config.ts` — `OPENCODE_ACTIVITY_DEFAULTS.enabled` → `true`, and the interface comment.
- `package.json` — the `lalog.opencode.activity.enabled` contribution: `default: true`, description rewritten to state the opt-out.
- `test/helpers/harness.ts` — `activateExtension` pins the namespace to `{ enabled: false, ...opts.activity }`, replacing the previous "only set what the test cares about" behavior, so activation tests never construct a live watcher.
- Tests — `opencodeServeActivity.test.ts` (the config-default test now asserts `true`, still asserts both directions of independence from `lalog.ai.enabled`, and now covers the explicit opt-out; the lifecycle-defaults test asserts the master switch is untouched by the lifecycle keys), `nonGoals.test.ts`, `privacyConfig.test.ts`.
- Docs — `README.md`, `docs/features.md`, `docs/architecture.md`.

**Future**:
- The opt-out is discoverable only if the user looks. If the "Are you still there?" prompt fires while an opencode chat is provably active, that is a *detection* failure, not a config failure, and it deserves its own surface (ADR-033 already notes that a "reusing the serve on :4096" status line would make reuse legible).
- If opencode ever exposes a cheap authenticated push for session `time.updated`, the polling cost argument in ADR-033 decision 7 should be re-measured against it.

---

## ADR-035: A Prompt Threshold Is an Interval Since Your Answer, Not a Session Total

**Status**: Accepted · **Reconciles with**: [ADR-003](#adr-003-active-time-only-no-idle-billing) (accrual), [ADR-007](#adr-007-auto-close-uses-lastactivityat) (auto-close)

**Context**: `describeAfterMinutes` and `wrapAfterMinutes` were tested as cumulative totals for the whole session: `onActivity` asked `activeMinutes >= describeAt`. `activeMinutes` never resets while a session is open, so past the threshold the predicate is permanently true. Answering the prompt set the state back to `active`, and the *very next* activity event flipped it straight to `describePending` again. The next breakpoint — or the 30-minute force timer, which was never disarmed when a breakpoint delivered the prompt instead — presented the same question again.

The report from the field was that prompts *stack*: leave for a while, answer one, and the others surface over the following minutes. In a reproduction, one describe answer produced four prompts. The wrap prompt had the same defect twice over: `skipped` left the state at `wrapPending` (so the next breakpoint re-asked), and `extend` set `grace`, which the next keystroke converted back to `wrapPending` because the same cumulative predicate held.

The coordinator's mutex and min-spacing (US-3.1) never applied here: they stop two prompts being *visible* at once, which is a different question from whether a prompt is *due*. A prompt that is due again is not a stacked prompt until it appears — and once the user has answered, it should not be due at all.

**Decision**:
1. **Each prompt threshold is measured from an anchor, not from zero.** `Machine` carries `describeAnchor` / `wrapAnchor` (active-time ms). A checkpoint is due when `activeMinutes - anchor >= threshold`.
2. **Every reply re-arms.** `rearmDescribe` / `rearmWrap` set the anchor to the active total of the moment the user answered. All outcomes count — described, background, deferred, skipped, dismissed — because each one is an answer, and the point is that the interval restarts from the response.
3. **A force timer is disarmed when its prompt is shown by any other route** (`clearForceTimer`). Previously it was deleted only by firing, so a prompt delivered at a breakpoint left a timer that would re-ask later.
4. **Wrap is evaluated before describe in `onActivity`.** `wrapAt` is always later than `describeAt`, so a due wrap interval subsumes describe; checking wrap first is what stops a `skip` on the wrap prompt from dropping to `active` with describe instantly due again. `rearmWrap` therefore re-arms both anchors — reaching wrap means describe is behind us.
5. **`skip` and Esc on the wrap prompt return to `active` with the interval re-armed.** No grace window, no free extension spent. `extend` keeps the grace timer, and grace expiry now delivers the re-prompt directly (`presentWrap('force')`) rather than holding it for another 30-minute force window — US-3.8 says "re-prompted afterwards", and the grace expiry is the "afterwards".
6. **Reductions clamp the anchors.** `adjustTrackedTime` and `trimIdleAwayWindow` lower `activeMinutes`; both pull the anchors back so a checkpoint is not left looking overdue, and a correction that retires the wrap interval clears its force and grace timers with it.

**Rationale**:
- **The user's mental model is an interval, not a budget.** "Every 90 minutes, tell me what I'm doing" means 90 minutes after the last time I told you. A cumulative reading makes the prompt a permanent condition of a long session, which is why it recurred.
- **Answering is the event that ends the obligation.** Deferring and skipping are answers too, so all four paths re-arm; singling out the happy path would leave US-3.6 ("Later") nagging, which it did.
- **Stacking and re-asking are the same bug seen from two sides.** Nothing was ever queued — each prompt was independently due because the total never fell back below the threshold. Fixing the anchor removes the cause rather than filtering the symptom at the prompt layer, so the mutex stays the single-prompt guarantee it was always meant to be.
- **Order matters and is not cosmetic.** Wrap-before-describe is what makes `skip` coherent. The reverse order re-arms describe on the next event, which is the same failure one layer down.

**Implementation**:
- `src/core/stateMachine.ts` — `describeAnchor` / `wrapAnchor` on `Machine` (reset in `startSession`), `rearmDescribe` / `rearmWrap`, and the anchor-based predicates with wrap checked first.
- `src/core/sessionManager.ts` — `rearmDescribe` on every describe outcome; `rearmWrap` on every wrap outcome with `skip`/dismiss returning to `active`; `enterWrapIfDue` (anchor-based, replacing the inline `activeMinutes >= wrapAt` checks in `applyDescribeResult`); `clearForceTimer` called when a prompt runs and when a correction retires the wrap interval; `armGraceTimer` delivering the re-prompt at expiry.
- Tests — `prompts.test.ts` gains the re-arm cases (answer, defer, wrap-skip, and that a fresh interval asks exactly once); `adjustTime.test.ts`'s wrap-state precondition now asserts the re-armed outcome.

**Future**:
- `Machine.lastPromptAt` and `describeDefers` are still unused fields kept for shape compatibility. If a future feature needs a prompt history (e.g. "you were asked 4 times"), `lastPromptAt` is the natural home and should be persisted with the session rather than left in memory.

---

## Related Pages

- [Architecture](architecture.md) — module overview and data flow
- [Features](features.md) — detailed feature documentation
- [Data Format](data-format.md) — JSONL schema and snapshot format
- [Roadmap](roadmap.md) — what's NOT built