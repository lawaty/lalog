# LaLog

**Effortless, local-first work tracking for VS Code.** LaLog watches what you're actually doing — edits, saves, terminals, file operations, tasks, and debug sessions — and turns it into a clean, human-readable timeline of your work, with descriptions you add at natural moments instead of status-update chores.

It started as a personal tool and is shaped entirely by real use: no accounts, no cloud, no gamification. Your work data lives in your home directory as append-only JSONL, and everything on screen is driven by it.

---

## Highlights

You open VS Code and just work. LaLog handles the rest:

- **Sessions, not timers.** Opening a workspace starts tracking automatically — you are never "untracked." If a session ends (auto-close, manual end) and you keep working, a fresh one starts silently at the next event. A session is a continuous thread, bounded by idle time rather than the clock: an overnight run from 22:00 to 02:00 is one session.
- **Active-only time.** A session's duration is the sum of its active moments and spans, never `end − start` wall-clock. Idle gaps don't count. If you pop away from your desk and confirm you were actually "still working," that time is counted separately as *outside VS Code*; say "I was away" instead and that idle stretch is trimmed.
- **Descriptions at the right moments.** The describe checkpoint waits until the ~90-minute mark, and hourly progress notes fill in between. Every entry is a timestamped note on the session — and whether you answer or not, tracking keeps running. Sessions are never asked about on close.
- **A real drill-down UI.** The sidebar holds three tabs — **Sessions**, **Insights**, **Projects**. Sessions group by day (most recent open by default); each row is a compact summary (time · workspace — description, duration), and clicking it opens a session-detail document with the in/outside-VS-Code split, event counters, top files, the note timeline, git branch/commits, captured file diffs, terminal commands, and AI interaction metadata. The Insights tab gives at-a-glance totals, a per-day 24-hour timeline you can click to reach the sessions behind an hour, and top files — without opening a file.
- **Anonymous when you say so.** At any time you can choose **Keep as background work** — from the describe checkpoint, the panel row action, or the status-bar quick action: the session still tracks everything, but LaLog stops asking for a description. Project your many workspaces onto named, colored **projects** (claimed by folder, overridable per session), then filter, scope reports, and read insights by project.
- **Stops on its own.** "Are you still there?" fires after 15 idle minutes so outside-editor work isn't lost — and abandoned sessions are force-closed after 1 hour of inactivity (no continue option) and a fresh session starts automatically — come back, type one key, and a new session picks up where you left off.
- **A clock you can act on.** The pinned **Current Session** box runs a live count-up of this session's tracked time (`h:mm:ss`) beside a small world clock, with nothing but pause, resume, and end — because the tracking is always on; ending a session immediately starts a fresh tracked one.
- **Optional AI, off by default.** When enabled, a local `opencode` CLI drafts descriptions, writes report narratives, and reviews your work. It only ever sees the compact session summary (file paths, counters, branch, commit subjects) — never file contents or terminal output.
- **Technical detail capture.** LaLog captures unified diffs at save time, terminal command metadata (with optional stdout capture), and AI interaction logs — all stored locally and subject to configurable redaction patterns and character limits.

## How it looks

```
 SESSIONS
 ▼ 2026-09-03 — 3 sessions, 5h
   10:00 · my-project — Fix login bug          2h 30m          ✎ 🗑
   wired up the fix                             11:30
   plan from standup, log took over             10:00
```

Clicking a row opens that session as a markdown document — description, in/outside-VS-Code split, event counters, top files, notes, git, file changes, terminal, and AI activity — in a preview tab. `LaLog: Show file diffs for a day` does the same for a whole day, and the Insights timeline reaches both.

Reports are session-centric markdown — pick a range (today / yesterday / week / month / any custom span) and a project scope, and single-day reports include an hourly log. Nothing is uploaded anywhere unless you opt into AI.

## Quick start

```bash
npm install
npm run build
npx @vscode/vsce package --no-dependencies --allow-missing-repository
# install the resulting .vsix (or press F5 in VS Code to run from source)
```

Open a workspace. That's it — LaLog starts a session, tracks events, and occasionally asks you what you're working on (all prompts are optional and skippable).

Data is written to `~/.lalog/`:

