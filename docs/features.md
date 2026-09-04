# Features

[Home](README.md) > **features**

> Every feature of the LaLog extension, organized by area.

---

## Table of Contents

- [Session Tracking](#session-tracking)
- [Automatic Event Capture](#automatic-event-capture)
- [Prompt System](#prompt-system)
- [Storage & Persistence](#storage--persistence)
- [User Interface](#user-interface)
- [Reporting](#reporting)
- [Integrations](#integrations)
- [Configuration](#configuration)
- [Commands](#commands)

---

## Session Tracking

### Session Model

A **session** represents a continuous engagement thread with a workspace. Sessions are:

- **NOT day-bound** — an overnight coding session from 22:00 to 02:00 is a single session
- **Bounded only by idle** — auto-close triggers after ~2h of no activity
- **Workspace-scoped** — each workspace folder has its own session track
- **Persistent** — active sessions are snapshotted every 60s and on every state change

### Session Lifecycle

1. **Activation** — extension activates on `onStartupFinished` or `onDidChangeWorkspaceFolders`
2. **Recovery** — if an active session snapshot exists for the workspace:
   - Idle ≥ 2h → auto-close (endedAt = lastActivityAt), offer closing note
   - Idle < 30min → resume session (reset lastActivityAt to avoid gap accrual)
   - 30min ≤ idle < 2h → continue session (gap uncounted)
3. **New session** — if no snapshot exists, prompt: *"Work in \<workspace\>? Start a session?"*
   - Options: "Start a work session", "Continue yesterday's thread" (if previous exists), "No, keep it untracked"
4. **Active tracking** — events accrue active minutes (gap-based model)
5. **Describe prompt** — after ~90 active minutes, prompt at natural breakpoint
6. **Wrap prompt** — after ~3.5h active minutes, prompt to wrap or extend
7. **End** — user ends manually, or auto-close after 2h idle

### "Start a new session?" on Open

When VS Code opens a workspace with no active session:

```
┌─────────────────────────────────────────┐
│  Work in my-project?                    │
│  Track this work session?               │
│                                         │
│  $(history) Continue yesterday's thread │
│     "Fix login bug"                     │
│  $(play) Start a work session           │
│     workspace: my-project               │
│  $(mute) No, keep it untracked          │
│     one gentle reminder later           │
└─────────────────────────────────────────┘
```

- If a previous session exists for this workspace, a "Continue yesterday's thread" option appears with the previous description
- Choosing "No" puts the session in `untracked` state — a single nudge will appear after 30 active minutes

### Auto-Assignment to Explicit Session

When the user explicitly starts a session (via the prompt or `lalog.startSession` command), all subsequent events are assigned to that session. Events that arrived before the session started (in `untracked` state) are not retroactively assigned.

---

## Automatic Event Capture

The `ActivityTracker` listens to VS Code events and forwards them to the session manager. No user action required.

### Captured Events

| Event Type | VS Code API | Debounce | Notes |
|------------|-------------|----------|-------|
| `editor` | `onDidChangeActiveTextEditor` | None | Switching between files |
| `edit` | `onDidChangeTextDocument` | 2 seconds | Coalesces rapid keystrokes; only `file://` URIs |
| `save` | `onDidSaveTextDocument` | None | Only `file://` URIs |
| `fileop` | `onDidCreateFiles`, `onDidDeleteFiles`, `onDidRenameFiles` | None | File creation, deletion, rename |
| `terminal` | `onDidStartTerminalShellExecution`, `onDidEndTerminalShellExecution` | None | Requires VS Code ≥ 1.93 shell integration; fallback: terminal open/close |
| `task` | `onDidStartTask` | None | Task execution start |
| `debug` | `onDidStartDebugSession`, `onDidTerminateDebugSession` | None | Debug session start and end |

### Edit Debounce

Edits are debounced with a 2-second delay to avoid flooding the event stream with rapid keystrokes. If multiple edits arrive for the same file within 2 seconds, only one `edit` event is emitted (with the timestamp of the last edit).

### Terminal Command Logging

Terminal commands are captured if `lalog.logTerminalCommands` is enabled (default: true). The extension feature-detects the shell integration API (`onDidStartTerminalShellExecution`) and falls back to terminal open/close events on older VS Code versions.

**Redaction**: Terminal commands are scanned against `lalog.redactPatterns` (default: `TOKEN`, `KEY`, `SECRET`, `PASSWORD`, `PASS=`, `API_KEY`, `api[-_]?key`). Matching patterns are redacted before storage.

*Note: The current implementation captures terminal events as counters (edits, saves, terminal counts) but does not store the actual command text in the session object. The redaction patterns are defined in config but the command text logging is not yet implemented in the event recording pipeline.*

### Top Files Tracking

The `SessionStore` maintains a top-10 list of most-edited files per session:

```typescript
interface FileTouch {
  path: string;
  edits: number;
  firstTouch: number;
  lastTouch: number;
}
```

- Updated on every `edit` event
- Sorted by edit count, capped at 10 files
- Used for describe pre-fill and report generation

---

## Prompt System

### Prompt Coordinator

The `PromptCoordinator` enforces:

1. **Mutex** — only one prompt visible at a time (`acquire()` / `release()`)
2. **Minimum spacing** — at least 2 minutes between prompts (scaled by `debugTimeScale`)
3. **Non-blocking** — if `acquire()` fails, the prompt is silently skipped

### Describe Prompt (~90 active minutes)

Triggered when `activeMinutes >= describeAt` (default 90 min). Delivered at a natural breakpoint or forced after 30 minutes.

**Two-step flow:**

1. **QuickPick** — "What are you working on?"
   - Options: `feature`, `bugfix`, `research`, `refactor`, `review`, `docs`, `ops`, `other`
   - If a previous session exists: "Same as last: \<description\>" option
   - "Later" option — skip for now, flagged as `needsDescription`

2. **InputBox** — "Describe (\<type\>)"
   - Pre-filled with deterministic data from the live session:
     - Git branch: `[main]`
     - Top 3 edited files: `file1.ts, file2.ts, file3.ts`
     - Terminal work: `(terminal work)` if no file edits
   - User can edit the pre-fill or write from scratch
   - Esc = skip (flagged `needsDescription`)

**Result handling:**
- `described` → session gets `type` and `description`, state → `active` (or `wrapPending` if past wrapAt)
- `later` → session flagged `needsDescription`, state → `active`
- `skipped` → session flagged `needsDescription`, state → `active`

### Wrap Prompt (~3.5h active minutes)

Triggered when `activeMinutes >= wrapAt` (default 210 min). Delivered at a natural breakpoint or forced after 30 minutes.

**QuickPick** — "Session \<description\> at 3h30m — wrap it up?"

Options:
- `$(split-horizontal) Wrap session & start a new one` — close current, start fresh
- `$(clock) Extend 30 min` — grace period, re-prompt after 30 min
- `$(pencil) Add/update description` — describe before wrapping
- `$(mute) Skip` — handle later from sessions view

**Extend logic:**
- Each "Extend" increments `graceExtensions`
- After `maxGraceExtensions` (default 3), the user **must** describe to continue
- Grace period: 30 minutes, then re-prompt with wrap
- Hard split at 5h (`hardSplit`) — coordinator handles auto-split

### Closing Note (Auto-Close Recovery)

When a session auto-closes (idle ≥ 2h) without a description:

```
┌─────────────────────────────────────────┐
│  Unfinished session "my-project"        │
│  (2h 15m active)                        │
│                                         │
│  closing note (what got done)?          │
│  ┌───────────────────────────────────┐  │
│  │ [pre-filled with description]     │  │
│  └───────────────────────────────────┘  │
│  Enter to save · Esc to skip            │
└─────────────────────────────────────────┘
```

### Breakpoint-Aligned Delivery

Prompts are **not** delivered on fixed timers. They are held until a natural breakpoint:

| Breakpoint | Trigger | Source |
|------------|---------|--------|
| `terminal` | Terminal command ends | `onDidEndTerminalShellExecution` |
| `git-commit` | `git commit` command ends | Regex match on command line |
| `debug` | Debug session terminates | `onDidTerminateDebugSession` |
| `return-idle` | Return from idle gap ≥ 5 min | `BreakpointDetector.checkReturnIdle()` |
| `force` | Force timer expires (30 min after prompt threshold) | `setTimeout` in SessionManager |

This ensures prompts don't interrupt flow — they arrive when you're already pausing.

---

## Storage & Persistence

### JSONL Append-Only

Closed sessions are appended to `~/.lalog/sessions.jsonl`:

```jsonl
{"id":"20260903-2200-a1b2-c3d4","workspaceKey":"abc1234567","workspaceName":"my-project","startedAt":1725397200000,"endedAt":1725404400000,"lastActivityAt":1725404400000,"activeMinutes":95,"type":"feature","description":"Fix login bug","notes":[],"needsDescription":false,"events":{"edits":142,"saves":23,"terminal":8,"topFiles":[...]},"gitBranch":"fix/login","commits":[{"hash":"a1b2c3d","subject":"Fix login validation"}],"closedReason":"user"}
```

- **Append-only** — no read-modify-write for normal operation
- **Crash-safe** — POSIX near-atomic append (open, write, close)
- **Human-readable** — `cat sessions.jsonl | jq .` works
- **Exception**: `updateSession()` rewrites the full file (used by "Edit session" command)

### Active Session Snapshots

Active sessions are persisted as atomic JSON snapshots in `~/.lalog/active/<wsKey>.json`:

- Written every 60 seconds (heartbeat timer)
- Written on every state change
- Atomic: write to `.tmp` → rename
- Deleted when session closes

### Recovery on Restart

On activation, the extension:
1. Loads the active snapshot for the current workspace
2. Checks idle duration (`now - lastActivityAt`)
3. Decides: auto-close, resume, or continue (see [Session Lifecycle](#session-lifecycle))
4. Rebuilds the in-memory `Machine` from the snapshot

### Workspace Key

Each workspace is identified by a SHA-1 hash of its realpath (first 10 hex chars):

```typescript
workspaceKey(folderUri) → crypto.createHash('sha1').update(realpath).digest('hex').slice(0, 10)
```

This ensures stable identification even if the workspace is opened via symlink or different path.

---

## User Interface

### Status Bar

Left-aligned status bar item (priority 100):

- **No active session**: `$(watch) 1h 42m today`
- **Active session**: `$(play) Fix login bug · 2h 15m`
- **Tooltip**: `LaLog — 1h 42m today · 5m untracked\nClick for quick actions`
- **Click**: Opens quick actions menu (Describe / End / Report)

### Sessions View (Sidebar)

Tree view in the activity bar (LaLog icon):

```
┌─────────────────────────────────┐
│ SESSIONS                        │
│                                 │
│ ▼ 2026-09-03 — 3 sessions, 5h  │
│   14:30 · my-project — Fix...   │
│   10:00 · my-project — Res...   │
│   09:00 · my-project            │
│                                 │
│ ▼ 2026-09-02 — 2 sessions, 3h  │
│   15:00 · other-project         │
│   09:00 · other-project — ...   │
└─────────────────────────────────┘
```

- Sessions grouped by start-date day (newest first)
- Day headers show session count and total duration
- Session items show: start time, workspace name, description (or "needs description")
- Warning icon (⚠) for sessions needing description, check icon (✓) for described sessions
- Click session → `lalog.editSession` command

### Quick Actions Menu

Clicking the status bar opens:

```
┌─────────────────────────────────┐
│ LaLog                           │
│                                 │
│ $(pencil) Describe current      │
│ $(check) End session            │
│ $(calendar) Generate report     │
└─────────────────────────────────┘
```

---

## Reporting

### Session-Centric Reports

Reports are **session-centric** — sessions are never split across days or months. A session that starts at 23:00 and ends at 01:00 appears entirely under the day it started.

**Report ranges:**
- Today
- Yesterday
- This week (Monday-based)
- This month
- Last month

**Report format** (Markdown):

```markdown
# LaLog — This Week

**Active time: 12h 30m** across 8 session(s)

Sessions started: 2026-09-01, 2026-09-02, 2026-09-03

## By project
- **my-project**: 8h 15m
- **other-project**: 4h 15m

## Sessions

### Sep 3, 14:30 → 16:45 · 2h 15m · my-project · feature
— Fix login bug
*Files: auth.ts, login.ts, validation.ts*
*Branch: fix/login*
*Commits: `Fix login validation`, `Add error handling`*

### Sep 3, 10:00 → 12:30 · 2h 30m · my-project · research
— Research OAuth providers
*Files: config.ts, oauth.ts*
*Branch: feature/oauth*
```

**Report storage**: Saved to `~/.lalog/reports/YYYY-MM.md` (monthly file, overwritten on each report generation).

### Aggregate Helpers

- `todayActiveMs(sessions, now)` — sum of active time for sessions started today
- `todayUntrackedMs(sessions, now)` — sum of active time for sessions lacking descriptions

Used by the status bar to display today's totals.

---

## Integrations

### Git Integration

When a session ends (via `lalog.endSession` command), the extension annotates it with git data:

1. **Branch** — `git branch --show-current` → `session.gitBranch`
2. **Commits** — `git log --since=<startedAt> --until=<endedAt>` → `session.commits[]`

```typescript
interface SessionCommits {
  hash: string;    // short hash (7-40 chars)
  subject: string; // commit message subject
}
```

- Only runs if the workspace is a git repository
- Best-effort: errors are silently ignored
- Commits are filtered by the session's start/end timestamps

### Legacy Export (files_by_day.txt)

The `lalog.exportFilesByDay` command generates a legacy export format compatible with the user's `group_file_histories.sh` script:

```
2026-09-03:
  - backend/auth.py
  - backend/login.py
  - frontend/App.tsx

2026-09-02:
  - backend/config.py
```

- Files are listed under each calendar day on which they had edit events
- Midnight-spanning sessions: files appear under both days if edits happened on both
- Grouped by project slug (top-level directory name)
- Output: `~/.lalog/exports/<slug>/files_by_day.txt`

---

## Configuration

All settings are under `lalog.*` in VS Code settings (`settings.json`).

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `lalog.dataDir` | string | `~/.lalog` | Data directory. Tilde expands to home. Useful for Remote-SSH synced paths |
| `lalog.describeAfterMinutes` | number | `90` | Active minutes before describe prompt |
| `lalog.wrapAfterMinutes` | number | `210` | Active minutes before wrap prompt (3.5h) |
| `lalog.graceMinutes` | number | `30` | Extension length on "Extend" choice |
| `lalog.maxGraceExtensions` | number | `3` | Max free "Extend" choices before description required |
| `lalog.idleGapMinutes` | number | `5` | Gap between events that still counts as active |
| `lalog.autoEndAfterIdleMinutes` | number | `120` | Idle time before auto-close (2h). Sessions are not day-bound; this is the only boundary |
| `lalog.resumeWindowMinutes` | number | `30` | Recovery: if last activity was within this window on restart, offer resume |
| `lalog.debugTimeScale` | number | `1` | Divide all time thresholds by this factor. Set 60 to test a "4-hour" session in 4 minutes |
| `lalog.logTerminalCommands` | boolean | `true` | Record terminal commands (requires shell integration) |
| `lalog.redactPatterns` | string[] | `["TOKEN", "KEY", "SECRET", "PASSWORD", "PASS=", "API_KEY", "api[-_]?key"]` | Regex patterns redacted from logged terminal commands |

### Threshold Resolution

All time settings are resolved to milliseconds with `debugTimeScale` applied:

```typescript
thresholdsMs(cfg) → {
  idleGap: 5 * 60 * 1000 / scale,
  describeAt: 90 * 60 * 1000 / scale,
  describeForce: 120 * 60 * 1000 / scale,  // describeAt + 30min
  wrapAt: 210 * 60 * 1000 / scale,
  wrapForce: 240 * 60 * 1000 / scale,      // wrapAt + 30min
  grace: 30 * 60 * 1000 / scale,
  hardSplit: 300 * 60 * 1000 / scale,      // 5h hard limit
  autoEndIdle: 120 * 60 * 1000 / scale,
  resumeWindow: 30 * 60 * 1000 / scale,
  untrackedNudge: 30 * 60 * 1000 / scale,
  maxGraceExtensions: 3,
}
```

---

## Commands

| Command | ID | Description |
|---------|----|-------------|
| Start session | `lalog.startSession` | Begin a new session in the current workspace |
| End session | `lalog.endSession` | Close the current session (with git annotation) |
| Describe now | `lalog.describeNow` | Trigger the describe flow immediately |
| Generate report | `lalog.report` | Session-centric markdown report (today/week/month) |
| Show sessions | `lalog.showSessions` | Focus the sessions sidebar view |
| Edit session | `lalog.editSession` | Update a session's description |
| Export files by day | `lalog.exportFilesByDay` | Legacy `files_by_day.txt` export |

---

## Related Pages

- [Architecture](architecture.md) — module overview and data flow
- [Decisions](decisions.md) — why sessions aren't day-bound, gap-based time model, etc.
- [Data Format](data-format.md) — JSONL schema and snapshot format
- [Development](development.md) — build, test, and run