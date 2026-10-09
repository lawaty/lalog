# User Stories

[Home](README.md) > **user-stories**

> The jobs LaLog is built to do, written from the user's point of view. Each story has acceptance criteria that map back to [Features](features.md) and the [Decisions](decisions.md) that shaped it.

---

## Table of Contents

- [Personas](#personas)
- [How to Read a Story](#how-to-read-a-story)
- [1. Session Tracking & Time](#1-session-tracking--time)
- [2. Automatic Event Capture](#2-automatic-event-capture)
- [3. Descriptions & Prompts](#3-descriptions--prompts)
- [4. User Interface](#4-user-interface)
- [5. Projects](#5-projects)
- [6. Insights & Reporting](#6-insights--reporting)
- [7. Integrations](#7-integrations)
- [8. Privacy, Data & Configuration](#8-privacy-data--configuration)
- [9. Optional AI Assistance](#9-optional-ai-assistance)
- [Non-Goals (Anti-Stories)](#non-goals-anti-stories)
- [Traceability](#traceability)

---

## Personas

| Persona | Description | Primary need |
|---------|-------------|--------------|
| **Solo developer** | Works alone across one or more repos, often in long unstructured stretches | Know where the day went without manually logging anything |
| **Consultant / freelancer** | Tracks billable engagement across clients and workspaces | Reconstruct accurate time per client/project for invoicing |
| **Privacy-conscious dev** | Won't install tools that phone home | Keep every byte of work data local and inspectable |
| **Remote / multi-machine dev** | Uses Remote-SSH or several machines | Point the data dir at a synced path and keep one history |
| **AI-assisted dev** | Uses an AI coding assistant and wants it documented | Capture AI usage without leaking prompts or responses |
| **Self-reviewer** | Reflects on wins, stalls, and time sinks | See patterns and produce a shareable report |

---

## How to Read a Story

Each story follows the standard form:

> **As a** `<persona>`, **I want** `<capability>`, **so that** `<benefit>`.

Acceptance criteria are the observable, testable conditions that make the story "done". They are written as plain conditions (Given/When/Then where the timing matters). Stories are grouped into epics; IDs are stable (`US-<epic>.<n>`) so they can be referenced in issues or tests.

---

## 1. Session Tracking & Time

### US-1.1 — Auto-start tracking on open

**As a** developer, **I want** tracking to start the moment I open a workspace, **so that** I never lose time because I forgot to press "start".

**Acceptance criteria**
- Given a workspace with no active session, when the extension activates, then a tracked session starts immediately and there is no "untracked" state.
- Given I close VS Code normally, when I reopen it, then a fresh session starts and the previous one is already closed.
- Given an event arrives with no open session (after a manual end or auto-close), then a fresh session starts silently and the event is recorded — never dropped.

### US-1.2 — Count only active time

**As a** developer, **I want** idle gaps excluded from my tracked time, **so that** a session left open over lunch doesn't inflate my hours.

**Acceptance criteria**
- Given two events less than the idle gap apart, when the later event arrives, then the gap counts as active time.
- Given a gap larger than the idle gap, when the next event arrives, then that gap is not counted.
- Given a session ends, then `activeMinutes` equals the sum of its active spans and `endedAt` is the last activity time, never the wall-clock close time.

### US-1.3 — Confirm idle as "still working"

**As a** developer who works away from the editor, **I want** to confirm I'm still working when prompted, **so that** thinking/reading time is counted.

**Acceptance criteria**
- Given 15 minutes (`idleConfirmAfterMinutes`) of no VS Code activity, when the heartbeat runs, then I'm asked "Are you still there?".
- Given I answer "Yes, still working", then the idle stretch counts as active but is classified as *outside VS Code* in reports.
- Given I answer "I was away and came back", then the idle time since the prompt is trimmed and tracking continues in the same session.
- Given I answer "No, end this session", then the session closes (trimmed to the prompt moment) and a fresh session starts.

### US-1.4 — Hard stale-session cutoff

**As a** developer returning after a long break, **I want** the stale session closed automatically, **so that** I start clean instead of resuming hours-old context.

**Acceptance criteria**
- Given a session idle for `staleSessionAfterMinutes` (default 60), when the cutoff is reached (heartbeat) or I return with an event, then the session is force-closed as `auto-idle` with `endedAt = lastActivityAt` and a fresh session starts immediately.
- Given a stale session, then no "continue"/"resume"/"I was away" option is offered.
- Given the stale cutoff and the 2h `autoEndAfterIdleMinutes` safety net, then the stale cutoff always takes effect first.
- Given the cutoff fires while a prompt is open, then answering the old prompt can never affect the fresh session.

### US-1.5 — Pause and resume the clock

**As a** developer stepping away deliberately, **I want** to pause tracking, **so that** untracked personal time isn't counted.

**Acceptance criteria**
- Given I pause, then the session stays open, the open span is finalized, and no events, prompts, or accrual occur until I resume.
- Given I resume, then counting restarts from right now with no giant gap.
- Given I pause then close VS Code, then the paused session is restored as-is.

### US-1.6 — End and start fresh

**As a** developer, **I want** one action that ends the current session and begins a new one, **so that** tracking never lapses between contexts.

**Acceptance criteria**
- Given I choose "End & restart", then the current session closes (with git annotation) and a fresh tracked session starts immediately.
- Given I choose "End", then the session closes and a fresh one starts on the next event or action.

### US-1.7 — Sessions are not day-bound

**As a** developer working past midnight, **I want** an overnight thread to stay one session, **so that** the narrative isn't split by the calendar.

**Acceptance criteria**
- Given a session starting at 22:00 and continuing past midnight, then `startedAt` never changes and the session is reported under its start date.

### US-1.8 — Workspace-scoped tracking

**As a** multi-workspace developer, **I want** each folder tracked separately, **so that** work in different contexts doesn't bleed together.

**Acceptance criteria**
- Given multiple workspace folders, then each has its own session track identified by a stable workspace key (SHA-1 of the real path).

### US-1.9 — Recover from an abnormal exit

**As a** developer whose VS Code crashed, **I want** the leftover session recorded without being nagged, **so that** no work is lost and I'm not asked about cold context.

**Acceptance criteria**
- Given a leftover active snapshot on startup, then it is auto-closed as `recovery-skip` (`endedAt = lastActivityAt`) with no prompt, and a fresh session starts.
- Given a session that ended normally as `vscode-shutdown`, then it is never reopened or re-probed.

---

## 2. Automatic Event Capture

### US-2.1 — Capture work events passively

**As a** developer, **I want** my normal work captured without extra effort, **so that** I don't have to log anything by hand.

**Acceptance criteria**
- Given I switch editors, edit, save, create/delete/rename files, run tasks, start/stop debug sessions, or run terminal commands, then each is recorded as a typed event with a timestamp.
- Given an event type is unavailable on my VS Code version, then the extension degrades gracefully (e.g. terminal open/close fallback).

### US-2.2 — Debounce rapid edits

**As a** developer typing quickly, **I want** keystrokes coalesced, **so that** the event stream stays meaningful and compact.

**Acceptance criteria**
- Given repeated edits to the same file within 2 seconds, then a single `edit` event is emitted with the last timestamp.

### US-2.3 — Capture terminal command metadata

**As a** developer, **I want** the commands I run recorded, **so that** a session reflects build/test/deploy activity.

**Acceptance criteria**
- Given shell integration is available, when a command runs, then its command line, exit code, duration, and working directory are stored in the session's technical sidecar.
- Given shell integration is unavailable, then the extension falls back to terminal open/close events.

### US-2.4 — Opt in to terminal stdout capture

**As a** privacy-conscious developer, **I want** terminal output capture off by default, **so that** secrets never get logged unless I choose it.

**Acceptance criteria**
- Given `captureTerminalStdout` is false (default), then stdout is never stored.
- Given I enable it, then stdout is ANSI-stripped, redacted, and capped at `maxStdoutChars`.

### US-2.5 — Capture file diffs at save time

**As a** self-reviewer, **I want** the actual changes recorded, **so that** reports and AI can understand what I did, not just that I typed.

**Acceptance criteria**
- Given I save a file, then a unified diff is captured (new-file diff on first save, patch afterwards), redacted and capped at `maxDiffChars`.
- Given a binary file or an identical save, then no diff entry is produced.
- Given many files, then at most 100 paths are tracked (LRU eviction).
- Given a file larger than 256KB, then only its first save produces a diff entry — the oversized text is not cached, so later saves of that path are not diffed.

### US-2.6 — Log AI interaction metadata only

**As an** AI-assisted developer, **I want** my AI usage documented without exposing content, **so that** I can see how much I relied on AI.

**Acceptance criteria**
- Given an AI call, then task, model, latency, prompt/response character counts, and truncation are logged — never prompt or response text.

### US-2.7 — Track top files

**As a** developer, **I want** to see the files I touched most, **so that** a session's focus is obvious at a glance.

**Acceptance criteria**
- Given edit events, then a top-10 list by edit count is maintained with first/last touch times, used for describe pre-fill and reports.

---

## 3. Descriptions & Prompts

### US-3.1 — Describe at the right moment

**As a** developer deep in flow, **I want** the description prompt to wait for a natural pause, **so that** it doesn't interrupt me.

**Acceptance criteria**
- Given ~90 active minutes (`describeAfterMinutes`) since I last answered, then the describe prompt is held until a breakpoint (terminal command end, debug terminate, return from idle) or forced after 30 minutes.
- Given only one prompt at a time and a minimum spacing between prompts, then prompts never stack.
- Given I answered a prompt (described, deferred, or skipped), then the next one for that question waits a full interval from that moment — not from the session start, and not queued while I was away.

### US-3.2 — Text-first describe with pre-fill

**As a** developer, **I want** to type a description and press Enter once, **so that** my text is never lost in a filter box.

**Acceptance criteria**
- Given the describe prompt opens, then an InputBox appears first, pre-filled with branch, top files, or `(terminal work)`.
- Given I press Enter, then the text is saved immediately.
- Given I clear the box or press Esc, then a fallback QuickPick keeps the non-text options reachable.

### US-3.3 — Pick a task type

**As a** developer, **I want** to categorize a session, **so that** reports can group by kind of work.

**Acceptance criteria**
- Given text was entered, then a type picker appears with `other` pre-selected (Enter accepts), offering feature/bugfix/research/refactor/review/docs/ops/other.

### US-3.4 — Reuse the last description

**As a** developer resuming similar work, **I want** to reuse my previous description, **so that** I don't retype it.

**Acceptance criteria**
- Given a previous description exists for the workspace, then "Same as last" is offered and fills the session.

### US-3.5 — Keep a session as background work

**As a** developer doing low-signal chores, **I want** to mark a session anonymous, **so that** LaLog stops asking for a description while still recording time.

**Acceptance criteria**
- Given I choose "Keep as background work", then the session is flagged anonymous, is never prompted by the describe checkpoint or progress notes, and renders dimmed with `— background`.
- Given I later provide any real description, then the anonymous flag clears and prompting resumes.

### US-3.6 — Defer a description

**As a** developer, **I want** to skip a description for now, **so that** tracking continues uninterrupted.

**Acceptance criteria**
- Given I choose "Later" or skip, then the session is flagged `needsDescription`, tracking continues, and I can describe it later from the sessions view.

### US-3.7 — Wrap a long session

**As a** developer in a very long stretch, **I want** to be asked whether to wrap up, **so that** sessions stay bounded.

**Acceptance criteria**
- Given ~3.5h active minutes (`wrapAfterMinutes`), then the wrap prompt offers: wrap & start new, extend 30 min, add/update description, skip.

### US-3.8 — Extend with a grace period

**As a** developer, **I want** to extend a session, **so that** I'm not forced to stop mid-task.

**Acceptance criteria**
- Given I choose "Extend", then I get a 30-minute grace period and am re-prompted afterwards.
- Given I've used `maxGraceExtensions` free extends, then a description is required to continue.
- Given I choose "Skip" (or dismiss the prompt), then tracking continues, no free extension is spent, and the wrap prompt is not asked again until a full wrap interval has passed.

### US-3.9 — Periodic progress notes

**As a** self-reviewer, **I want** periodic prompts to note what changed, **so that** long sessions have a timeline.

**Acceptance criteria**
- Given every `progressAfterMinutes` (default 60) of active minutes, then a note prompt appears (skippable; skipping re-arms the timer).
- Given no description exists, then the first progress note becomes the description.

### US-3.10 — Never prompt about a closed session

**As a** developer, **I want** to never be asked about a session that's already over, **so that** I'm not interrupted with cold context.

**Acceptance criteria**
- Given a session closed by any path (manual end, wrap, auto-idle, shutdown, recovery), then LaLog never prompts for its description afterwards; it stays flagged in the sessions view.

### US-3.11 — Describe or edit on demand

**As a** developer, **I want** to describe or edit a session whenever I choose, **so that** I stay in control of the record.

**Acceptance criteria**
- Given the "Describe now" command, then the describe flow opens immediately for the live session.
- Given the "Edit session" command (or a session row's ✎), then I can update a session's description; a change is recorded as a timestamped note.

---

## 4. User Interface

### US-4.1 — See status at a glance

**As a** developer, **I want** a status bar readout, **so that** I know my tracked time without opening anything.

**Acceptance criteria**
- Given no active session, then the status bar shows today's total.
- Given an active session, then it shows the description/workspace and session duration; the tooltip includes today's total and untracked time.

### US-4.2 — Quick actions from the status bar

**As a** developer, **I want** one click to reach common actions, **so that** I can act without hunting through menus.

**Acceptance criteria**
- Given I click the status bar, then a menu offers Describe, Pause/Resume, Keep as background work, End & restart, Generate report, and Export CSV.

### US-4.3 — Browse sessions in the sidebar

**As a** developer, **I want** a scrollable session list grouped by day, **so that** I can review recent work.

**Acceptance criteria**
- Given the sessions view, then sessions group by start-date day (newest first), the most recent group is expanded by default, and each row shows status icon, project color, start time, workspace, and description.
- The day a session is filed under is its **local** calendar day, not UTC — a session started at 23:30 belongs to the day the developer experienced it, and the Sessions tab, the insights timeline, and the insights day totals always agree on that day.

### US-4.4 — Drill into a session

**As a** self-reviewer, **I want** a full session-detail document, **so that** I can see exactly what happened.

**Acceptance criteria**
- Given a session row, then clicking it opens a session-detail markdown document with description, in/outside-VS-Code split, type, closed reason, time range, event counters, top files, timestamped updates, git branch/commits, file changes, terminal commands, and AI interaction metadata.
- Given an undescribed session, then I can assign a project or toggle background work from the row itself (the project dot and the action row).

### US-4.5 — Live "Now" box

**As a** developer, **I want** a pinned live clock with pause/resume/end, **so that** the current session is always one glance (and one click) away.

**Acceptance criteria**
- Given an active session, then the footer shows workspace/description, an `h:mm:ss` count-up capped at the idle gap, a world clock, today's total, a tracking/paused pill, and Pause/Resume/End buttons.
- Given the box is part of the single panel view, then it never scrolls or moves.

### US-4.6 — Filter by project

**As a** developer, **I want** project filter chips above the list, **so that** I can focus on one project or unassigned work.

**Acceptance criteria**
- Given projects exist, then chips show All, each project (with color), and Unassigned, and selecting one filters the list.

### US-4.7 — Delete a session from the panel

**As a** solo developer cleaning up my history, **I want** to delete a session and its technical sidecar from the Sessions panel, **so that** mistakes and noise don't pollute my stats.

**Acceptance criteria**
- Given a session row, when I press its 🗑 button, then a modal warning asks me to confirm and Cancel is a no-op.
- Given I confirm, then every line for that session id is removed from `sessions.jsonl`, its technical sidecar is deleted, and the row, day totals, insights, and the status-bar "today" total update immediately.
- Given the live session, then it cannot be deleted — I'm told to end it first (it is only written to history when it ends).
- Given an unknown or missing id, then nothing happens (no fallback to the latest session).

### US-4.8 — Scan the session list at a glance

**As a** developer, **I want** a compact session list, **so that** the sidebar answers "what did I do today?" without scrolling.

**Acceptance criteria**
- Given a session row, then it shows the status icon, project color, start time, workspace, description, and active duration — and nothing else.
- Given a session with progress-update notes, then one always-visible, timestamped row per note sits under the header (oldest first); the rest of the detail lives in the detail document.
- Given a session, then at most one extra action row appears: "Not background work anymore" for a background session, or "Keep as background work" for one that still needs a description.

### US-4.9 — Adjust a session's tracked time

**As a** developer who answered the idle prompt wrong, **I want** to lower a session's tracked time, **so that** a misclick doesn't keep billing me for time I wasn't there.

**Acceptance criteria**
- Given any session, then I can set its tracked total to a whole number of minutes from the ⏱ button on its row (or the ⏱ button in the Now box for the live session), with the current total pre-filled.
- Reduction only: the value must be a whole number of minutes between 0 and the current total; anything larger is rejected and nothing is written.
- Given the live session, then the correction goes through the tracker, the session keeps running, and time accrues again from the corrected total.
- Given a closed session, then the corrected total, spans, and activity timestamps are persisted and every derived number (row, day totals, insights, status bar) updates immediately.
- Given a wrong "Yes, still working" on the idle prompt, then the away window it closed is the time removed first, so real work after the return is spared.
- After the adjustment, the session's spans still sum to its tracked total.

---

## 5. Projects

### US-5.1 — Name a project from the current workspace

**As a** consultant, **I want** to create a project from the workspace I'm in, **so that** I can group related work quickly.

**Acceptance criteria**
- Requires `lalog.multiProject`.
- Given the Projects tab, then I can create a project in one click that claims the current workspace.

### US-5.2 — Group many workspaces under one project

**As a** consultant, **I want** several repos/folders to map to one client project, **so that** reporting reflects the client, not the folder.

**Acceptance criteria**
- Requires `lalog.multiProject`.
- Given a project, then I can add more claimed workspaces; every session whose workspace is claimed by exactly one non-archived project derives to it.

### US-5.3 — Override a session's project

**As a** developer, **I want** to correct a session's project assignment, **so that** an auto-match never misleads my reports.

**Acceptance criteria**
- Available in every mode — the per-session assignment picker is never hidden.
- Given a session, then I can assign it to a specific project; the explicit assignment beats any derived claim (including archived projects).

### US-5.4 — Archive without losing history

**As a** developer, **I want** to archive a finished project, **so that** it stops matching new sessions while history is preserved.

**Acceptance criteria**
- Requires `lalog.multiProject`.
- Given I archive a project, then it stops deriving new matches but keeps its history and explicit assignments; I can restore it later.

### US-5.5 — One project per workspace, named after it, renameable

**As a** consultant, **I want** LaLog to keep one project per workspace I work in, **so that** I never have to think about project setup and my projects actually mean something.

**Acceptance criteria**
- Given a fresh install, then one project is created automatically for this workspace, named after the VS Code workspace (the `.code-workspace` name in a multi-root window, otherwise the folder name).
- Given the Projects tab, then it shows that project's name, this week's time, session and workspace counts, and a single **Rename…** action — no create/claim/archive buttons.
- Given I rename it, then the new name appears everywhere (panel, reports, PDF, CSV, insights) on the next refresh **and stays**: a renamed project is mine, so it is never renamed again even if the workspace is renamed.
- Given I have several workspaces, then each has its own project with its own name and its own sessions — sessions from one workspace never show up under another workspace's project.
- Given I rename or move the folder, then that is a new workspace: history stays with the old project and new sessions go to the new one, and I reconcile with **Rename…** if I want them under one name.
- Given my data was collapsed into a single project by an earlier version, then it is split once into one project per workspace (named from that workspace's own history), the collapsed file is kept as `projects.json.pre-split.bak`, and sessions explicitly pointing at the old project are re-pointed at the project that owns their workspace.
- Known trade-off: an auto-named project follows its workspace, so it can be renamed when you open the folder under a new name. Rename it once to pin the name.

### US-5.6 — Opt in to multiple projects

**As a** consultant who bills several clients, **I want** full project management, **so that** I can split one machine's history by client.

**Acceptance criteria**
- Given `lalog.multiProject` is off (the default), then each workspace keeps its own project (nothing is collapsed or unioned) and the Projects tab stays minimal.
- Given `lalog.multiProject` is on, then I get the full Projects tab (create, claim, archive/restore, rename) and the automatic per-workspace naming/split is skipped entirely.
- Known limitation: when a workspace is claimed by more than one project, the first match wins; "Add workspace" is the manual remedy.

---

## 6. Insights & Reporting

### US-6.1 — See what took my time

**As a** self-reviewer, **I want** at-a-glance totals, **so that** I understand my time without generating a file.

**Acceptance criteria**
- Given the Insights tab, then I see active time, in/outside-VS-Code split, session count/average, time by project, a per-day 24-hour timeline with a day total, and top files.
- Given a live session, then its idle-gap-capped tail is included in today's figures.

### US-6.2 — Switch periods

**As a** self-reviewer, **I want** Today/Week/Month toggles, **so that** I can zoom out or in.

**Acceptance criteria**
- Given the period toggle, then all insights recompute for the selected period.

### US-6.3 — Generate a session-centric report

**As a** consultant, **I want** a markdown report grouped by session, **so that** I can review or share what got done.

**Acceptance criteria**
- Given a range, then the report lists totals and each session with start/end, duration, workspace, type, description, top files, branch, and commits; sessions are never split across days.

### US-6.4 — Choose a range and scope

**As a** consultant, **I want** preset and custom ranges plus project scoping, **so that** I can report exactly the period and client I need.

**Acceptance criteria**
- Given the report picker, then I can choose Today, Yesterday, This week, This month, Last month, or a custom range up to 31 days, then scope to a single project or all.
- Given a single-day range, then the report includes an hourly log.
- Given saving, then the file is date-prefixed and non-overwriting.

### US-6.5 — Export raw data

**As a** developer, **I want** CSV and legacy exports, **so that** I can use the data elsewhere.

**Acceptance criteria**
- Given "Export sessions CSV", then all sessions are written to `~/.lalog/exports/sessions-<date>.csv`.
- Given "Export files by day", then a `files_by_day.txt` is written grouped by project slug, listing files under each day they were edited (midnight-spanning sessions appear under both days).

### US-6.6 — Export a PDF report with detail toggles

**As a** developer, **I want** a PDF export with a preset and fine-grained detail checkboxes, **so that** I get a shareable document with exactly the content I want.

**Acceptance criteria**
- Given "LaLog: Export sessions to PDF", then I pick a range (Today, Yesterday, This week, This month, Last month, or a custom range up to 31 days), then a scope (all sessions or one project), then a preset, then tick the details to include from a multi-select list of 14 items (13 content toggles plus "Start each day on a new page").
- Given the multi-select, then each item starts ticked or unticked from the chosen preset's defaults, durations always render, and cancelling any step writes nothing.
- Given saving, then the file is `~/.lalog/reports/<date>-<range>[-<project>][-N].pdf`, never overwriting an existing report, and it is opened with the system PDF viewer.
- Given the same sessions and options, then the generated bytes are deterministic (no timestamps embedded).

### US-6.7 — Export a client-ready abstract sheet

**As a** freelancer or consultant, **I want** a minimal abstract PDF, **so that** I can share a day-by-day sheet that shows when and on what I worked, without internals.

**Acceptance criteria**
- Given the `client` preset, then the PDF contains only day headings, time ranges, descriptions, project names, and durations — no task types, workspaces, top files, git branch/commits, notes, in/outside split, event counters, or hourly log.
- Given the `client` preset, then each day starts on a new page; given `personal`, then days flow continuously on one page and everything is included.
- Given either preset, then the detail checkboxes can still override any single default before the file is written.

### US-6.8 — Read the day at a glance

**As a** self-reviewer, **I want** a per-day timeline with hour slots, totals, and a project filter, **so that** I can find the hour I want to look at without generating a file.

**Acceptance criteria**
- Given the Insights tab, then the timeline has one row per day, an hour axis above the rows, one colored slot per local hour (23 or 25 slots on a DST day), the day's total at the end of each row, and project filter chips above the chart; there is no separate "time per day" bar list.
- Given a slot, then its tooltip names every project active in that hour with its time, and clicking it opens the session detail of the single session there — or a picker of sessions when the hour holds more than one.
- Given a project chip, then only that project's time is counted in the slots, the row totals, and the slot tooltips.
- Given a day label, then clicking it opens the file diffs for that day (US-6.9).

### US-6.9 — Read the file diffs for a day

**As a** developer, **I want** one document with every file change of a single day, **so that** I can see what I actually touched without opening each session.

**Acceptance criteria**
- Given "LaLog: Show file diffs for a day" (or a click on a timeline day label), then a markdown document opens titled with the local day, listing each of that day's sessions in start order with its time, workspace, and description, followed by its captured diffs (`+N −M` per save plus the diff body).
- Given a day with more than 31 days of history, then I am offered the most recent 31 days to choose from.
- Given a session whose diffs have aged out of the retention window, then the document says so once at the top and once under that session, while the sessions that still have diffs render normally.
- Given any day, then the document ends with the day's `+added −removed` totals and the number of sessions it covers.

---

## 7. Integrations

### US-7.1 — Annotate sessions with git context

**As a** developer, **I want** sessions linked to the branch and commits they produced, **so that** the record connects to my repo history.

**Acceptance criteria**
- Given a git workspace, when a session ends, then the current branch and commits within the session window are attached (best-effort; failures are silent).

### US-7.2 — My opencode chat keeps my session alive

**As a** developer who works with the opencode CLI/TUI, **I want** LaLog to notice when I have an opencode chat open in this workspace, **so that** a live conversation is never mistaken for idle work.

**Acceptance criteria**
- Given `lalog.opencode.activity.enabled` and a local `opencode serve` serving this workspace, then LaLog records at most one `opencode` event per poll — only when a session it has already seen, in this workspace, has a newer `time.updated` (first sight is a baseline, never an event; sessions titled `LaLog …` are LaLog's own runs and are ignored).
- Given the load the polling puts on my own machine, then the frequent poll asks only for the sessions LaLog already tracks (`GET /session/{id}`), a tracked session untouched for a whole discovery window is not re-fetched at all, and the full list (`GET /session`) is read only every `lalog.opencode.activity.discoverySec` (default 3 min) — so a list is never fetched on the fast 30 s cadence.
- Given a chat I have just started, then it is noticed within `discoverySec` (a new chat can only be found by listing) and adopted as a baseline without emitting, so nothing is double-counted.
- Given several tracked sessions, then one tick issues its requests one at a time — never a parallel fan-out — and never asks for the same session twice in a tick.
- Given no open LaLog session, then no request of any kind is made, at either tier.
- Given the same events, then they count like any other activity: idle confirmation, accrual and the stale cutoff all behave exactly as they do for terminal work, so a live chat is never asked about or cut off.
- Given `lalog.opencode.activity.enabled` (on by default), then observation works with no setup at all; given it is set to `false`, then nothing is polled and no request is made. The setting is independent of `lalog.ai.enabled` — a chat keeps a session alive with AI off, and turning AI off does not disable it.
- Given the server is not running or the poll fails, then LaLog retries silently and re-baselines after an outage, so no time is ever counted for a period it did not observe.
- Given `lalog.opencode.activity.manageServe` (on by default) and a serve already running for this workspace, then LaLog finds and reuses it instead of starting a second one, and never restarts or reconfigures it.
- Given `manageServe` and no serve running for this workspace, then LaLog starts one itself — on `127.0.0.1`, in the workspace root, with a random password it never stores — waits until it actually answers, and stops that serve again when it is no longer needed.
- Given a serve LaLog did not start, then there is no way for LaLog to signal it: stopping requires an owned handle, and nothing else is ever killed, restarted, or written to.
- Given nothing to gain from polling (no open LaLog session, or the workspace is quiet), then polling backs off up to ~5 minutes per step and stops entirely when no session is open — and any activity or new session brings it straight back.
- Given discovery or startup fails, then nothing is surfaced to me, no server is left behind, and no time is counted for the gap.

---

## 8. Privacy, Data & Configuration

### US-8.1 — Keep everything local

**As a** privacy-conscious developer, **I want** all data on my machine, **so that** nothing about my work leaves it.

**Acceptance criteria**
- Given normal use, then all data is written under `~/.lalog/` with no network calls and no telemetry.

### US-8.2 — Choose where data lives

**As a** remote/multi-machine developer, **I want** to point the data directory at a synced path, **so that** I keep one history across machines.

**Acceptance criteria**
- Given `lalog.dataDir`, then all storage uses that path (tilde expands to home).

### US-8.3 — Redact secrets

**As a** privacy-conscious developer, **I want** configurable redaction, **so that** captured terminal text and diffs don't store secrets.

**Acceptance criteria**
- Given `redactPatterns`, then matching text is replaced with `[REDACTED]` before storage in commands, stdout, and diffs.

### US-8.4 — Inspect and port my data

**As a** developer, **I want** human-readable storage, **so that** I can read, grep, back up, or migrate it myself.

**Acceptance criteria**
- Given closed sessions, then they are append-only JSONL (`sessions.jsonl`); active sessions are atomic snapshots deleted on close.

### US-8.5 — Tune capture and timing

**As a** developer, **I want** settings for capture and thresholds, **so that** LaLog fits how I work.

**Acceptance criteria**
- Given the settings, then I can toggle diffs, terminal capture, stdout, and AI logging, cap diff/stdout sizes, and adjust describe/wrap/idle/progress/stale thresholds.

### US-8.6 — Test the full lifecycle quickly

**As a** contributor, **I want** a time-scale setting, **so that** I can exercise a 4-hour session in minutes.

**Acceptance criteria**
- Given `debugTimeScale`, then all time thresholds divide by that factor consistently.

### US-8.7 — Age out old file diffs

**As a** developer, **I want** captured file diffs to expire, **so that** `~/.lalog/technical/` stays small and the old file contents fall out of the record on their own.

**Acceptance criteria**
- Given `lalog.diffRetentionDays` (default 14), then on startup every captured `diff` entry older than that many days is removed from its sidecar, and a sidecar left with no entries is deleted.
- Given terminal and AI-interaction entries, then they are kept forever — only diffs expire.
- Given a session whose diffs have aged out, then its detail document still shows the terminal commands and AI interactions and explains that the diffs are no longer available.
- Given `lalog.diffRetentionDays: 0`, then nothing is ever pruned.
- Given a file in `technical/` that is not a session sidecar, then it is never read or rewritten.

---

## 9. Optional AI Assistance

### US-9.1 — Turn AI on only if I want it

**As a** privacy-conscious developer, **I want** AI off by default, **so that** the extension is fully local unless I opt in.

**Acceptance criteria**
- Given `lalog.ai.enabled` is false, then no AI code path runs and no data is sent.
- Given it is true, then AI surfaces appear (Draft with AI, report narrative, Analyze my work).

### US-9.2 — Draft a description

**As an** AI-assisted developer, **I want** a draft description I can edit, **so that** describing a session takes less effort while I stay the author.

**Acceptance criteria**
- Given AI is enabled, then "Draft with AI" produces an editable draft that I must accept before it's saved.

### US-9.3 — Know exactly what is sent

**As a** privacy-conscious developer, **I want** an explicit egress contract, **so that** I can trust the AI feature.

**Acceptance criteria**
- Given any AI call, then only workspace name, counters, file paths, branch, and (toggleable) commit subjects are sent — never file contents, terminal output, or commit diffs/bodies.
- Given AI output, then it is always labeled as AI-generated and never silently persisted as ground truth.

### US-9.4 — Review my work with AI

**As a** self-reviewer, **I want** an AI work analysis, **so that** I can spot wins, improvements, and stalls.

**Acceptance criteria**
- Given AI is enabled, then "Analyze my work" produces a structured review over a date range, clearly labeled as AI-generated.

---

## Non-Goals (Anti-Stories)

These are deliberately **not** stories LaLog will satisfy. See [Roadmap](roadmap.md) for rationale.

| Anti-story | Why not |
|------------|---------|
| **As a** user, I want cloud sync of my sessions | Local-first by design; point `dataDir` at your own sync folder |
| **As a** user, I want automatic AI summaries as ground truth | Humans remain the author of record; AI is draft-only |
| **As a** user, I want proactive AI suggestions while I type | Interruption fatigue; rejected as on-brand-wrong for a tracker |
| **As a** user, I want Pomodoro timers | Sessions are cognitive threads, not fixed time boxes |
| **As a** user, I want sessions merged across workspaces | Distinct contexts; merging complicates the data model |
| **As a** user, I want real-time collaboration | Personal tool; would require network infrastructure |
| **As a** user, I want to backfill from VS Code Local History | Forward tracking only; avoids internal formats |
| **As a** user, I want telemetry or server-side storage | Privacy and offline capability |

---

## Traceability

| Epic | Features | Key decisions |
|------|----------|---------------|
| 1. Session Tracking & Time | [Session Tracking](features.md#session-tracking) | [ADR-001](decisions.md#adr-001-sessions-are-not-day-bound), [ADR-003](decisions.md#adr-003-gap-based-active-time-model), [ADR-007](decisions.md#adr-007-auto-close-uses-lastactivityat), [ADR-010](decisions.md#adr-010-the-only-boundary-is-2h-idle), [ADR-012](decisions.md#adr-012-active-only-tracking-with-idle-confirmation), [ADR-022](decisions.md#adr-022-hard-1h-stale-session-cutoff--no-continuation) |
| 2. Automatic Event Capture | [Automatic Event Capture](features.md#automatic-event-capture) | [ADR-018](decisions.md#adr-018-technical-detail-capture) |
| 3. Descriptions & Prompts | [Prompt System](features.md#prompt-system) | [ADR-006](decisions.md#adr-006-breakpoint-aligned-prompt-delivery), [ADR-017](decisions.md#adr-017-never-prompt-about-a-closed-session), [ADR-019](decisions.md#adr-019-no-description-prompts-on-close--text-first-describe), [ADR-020](decisions.md#adr-020-remove-the-describe-before-exit-prompt), [ADR-021](decisions.md#adr-021-remove-the-on-start-description-prompt) |
| 4. User Interface | [User Interface](features.md#user-interface) | [ADR-023](decisions.md#adr-023-confirmed-session-deletion-full-file-rewrite-no-fallback), [ADR-025](decisions.md#adr-025-session-detail-as-an-untitled-markdown-document), [ADR-031](decisions.md#adr-031-tracked-time-is-reduction-only-with-outside-window-first-removal) |
| 5. Projects | [Projects](features.md#projects) | [ADR-014](decisions.md#adr-014-projects-as-a-derived-workspace-registry), [ADR-029](decisions.md#adr-029-a-single-implicit-workspace-project-multi-project-is-opt-in), [ADR-030](decisions.md#adr-030-per-workspace-projects-replace-the-single-project-union) |
| 6. Insights & Reporting | [Reporting](features.md#reporting) | [ADR-002](decisions.md#adr-002-session-centric-reporting), [ADR-015](decisions.md#adr-015-insights-as-pure-aggregations), [ADR-024](decisions.md#adr-024-hand-rolled-pdf-writer-zero-new-dependencies), [ADR-027](decisions.md#adr-027-one-local-day-key-everywhere), [ADR-028](decisions.md#adr-028-timeline-slots-carry-session-identity) |
| 7. Integrations | [Integrations](features.md#integrations) | [ADR-032](decisions.md#adr-032-opencode-serve-activity-is-observed-never-managed) |
| 8. Privacy, Data & Configuration | [Storage & Persistence](features.md#storage--persistence), [Configuration](features.md#configuration) | [ADR-004](decisions.md#adr-004-jsonl-append-only-storage), [ADR-005](decisions.md#adr-005-local-only--zero-telemetry), [ADR-008](decisions.md#adr-008-debugtimescale-for-testing), [ADR-009](decisions.md#adr-009-heartbeat--snapshot-persistence), [ADR-026](decisions.md#adr-026-diffs-only-technical-retention) |
| 9. Optional AI Assistance | [Optional AI Assistance](README.md#optional-ai-assistance) | [ADR-011](decisions.md#adr-011-optional-ai-assistance-amends-adr-005) |

---

## Related Pages

- [Features](features.md) — what IS built, by area
- [Decisions](decisions.md) — why it's built this way (ADRs)
- [Architecture](architecture.md) — module overview and data flow
- [Roadmap](roadmap.md) — what's NOT built, and why
