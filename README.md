# LaLog

**Effortless, local-first work tracking for VS Code.** LaLog watches what you're actually doing — edits, saves, terminals, file operations, tasks, and debug sessions — and turns it into a clean, human-readable timeline of your work, with descriptions you add at natural moments instead of status-update chores.

It started as a personal tool and is shaped entirely by real use: no accounts, no cloud, no gamification. Your work data lives in your home directory as append-only JSONL, and everything on screen is driven by it.

---

## Highlights

You open VS Code and just work. LaLog handles the rest:

- **Sessions, not timers.** Opening a workspace starts tracking automatically — you are never "untracked." A session is a continuous thread, bounded by idle time rather than the clock: an overnight run from 22:00 to 02:00 is one session.
- **Active-only time.** A session's duration is the sum of its active moments and spans, never `end − start` wall-clock. Idle gaps don't count. If you pop away from your desk and confirm you were actually "still working," that time is counted separately as *outside VS Code*.
- **Descriptions at the right moments.** An optional prompt when a session starts ("what are you working on?"), a longer one around the 90-minute mark, periodic progress notes every hour if you keep going, and a closing note when you wrap up. Every entry is a timestamped note on the session.
- **A real drill-down UI.** The sidebar groups sessions by day; expand any session to see its description, active vs. outside-VS-Code split, per-kind event counters, top files, the note timeline, and the git branch and commits made during it.
- **Stops on its own.** "Are you still there?" fires after 15 idle minutes so outside-editor work isn't lost — and abandoned sessions auto-close after ~2 hours instead of accumulating phantom time.
- **Optional AI, off by default.** When enabled, a local `opencode` CLI drafts descriptions, writes report narratives, and reviews your work. It only ever sees the compact session summary (file paths, counters, branch, commit subjects) — never file contents or terminal output.

## How it looks

```
 SESSIONS
 ▼ 2026-09-03 — 3 sessions, 5h
   ▼ 10:00 · my-project — Fix login bug
     Fix login bug
     Active 2h 30m · in VS Code 2h 20m · outside 10m
     feature · user · started 10:00
     edits 142 · saves 23 · terminal 8 · file ops 11 · tasks 3 · debug 2
     ▼ 3 files worked on
     ▼ 2 notes
       wired up the fix                    11:30
       plan from standup, log took over    10:00
     git fix/login · 2 commits
```

Reports are session-centric markdown (today / yesterday / week / month), and nothing is uploaded anywhere unless you opt into AI.

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
├── active/<key>.json         # live session snapshots
├── exports/                  # files_by_day.txt legacy export
└── reports/YYYY-MM.md        # generated reports
```

## Commands

| Command | ID |
|---|---|
| Start session | `lalog.startSession` |
| End session | `lalog.endSession` |
| Describe current session | `lalog.describeNow` |
| Generate report | `lalog.report` |
| Analyze my work (AI) | `lalog.analysis` |
| Show sessions | `lalog.showSessions` |
| Edit session | `lalog.editSession` |
| Export files by day | `lalog.exportFilesByDay` |

## Key settings

| Setting | Default | What it does |
|---|---|---|
| `lalog.idleGapMinutes` | `15` | Gap between events that still counts as continuous work |
| `lalog.idleConfirmAfterMinutes` | `15` | When "Are you still there?" fires |
| `lalog.autoEndAfterIdleMinutes` | `120` | Auto-close abandoned sessions |
| `lalog.progressAfterMinutes` | `60` | Cadence of progress-note prompts |
| `lalog.askDescriptionOnStart` | `true` | Ask "what are you working on?" at session start |
| `lalog.describeAfterMinutes` | `90` | When the describe checkpoint fires |
| `lalog.wrapAfterMinutes` | `210` | When the wrap-and-continue prompt fires |
| `lalog.ai.enabled` | `false` | Opt into opencode-powered AI assistance |
| `lalog.dataDir` | `~/.lalog` | Where everything is stored |

## Privacy

- **Local-first by default.** The extension makes no network calls unless you enable AI.
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