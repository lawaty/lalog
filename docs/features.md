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
- **Always monitored** — events are never dropped: if a session ended (auto-close, manual end) and activity resumes, a fresh session starts silently at the next event
- **Workspace-scoped** — each workspace folder has its own session track
- **Persistent** — active sessions are snapshotted every 60s and on every state change

### Session Lifecycle

1. **Activation** — extension activates on `onStartupFinished` or `onDidChangeWorkspaceFolders`
2. **Recovery** — if an active session snapshot exists for the workspace (a leftover from an abnormal exit), it is auto-closed as `recovery-skip` (endedAt = lastActivityAt) **without prompting**; a fresh session starts
3. **New session** — tracking **auto-starts** (never untracked). An optional on-start description prompt records what you're working on (`lalog.askDescriptionOnStart`). Closed/past sessions are never asked about
4. **Active tracking** — events accrue active time gap-based; each contiguous run is a span; confirmed-idle time extends a span classified as *outside VS Code*
5. **Describe prompt** — after ~90 active minutes, prompt at natural breakpoint
6. **Wrap prompt** — after ~3.5h active minutes, prompt to wrap or extend
7. **Idle check** — after `idleConfirmAfterMinutes` (15) of no activity, "Are you still there?"; confirming keeps the span open (counted outside VS Code), ending or ignoring stops/skips
8. **End** — user ends manually, VS Code closes (`vscode-shutdown`), or auto-close after 2h idle
9. **Auto-restart** — any event that arrives with no open session (after a manual end or auto-idle close) silently starts a fresh session, so work is tracked even if every description/update prompt was skipped

### Auto-Start on Open

Opening a workspace with no active session starts tracking immediately — there is no "untracked" state. One optional pre-session dialog may appear:

1. **On-start description** (`lalog.askDescriptionOnStart`, default on) — a short "what are you working on?" prompt offered **a few minutes in** (`lalog.startDescriptionAfterMinutes`, default 5) rather than immediately, so it never interrupts the first thing you do. It fires once and only if no description has been added yet:

```
┌─────────────────────────────────────────┐
│  Session started · "my-project"         │
│  — what are you working on?             │
│                                         │
│  [type what you're doing]               │
│  Optional · Esc to skip                 │
└─────────────────────────────────────────┘
```

If it's skipped, the session keeps tracking anyway and can be described later (describe checkpoint, progress note, or the sessions view). Nothing is ever left untracked — all work is recorded.

### Auto-Assignment to Explicit Session

Because sessions always auto-start, every event belongs to the active session of its workspace. The `lalog.startSession` command (or wrap "start a new one") ends the current session and begins a fresh one; subsequent events are assigned to the new session.

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

Terminal commands are captured if `lalog.captureTerminal` is enabled (default: true). The extension feature-detects the shell integration API (`onDidStartTerminalShellExecution`) and falls back to terminal open/close events on older VS Code versions.

**Captured data**: command line, exit code, duration, working directory, and confidence level. Stored in the per-session technical sidecar (`~/.lalog/technical/<sessionId>.jsonl`), not in the main session object.

**Stdout capture** is opt-in (`lalog.captureTerminalStdout`, default: off). When enabled, terminal output is captured via `TerminalShellExecution.read()`, ANSI-stripped, redacted, and capped at `lalog.maxStdoutChars` (32,000 chars). This requires shell integration and the `read()` call must attach at command start — output produced before the handler runs cannot be captured.

**Redaction**: Terminal commands and stdout are scanned against `lalog.redactPatterns` (default: `TOKEN`, `KEY`, `SECRET`, `PASSWORD`, `PASS=`, `API_KEY`, `api[-_]?key`). Matching patterns are replaced with `[REDACTED]` before storage.

### Technical Detail Capture

LaLog captures the **technical content** of work so reports and AI can understand what was actually done. All technical detail is stored in a per-session sidecar JSONL file (`~/.lalog/technical/<sessionId>.jsonl`) to keep the main session store compact.

#### File Diff Capture

When `lalog.captureDiffs` is enabled (default: true), a unified diff is generated at each file save:

- **First save** for a path: produces a new-file diff (all lines added, `newFile: true`)
- **Subsequent saves**: standard unified patch between previous and current content
- **Binary files** (null byte in first 8KB) are skipped
- **Identical saves** produce no entry
- Diffs are redacted against `lalog.redactPatterns` and capped at `lalog.maxDiffChars` (16,000 chars)
- At most 100 files are tracked simultaneously (LRU eviction of oldest)

#### AI Interaction Logging

When `lalog.captureAiLog` is enabled (default: true), AI calls (describe, narrative, analysis) are logged with:

