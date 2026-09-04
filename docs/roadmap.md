# Roadmap

[Home](README.md) > **roadmap**

> What's NOT built — and why.

---

## Table of Contents

- [What's Built](#whats-built)
- [What's NOT Built](#whats-not-built)
- [Explicitly Excluded](#explicitly-excluded)
- [Future Ideas](#future-ideas)

---

## What's Built

The current implementation (v0.1.0) includes:

- ✅ **Automatic event capture** — edits, saves, terminal, file ops, debug, tasks
- ✅ **Session state machine** — idle → active → describePending → wrapPending → grace
- ✅ **Gap-based active time** — idle gaps not counted
- ✅ **Breakpoint-aligned prompts** — describe at 90min, wrap at 3.5h
- ✅ **JSONL append-only storage** — crash-safe, human-readable
- ✅ **Active session snapshots** — atomic persistence, recovery on restart
- ✅ **Session-centric reports** — markdown reports (today/week/month)
- ✅ **Git integration** — branch + commit annotation
- ✅ **Legacy export** — `files_by_day.txt` format
- ✅ **Status bar + tree view** — live duration, session list
- ✅ **debugTimeScale** — test 4h sessions in 4 minutes
- ✅ **Optional AI (off by default)** — draft descriptions, report narrative, work analysis via the local `opencode` CLI

---

## What's NOT Built

### Local History Importer / Backfill

**Status**: Explicitly left out of the original plan.

**Rationale**: The extension starts fresh from activation. There's no importer to backfill sessions from VS Code's Local History or other sources. Users who install Worklog mid-project start tracking from that point forward.

**Why not built**:
- Local History is a VS Code feature, not a standard format
- Backfilling would require parsing VS Code's internal storage
- The extension is designed for forward tracking, not retroactive analysis
- Keeps the codebase simple and dependency-free

### Cloud Sync

**Status**: Explicitly excluded.

**Rationale**: LaLog is 100% local. No cloud sync, no server, no auth.

**Alternative**: Users can point `lalog.dataDir` at a synced folder (e.g., Dropbox, Syncthing) for cross-machine sync. This is the user's responsibility, not the extension's.

### AI Summarization (Revisited — now optional)

**Status**: Built as **optional and off by default** in v0.2.0 (see [ADR-011](decisions.md#adr-011-optional-ai-assistance-amends-adr-005)).

**Original rationale (kept, reframed)**: Descriptions are human-provided and remain the author of record. AI summaries were rejected for inaccuracy, cost, privacy, and latency — those concerns still shape the design, but the user chose to offer AI as an **opt-in** helper rather than exclude it outright.

**How it changed**: The philosophy moved from "no AI" to **"local-first, AI-optional, egress-explicit"**.
- AI is **off by default** (`lalog.ai.enabled: false`); with it off the extension is byte-for-byte local.
- When enabled, LaLog uses the local `opencode` CLI with the cloud model `opencode/big-pickle` (free for a limited time) to:
  - **Draft** session descriptions (human edits and approves)
  - Add an **AI narrative** to reports
  - Produce a **work analysis** (wins / improvements / stalls)
- Egress is limited to the compact session summary — never file contents or terminal output.
- AI output is always labeled; nothing is silently persisted as ground truth.

**Still explicitly excluded** (even with AI on):
- **Proactive live suggestions** — an assistant that watches you and interjects while you work. This remains a rejected/experimental idea: interruption fatigue, latency, and a surveillance feel that is on-brand-wrong for a privacy-first tracker. If ever built, it would be a separate opt-in with long cooldowns and status-bar-only delivery.
- **Managed `opencode serve` lifecycle / interactive Q&A** — deferred; the current integration is one-shot CLI only.
- **AI replacing human descriptions** — never.

### Pomodoro / Time Boxing

**Status**: Explicitly excluded.

**Rationale**: Worklog tracks natural engagement threads, not fixed time boxes.

**Why not built**:
- Pomodoro imposes artificial structure on cognitive work
- Sessions are bounded by idle time, not timers
- Users who want Pomodoro can use a dedicated tool

### Multi-Workspace Session Merging

**Status**: Not built.

**Rationale**: Each workspace has its own session track. Sessions are not merged across workspaces.

**Why not built**:
- Workspaces represent distinct projects/contexts
- Merging would complicate the data model
- Users can generate reports across workspaces if needed

### Real-Time Collaboration

**Status**: Explicitly excluded.

**Rationale**: Worklog is a single-user tool. No real-time collaboration, no shared sessions.

**Why not built**:
- Work logs are personal
- Collaboration features require network infrastructure
- Keeps the extension simple and local-only

---

## Explicitly Excluded

The following features were considered and explicitly rejected:

| Feature | Reason |
|---------|--------|
| Cloud sync | Privacy, simplicity, user control |
| AI summarization (automatic) | Human descriptions remain authoritative; AI drafts are optional, off by default |
| Proactive AI suggestions | Interruption fatigue, latency, surveillance feel — experimental at best |
| Pomodoro / time boxing | Artificial structure, dedicated tools exist |
| Multi-workspace merging | Distinct contexts, complicates data model |
| Real-time collaboration | Personal tool, requires network |
| Local History backfill | VS Code internal format, forward tracking only |
| Telemetry / analytics | Privacy, simplicity |
| Server-side storage | Privacy, offline capability |
| Mobile app | Out of scope, VS Code extension only |
| Browser extension | Out of scope, VS Code extension only |

---

## Future Ideas

These are **not planned** but could be considered if there's demand:

### Enhanced Reporting

- **Custom date ranges** — the `custom` ReportRange is defined but not exposed in the UI
- **Export to CSV/JSON** — machine-readable report formats
- **Charts / visualizations** — time distribution by project, type, day of week

### Session Management

- **Session splitting** — manually split a long session into two
- **Session merging** — manually merge two related sessions
- **Session tags** — user-defined tags beyond the fixed `SessionType` enum

### Integration

- **Git hooks** — auto-annotate sessions on commit
- **Issue tracker integration** — link sessions to GitHub issues, Jira tickets
- **Calendar export** — export sessions to iCal format

### UI Enhancements

- **Session timeline** — visual timeline of sessions over days/weeks
- **Quick filters** — filter sessions by type, workspace, date range
- **Inline editing** — edit session descriptions directly in the tree view

### Data Management

- **Data export / import** — backup and restore sessions
- **Data migration** — migrate sessions between machines
- **Data retention** — auto-archive old sessions

---

## Design Philosophy

The roadmap reflects the core design philosophy:

1. **Local-first** — all worklog data stays local; no cloud sync, no telemetry
2. **AI-optional / egress-explicit** — AI is off by default; when on, only the compact session summary is ever sent, and AI output is always labeled
3. **Simple** — minimal dependencies; the core never depends on an external service
4. **Human-centric** — humans author descriptions; AI drafts/analyzes but never replaces
5. **Forward tracking** — no backfill, no retroactive analysis
6. **Natural engagement** — sessions are cognitive threads, not time boxes

If a feature contradicts these principles, it's explicitly excluded (or relegated to an opt-in experiment).

---

## Related Pages

- [Architecture](architecture.md) — module overview and data flow
- [Features](features.md) — what IS built
- [Decisions](decisions.md) — why certain decisions were made
- [Development](development.md) — how to contribute