```
~/.lalog/
├── sessions.jsonl            # all closed sessions, append-only
├── projects.json             # curated project registry (claims folders)
├── active/<key>.json         # live session snapshots
├── exports/                  # CSV dumps + files_by_day.txt legacy export
└── reports/YYYY-MM-<range.md> # generated, scope-aware reports
```

## Commands

| Command | ID |
|---|---|
| Start session | `lalog.startSession` |
| End session | `lalog.endSession` |
| End & restart session | `lalog.endSessionRestart` |
| Pause / resume session | `lalog.pauseSession` / `lalog.resumeSession` |
| Describe current session | `lalog.describeNow` |
| Keep as background work | `lalog.background` |
| Generate report | `lalog.report` |
| Export sessions CSV | `lalog.exportCsv` |
| Export sessions PDF | `lalog.exportPdf` |
| Analyze my work (AI) | `lalog.analysis` |
| Show sessions | `lalog.showSessions` |
| Edit session | `lalog.editSession` |
| Delete session | `lalog.deleteSession` |
| Show session detail | `lalog.sessionDetail` |
| Show file diffs for a day | `lalog.dayDiffs` |
| Rename project | `lalog.renameProject` |
| Export files by day | `lalog.exportFilesByDay` |

## Key settings

| Setting | Default | What it does |
|---|---|---|
| `lalog.idleGapMinutes` | `15` | Gap between events that still counts as continuous work |
| `lalog.idleConfirmAfterMinutes` | `15` | When "Are you still there?" fires |
| `lalog.autoEndAfterIdleMinutes` | `120` | Auto-close abandoned sessions (capped at the stale-session cutoff) |
| `lalog.staleSessionAfterMinutes` | `60` | Force-close a session idle this long; a new session starts automatically |
| `lalog.progressAfterMinutes` | `60` | Cadence of progress-note prompts |
| `lalog.describeAfterMinutes` | `90` | When the describe checkpoint fires |
| `lalog.wrapAfterMinutes` | `210` | When the wrap-and-continue prompt fires |
| `lalog.ai.enabled` | `false` | Opt into opencode-powered AI assistance |
| `lalog.opencode.activity.enabled` | `true` | Count an open opencode chat in this workspace as activity — LaLog reuses a local `opencode serve`, or starts one for you and stops it again when idle. Set `false` for a fully local, zero-request install ([ADR-034](docs/decisions.md), US-7.2) |
| `lalog.dataDir` | `~/.lalog` | Where everything is stored |
| `lalog.captureDiffs` | boolean | `true` | Capture unified diffs at save time |
| `lalog.captureTerminal` | boolean | `true` | Capture terminal command metadata |
| `lalog.captureTerminalStdout` | boolean | `false` | Capture terminal stdout (opt-in) |
| `lalog.captureAiLog` | boolean | `true` | Log AI interaction metadata |
| `lalog.maxDiffChars` | number | `16000` | Max characters per diff entry |
| `lalog.diffRetentionDays` | `14` | Days to keep captured file diffs (`0` = forever; terminal/AI metadata is always kept) |
| `lalog.multiProject` | `false` | Advanced: full multi-project management. Off by default — one project per workspace, named after the VS Code workspace, renameable |
| `lalog.maxStdoutChars` | number | `32000` | Max characters per terminal stdout |

## Privacy

- **Local-first by default.** The extension makes no network calls unless you enable AI or opencode chat activity — the only other network path is a read-only poll of an `opencode serve` on `127.0.0.1` (one you already run, or one LaLog starts for you with a random password and stops again when it is no longer needed; a serve LaLog did not start is never signalled).
- **AI egress is explicit and compact.** Only the session summary — file paths, event counters, git branch, commit subjects — leaves your machine, and only when you run an AI feature.
- **Redaction built in.** Terminal activity flows through `lalog.redactPatterns` so keys and secrets never land in the log.

## Documentation & development

Full docs live in [`docs/`](docs/README.md): architecture, ADRs, the JSONL data format, features, and development notes.

```bash
npm run typecheck   # TypeScript
npm run build       # bundle (esbuild)
npm test            # unit tests
```

## License

[MIT](LICENSE) — take it, adapt it, make it yours.