- Task name, model identifier, latency
- Prompt and response character counts (never the text itself)
- Whether the response was truncated

This metadata helps understand what AI assistance was used during a session without storing any prompt or response content.

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
| `return-idle` | Return from idle gap ≥ 15 min | `BreakpointDetector.checkReturnIdle()` |
| `force` | Force timer expires (30 min after prompt threshold) | `setTimeout` in SessionManager |

This ensures prompts don't interrupt flow — they arrive when you're already pausing.

### Session Notes Timeline

Every description and progress update is recorded as a timestamped **note** in `session.notes[]`, forming an automatic timeline per session:

| Prompt | When | Recorded as |
|--------|------|-------------|
| **On-start description** | `startDescriptionAfterMinutes` (5) into the session, once, if none added yet | Description + note |
| **Progress update** | Every `progressAfterMinutes` (default 60) of *active* minutes, while in `active`/`grace` state | Note (becomes the description if none exists) |
| **Describe checkpoint** | After ~90 active minutes | Description + note |
| **Wrap close note** | Choosing "Wrap session & start a new one" | Note on the closed session |
| **Auto-idle return note** | Resuming after an auto-close left a session undescribed | Note on the ended session |
| **End-command close note** | `lalog.endSession` / "No, end this session" on the idle check | Note on the closed session (becomes the description if none exists) |
| **Manual edit** | `lalog.editSession` (session row click) | Note only when the description changes |

Each note stores `{ at: <epoch ms>, text }`. Skipping a progress prompt (Esc) re-arms the timer for another full window instead of nagging. The full timeline is visible in the sessions view.

---

## Storage & Persistence

### JSONL Append-Only

Closed sessions are appended to `~/.lalog/sessions.jsonl`:

