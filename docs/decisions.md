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
- **No zombie sessions** — on recovery, check idle duration and auto-close if ≥ 2h

**Implementation**:
- `SessionManager.scheduleSave()` — called on every state change
- `SessionManager.heartbeatTimer` — `setInterval` every 60 seconds
- `SessionStore.saveActive(session)` — atomic snapshot write
- `SessionStore.loadActive(wsKey)` — load snapshot on recovery

**Recovery flow**:
1. Load snapshot
2. Check idle duration (`now - lastActivityAt`)
3. Decide: auto-close (≥ 2h), resume (< 30min), or continue (30min–2h)
4. Rebuild in-memory `Machine` from snapshot

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
- `SessionManager.openWorkspace()` — checks idle duration on recovery

**Edge cases**:
- **30min–2h idle** — session continues, gap uncounted (you took a break but came back)
- **< 30min idle** — session resumes, `lastActivityAt` reset to avoid gap accrual
- **≥ 2h idle** — session auto-closes, offer closing note

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
2. **Idle confirmation**: after `idleConfirmAfterMinutes` (15) of no VS Code activity, the heartbeat fires "Are you still there?". *Yes* keeps the current span open — the idle stretch is counted as active, but is **not** VS Code activity. *No* ends the session. This makes confirmed-outside work count while keeping it separable.
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



## Related Pages

- [Architecture](architecture.md) — module overview and data flow
- [Features](features.md) — detailed feature documentation
- [Data Format](data-format.md) — JSONL schema and snapshot format
- [Roadmap](roadmap.md) — what's NOT built