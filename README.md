# LaLog

Local-first VS Code extension for automatic work-session tracking with human descriptions — and optional, offline `opencode` AI assistance.

> Formerly "Worklog". v0.2.0.

## What it does

LaLog passively tracks your coding sessions — edits, saves, terminal commands, file operations, debug sessions, and tasks — then prompts you at natural breakpoints to describe what you were working on. All data stays local in `~/.lalog/` as append-only JSONL.

Key guarantees:

- **Active-only time** — a session's duration is the sum of its active timestamps, never `close_time − start_time`. Idle gaps are not counted as active.
- **Never open VS Code untracked** — opening a workspace auto-starts a session so all work is recorded, even without a description.
- **Ends on close** — closing VS Code ends the active session (`vscode-shutdown`); stale leftover idle sessions are auto-closed on next open rather than silently resumed.
- **"Are you still there?" idle check** — after 15 min of idle, LaLog asks whether you're still working (e.g. outside VS Code) before stopping the tracker.
- **Optional AI, off by default** — when enabled, uses the local `opencode` CLI to draft descriptions, add report narratives, and review work. Never sends file contents or terminal output.

## Quick start

1. Build & install (`npm install`, `npm run build`, then `npx @vscode/vsce package --allow-missing-repository` and install the `.vsix`), or press **F5** to run from source.
2. Open a workspace — LaLog activates and starts tracking a session.
3. Work normally. At natural breakpoints, describe what you're doing (optional).
4. Close VS Code to end the session.

## Commands

| Command | ID |
|---|---|
| End session | `lalog.endSession` |
| Describe now | `lalog.describeNow` |
| Generate report | `lalog.report` |
| Analyze my work (AI review) | `lalog.analysis` |
| Show sessions | `lalog.showSessions` |
| Edit session | `lalog.editSession` |

## Configuration

Core settings under `lalog.*`, AI settings under `lalog.ai.*`. Notable defaults:

| Setting | Default |
|---|---|
| `lalog.dataDir` | `~/.lalog` |
| `lalog.idleGapMinutes` | `15` |
| `lalog.autoEndAfterIdleMinutes` | `120` |
| `lalog.ai.enabled` | `false` |
| `lalog.ai.model` | `opencode/big-pickle` |

## Documentation

Full documentation lives in [`docs/`](docs/README.md) — architecture, features, decisions (ADRs), data format, and roadmap.

## Development

- `npm run typecheck` — TypeScript type check
- `npm run build` — esbuild bundle
- `npm test` — unit tests

## Data

Everything is stored locally in `~/.lalog/`:

- `active/<workspaceKey>.json` — active session snapshots
- `sessions.jsonl` — append-only closed sessions
- `exports/`, `reports/` — generated exports and reports

## Privacy

- **100% local by default** — no network calls unless AI is enabled.
- **AI egress is explicit** — only the compact session summary (file paths, counters, git branch, commit subjects). Never file contents, terminal output, or diffs.
- `opencode/big-pickle` is a cloud-hosted OpenCode Zen model free "for a limited time" — data may be used to improve it during that window. Set `lalog.ai.model` to any model available in your opencode setup to use a truly local one.