```jsonl
{"id":"20260903-2200-a1b2-c3d4","workspaceKey":"abc1234567","workspaceName":"my-project","startedAt":1725397200000,"endedAt":1725404400000,"lastActivityAt":1725404400000,"activeMinutes":5700000,"activeSpans":[{"start":1725397200000,"end":1725400800000}],"activityTs":[1725397200000,1725397800000,1725400200000,1725400800000],"type":"feature","description":"Fix login bug","notes":[{"at":1725400800000,"text":"wired up the fix"}],"needsDescription":false,"events":{"edits":142,"saves":23,"terminal":8,"fileops":11,"tasks":3,"debug":2,"topFiles":[...]},"gitBranch":"fix/login","commits":[{"hash":"a1b2c3d","subject":"Fix login validation"}],"closedReason":"user"}
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
1. Loads the active snapshot for the current workspace (present only after an abnormal exit — normal quits close the session as `vscode-shutdown`)
2. Auto-closes any leftover snapshot as `recovery-skip` (endedAt = lastActivityAt) — recovered sessions are never prompted for a description
3. Starts a fresh session (see [Auto-Start on Open](#auto-start-on-open))

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

One webview panel in the activity bar (LaLog icon) with three tabs — **Sessions**, **Insights**, **Projects** — grouped by start-date day (newest first). The sessions list scrolls; the **Now** box below it is fixed at the bottom of the panel and never moves:

```
┌──────────────────────────────────────────┐
│ [ Sessions ] [ Insights ] [ Projects ]   │
│ ○ All  ● my-project  ● other · Unassign  │
│ ▼ 2026-09-03 — 3 sessions, 5h            │
│   ▼ 10:00 · my-project — Fix login bug   │
│      Fix login bug                       │
│      Active 2h 30m · in VS Code 2h 20m   │
│      feature · user · started 10:00      │
│      edits 142 · saves 23 · terminal 8 · │
│      file ops 11 · tasks 3 · debug 2     │
│      ● Project: my-project · change      │
│      (✎ keep as background work)         │
│      ▼ 3 files worked on                 │
│      ▼ 2 notes                           │
│      git fix/login · 2 commits           │
│   09:00 · other-project                  │
│  ┌────────────────────────────────────┐  │
│  │ CURRENT SESSION                    │  │
│  │ my-project · Fix login bug   ●     │  │
│  │ 1:40:36 · 10:32:05 · 5h today      │  │
│  │ [ Pause ] [ Resume ] [ End ]       │  │
│  └────────────────────────────────────┘  │
└──────────────────────────────────────────┘
```

- Session items show: status icon (`✓` described, `⚠` needs description, `○` anonymous/background, dimmed), a colored project dot, start time, workspace, and description
- Project **filter chips** sit above the list: All · one chip per project (with its color) · Unassigned
- Expand a session to see its full detail: description, active vs outside-VS-Code time split (from `splitActiveMinutes`), type, closed reason, time range, per-kind event counters, top files, the timestamped notes timeline, and git branch/commits
- Detail actions: change the session's project (assign picker) and, for undescribed sessions, **Keep as background work** / **Not background anymore**
- Files and notes expand into rows (file → edit count; note → timestamped text)
- Each session has an ✎ button → `lalog.editSession` command
- Sessions are grouped by start-date day (newest first); the most recent day group is expanded by default and only collapses if you explicitly close it, so a session that just ended is immediately visible

### Anonymous / Background Sessions

If you didn't want to describe a session, you can leave it **anonymous** ("background work") instead:

- Chosen right at session start (the 3-choice start prompt: **Describe…** / **Keep as background work** / **Not now**), later from the panel detail action, or from the status-bar quick action (`Keep as background work`)
- Anonymous sessions show a dimmed `○` and `— background`; they are **never** prompted — the describe checkpoint, progress notes, and the on-start description offer all skip them
- Any real description (edit, describe, or closing note) clears the anonymous flag and normal prompting resumes
- The wrap prompt still applies to anonymous sessions; only its "Add/update description" option is hidden
- Reports render them as `*(background work)*` and insights count their time

### Projects

Projects give many workspaces a single name and color. They live in a curated `~/.lalog/projects.json` registry and map sessions on a "derive-on-read" basis:

- **Claimed workspaces** — every session whose `workspaceKey` is claimed by exactly one non-archived project belongs to it automatically
- **Explicit override** — a session can be assigned to a specific project from its panel row (beats any derived claim, including archived projects)
- Sessions with no match appear under the **Unassigned** filter chip

The **Projects tab** lists every project with its color, this-week time, session count, and the folders it claims. Create a project from the current workspace in one click, add more workspaces to it, or archive/restore it. Archived projects stop matching sessions but keep their history and their explicitly-assigned sessions.

Projects feed the Insights bar chart, the report scoping picker, and the colored dots next to sessions.

### Insights (panel tab)

The Insights tab shows what took your time, without opening a report file:

- **Period toggle** — Today / Week / Month
- **Totals** — active time, in-VS-Code vs outside split, session count and average
- **By project** — CSS bars sized by time in each project's color
- **Time per day** — one bar per day in the period
- **Timeline** — one row per day, 24 hour-cells colored by whichever project dominated that hour (hover for the breakdown), with a color key
- **Top files** — the files you edited most, period-wide

The live (in-progress) session is included in today's figures with its tail capped at the idle gap.

### Now Box (fixed at the bottom of the panel)

The **Now** card is a non-scrolling footer at the bottom of the same panel, styled like a chat prompt box — Copilot keeps its input pinned the same way (one view, footer outside the scroll area). Because it's part of the single panel view, it has no resize divider and never moves. A session is **always** running, so the box never has a "Start" — its controls only pause/resume/end the always-on tracking. It updates every second:

- **CURRENT SESSION** — section label; below it the workspace name and its description (or a "(no description yet)" placeholder)
- **Session clock** — the big `h:mm:ss` count-up of this session's tracked duration (active minutes plus the live gap since the last event, capped at the idle gap so it doesn't creep while you're away); it freezes while paused
- **World clock** — a small live wall time next to the session clock, and today's tracked total
- **Status pill** — green **tracking** dot, or amber **paused**
- **Buttons** — **Pause** / **Resume** (outlined warning style) swap the tracking clock on and off (the session itself stays open, untouched); **End** (outlined danger style) closes the session, records an optional closing note, and immediately starts a fresh tracked session so nothing is ever left untracked

### Quick Actions Menu

Clicking the status bar opens:

```
┌─────────────────────────────────┐
│ LaLog                           │
│                                 │
│ $(pencil) Describe current      │
│ $(play) Resume session          │ ← or Pause
│ $(circle-slash) Keep as background work
│ $(check) End & restart session  │
│ $(calendar) Generate report     │
│ $(export) Export sessions CSV   │
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
- **Custom range** — any `YYYY-MM-DD...YYYY-MM-DD` pair (up to 31 days)

After picking the range you can **scope the report to a single project** (or all sessions). When the range is a single day, the report includes an **hourly log** (one line per hour with the project that dominated that hour), and the **in-progress session** is folded into today's figures.

**Report format** (Markdown):

