# LaLog Documentation

> Local-first VS Code extension for automatic work session tracking with human descriptions and optional opencode-powered AI assistance.

[Home](README.md) · [Architecture](architecture.md) · [Features](features.md) · [Decisions](decisions.md) · [Development](development.md) · [Data Format](data-format.md) · [Roadmap](roadmap.md)

---

## Overview

LaLog (formerly "Worklog") is a VS Code extension (v0.2.0) that passively tracks your coding sessions — capturing edits, saves, terminal commands, file operations, debug sessions, and tasks — then prompts you at natural breakpoints to describe what you were working on. All data stays local in `~/.lalog/`.

AI assistance is **optional and off by default**: when enabled, LaLog uses the local `opencode` CLI to help draft session descriptions, add a narrative to reports, and produce a work review. It never captures or sends file contents or terminal output — only the compact session summary (file paths, counters, git branch, commit subjects).

## Documentation Index

| Page | Description |
|------|-------------|
| [Architecture](architecture.md) | Module overview, data flow, Mermaid diagrams of the state machine and session lifecycle |
| [Features](features.md) | Every feature organized by area: session tracking, prompts, storage, UI, reporting, integrations |
| [Decisions](decisions.md) | Architecture Decision Records (ADRs) — why sessions aren't day-bound, gap-based time model, JSONL storage, etc. |
| [Development](development.md) | How to build, test, package, and run the extension. npm scripts, debugTimeScale testing, contribution flow |
| [Data Format](data-format.md) | JSONL schema, active snapshots, export formats, report output. Example JSON |
| [Roadmap](roadmap.md) | What's NOT built: no cloud sync, no telemetry, and the rationale for the optional AI design |

## Quick Start

1. Install the extension (or press F5 in VS Code to run from source)
2. Open a workspace — LaLog activates on `onStartupFinished`
3. You'll see a prompt: *"Work in \<workspace\>? Start a work session?"*
4. Work normally — edits, saves, terminal commands are captured automatically
5. After ~90 active minutes, a describe prompt appears at a natural breakpoint
6. After ~3.5h, a wrap prompt offers to close the session or extend 30 min
7. After ~2h idle, the session auto-closes (endedAt = lastActivityAt, not detection time)

## Optional AI Assistance

LaLog is fully functional and 100% local without AI. To turn it on:

1. `lalog.ai.enabled: true` in your VS Code settings.
2. Install the opencode CLI (`opencode`) and authenticate with `opencode auth login`, selecting **OpenCode Zen** (this provides the free `opencode/big-pickle` model).
3. Use the new surfaces (shown only when enabled):
   - **Draft with AI** — an extra option in the describe prompt that drafts a session description for you to edit and approve.
   - **AI Narrative** — appended to generated reports.
   - **Analyze my work** (`lalog.analysis`) — a structured review of wins, improvements, and stalls over a date range.

**What is sent to the model (and what is not):**

| Sent (compact summary) | Never sent |
|---|---|
| Workspace name | File contents |
| Edits / saves / terminal counts | Terminal output |
| File paths | Commit diffs or bodies |
| Git branch | Anything when AI is disabled |
| Commit subjects (toggleable via `lalog.ai.data.sendCommitSubjects`) | |

Every AI output is labeled as AI-generated; nothing is silently persisted as ground truth. The base reports and session descriptions remain human-authored and never depend on the AI being available.

> **Privacy note:** `opencode/big-pickle` is a cloud-hosted OpenCode Zen model that is currently free "for a limited time". During that free period, collected data may be used to improve the model. It is also a "stealth" model — the model behind the name can change without notice. Set `lalog.ai.model` to any model available in your opencode setup (e.g. a truly local model) if you prefer.

## Key Principles

- **Sessions are NOT day-bound** — an overnight coding thread is a single session
- **The only boundary is ~2h idle** — auto-close uses `lastActivityAt`, never wall-clock
- **Gap-based active time** — idle gaps (>5 min) are never counted as active
- **Breakpoint-aligned prompts** — prompts deliver when a terminal command ends, not on a fixed timer
- **Local-first / AI-optional / egress-explicit** — all data in `~/.lalog/`; AI off by default; exactly-what-is-sent is defined above
- **JSONL append-only** — crash-safe, human-readable, grep-friendly

## Configuration

Core settings are under `lalog.*`. AI settings are under `lalog.ai.*`.

| Setting | Default | Description |
|---------|---------|-------------|
| `lalog.dataDir` | `~/.lalog` | Data directory (tilde expands to home) |
| `lalog.describeAfterMinutes` | `90` | Active minutes before describe prompt |
| `lalog.wrapAfterMinutes` | `210` | Active minutes before wrap prompt (3.5h) |
| `lalog.graceMinutes` | `30` | Extension length on "Extend" choice |
| `lalog.idleGapMinutes` | `5` | Gap between events that still counts as active |
| `lalog.autoEndAfterIdleMinutes` | `120` | Idle time before auto-close (2h) |
| `lalog.debugTimeScale` | `1` | Divide all thresholds by this (set 60 to test 4h in 4 min) |
| `lalog.ai.enabled` | `false` | Master switch for AI assistance (off by default) |
| `lalog.ai.model` | `opencode/big-pickle` | Model ID for AI requests |
| `lalog.ai.opencodePath` | `opencode` | Path to the opencode CLI binary |
| `lalog.ai.data.sendCommitSubjects` | `true` | Send commit subjects (never diffs/bodies) |

See [Features → Configuration](features.md#configuration) for the full list.

## Commands

| Command | ID | Description |
|---------|----|-------------|
| Start session | `lalog.startSession` | Begin a new session in the current workspace |
| End session | `lalog.endSession` | Close the current session (with git annotation) |
| Describe now | `lalog.describeNow` | Trigger the describe flow immediately |
| Generate report | `lalog.report` | Session-centric markdown report (today/week/month) |
| Analyze my work | `lalog.analysis` | AI work review — wins/improvements/stalls (when AI enabled) |
| Show sessions | `lalog.showSessions` | Focus the sessions sidebar view |
| Edit session | `lalog.editSession` | Update a session's description |
| Export files by day | `lalog.exportFilesByDay` | Legacy `files_by_day.txt` export |

## Navigation

```
docs/
├── README.md          ← you are here
├── architecture.md    ← module/data-flow overview with Mermaid diagrams
├── features.md        ← every feature by area
├── decisions.md       ← ADRs
├── development.md     ← build/test/package/run
├── data-format.md     ← JSONL schema, snapshots, exports
└── roadmap.md         ← what's NOT built
```