```markdown
# LaLog — This Week

**Active time: 12h 30m** across 8 session(s) *(includes the session in progress)*

Sessions started: 2026-09-01, 2026-09-02, 2026-09-03

## By project
- **my-project**: 8h 15m
- **other-project**: 4h 15m

## Hourly log
- 09:00 — 52m — my-project
- 10:00 — 1h 05m — my-project
- 11:00 — 33m — other-project

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

**Report storage**: Saved to `~/.lalog/reports/<start-date>-<range>[<project-slug>].md` with a non-overwriting, date-prefixed filename (e.g. `2026-09-07-this-week-my-project.md`, `2026-09-03-custom.md`). Each range of a different period gets its own file.

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
| `lalog.idleGapMinutes` | number | `15` | Gap between events that still counts as active |
| `lalog.idleConfirmAfterMinutes` | number | `15` | Idle before the "Are you still there?" check fires (confirmed idle counts as active outside VS Code) |
| `lalog.startDescriptionAfterMinutes` | number | `5` | Delay before offering the optional on-start description (once, only if none added yet) |
| `lalog.progressAfterMinutes` | number | `60` | Active minutes between periodic progress-update prompts (timestamped notes) |
| `lalog.askDescriptionOnStart` | boolean | `true` | Ask for a short description when a session starts |
| `lalog.autoEndAfterIdleMinutes` | number | `120` | Idle time before auto-close (2h). Sessions are not day-bound; this is the only boundary |
| `lalog.debugTimeScale` | number | `1` | Divide all time thresholds by this factor. Set 60 to test a "4-hour" session in 4 minutes |
| `lalog.logTerminalCommands` | boolean | `true` | Record terminal commands (requires shell integration) |
| `lalog.redactPatterns` | string[] | `["TOKEN", "KEY", "SECRET", "PASSWORD", "PASS=", "API_KEY", "api[-_]?key"]` | Regex patterns redacted from logged terminal commands |
| `lalog.captureDiffs` | boolean | `true` | Capture unified diffs of file edits at save time (stored in session sidecar) |
| `lalog.captureTerminal` | boolean | `true` | Capture terminal command line, exit code, duration, and working directory |
| `lalog.captureTerminalStdout` | boolean | `false` | Also capture terminal stdout (opt-in: requires shell integration, may contain sensitive data) |
| `lalog.captureAiLog` | boolean | `true` | Log AI interaction metadata (char counts, latency — never prompt/response text) |
| `lalog.maxDiffChars` | number | `16000` | Maximum characters per diff entry before truncation |
| `lalog.maxStdoutChars` | number | `32000` | Maximum characters per terminal stdout capture before truncation |

### Threshold Resolution

All time settings are resolved to milliseconds with `debugTimeScale` applied:

```typescript
thresholdsMs(cfg) → {
  idleGap: 15 * 60 * 1000 / scale,
  idleConfirm: 15 * 60 * 1000 / scale,
  startDescAt: 5 * 60 * 1000 / scale,      // on-start description, 5 min in
  describeAt: 90 * 60 * 1000 / scale,
  describeForce: 120 * 60 * 1000 / scale,  // describeAt + 30min
  wrapAt: 210 * 60 * 1000 / scale,
  wrapForce: 240 * 60 * 1000 / scale,      // wrapAt + 30min
  grace: 30 * 60 * 1000 / scale,
  hardSplit: 300 * 60 * 1000 / scale,      // 5h hard limit
  progressAt: 60 * 60 * 1000 / scale,      // periodic progress notes
  autoEndIdle: 120 * 60 * 1000 / scale,
  maxGraceExtensions: 3,
}
```

---

## Commands

| Command | ID | Description |
|---------|----|-------------|
| Start session | `lalog.startSession` | Begin a new session in the current workspace |
| End session | `lalog.endSession` | Close the current session (with git annotation) |
| End & restart | `lalog.endSessionRestart` | Close the current session and immediately start a fresh tracked one |
| Pause session | `lalog.pauseSession` | Stop the tracking clock (session stays open) |
| Resume session | `lalog.resumeSession` | Restart the tracking clock from now |
| Describe now | `lalog.describeNow` | Trigger the describe flow immediately |
| Keep as background work | `lalog.background` | Mark the current session anonymous (no more labeling prompts on it) |
| Generate report | `lalog.report` | Session-centric markdown report (range + project scope + custom range) |
| Export sessions CSV | `lalog.exportCsv` | Dump all sessions to `~/.lalog/exports/sessions-<date>.csv` |
| Show sessions | `lalog.showSessions` | Focus the sessions sidebar view |
| Edit session | `lalog.editSession` | Update a session's description |
| Export files by day | `lalog.exportFilesByDay` | Legacy `files_by_day.txt` export |

---

## Related Pages

- [Architecture](architecture.md) — module overview and data flow
- [Decisions](decisions.md) — why sessions aren't day-bound, gap-based time model, etc.
- [Data Format](data-format.md) — JSONL schema and snapshot format
- [Development](development.md) — build, test, and run