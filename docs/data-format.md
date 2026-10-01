# Data Format

[Home](README.md) > **data-format**

> JSONL schema, active snapshots, export formats, and report output.

---

## Table of Contents

- [Directory Layout](#directory-layout)
- [sessions.jsonl](#sessionsjsonl)
- [Active Snapshots](#active-snapshots)
- [Export: files_by_day.txt](#export-files_by_daytxt)
- [Reports](#reports)
- [Example Data](#example-data)
- [Technical Sidecar](#technical-sidecar)

---

## Directory Layout

All data is stored in `~/.lalog/` (configurable via `lalog.dataDir`):

```
~/.lalog/
├── sessions.jsonl              # All closed sessions (append-only)
├── projects.json               # Curated project registry (rewritten atomically)
├── projects.json.pre-split.bak  # Written once if a collapsed single project was split per workspace
├── projects.json.pre-collapse.bak  # Legacy 0.6.0 backup; may coexist, never rewritten
├── active/
│   ├── <wsKey>.json            # Active session snapshot per workspace
│   └── <wsKey>.json.tmp        # Temporary file during atomic write
├── exports/
│   ├── sessions-YYYY-MM-DD.csv # Full session CSV dump (lalog.exportCsv)
│   └── <slug>/
│       └── files_by_day.txt    # Legacy export format
├── reports/
│   └── <start-date>-<range>[-<slug>].md
└── technical/
    └── <sessionId>.jsonl        # Per-session technical detail sidecar
```

**Workspace key** (`<wsKey>`): SHA-1 hash of the workspace's realpath, first 10 hex chars. Example: `a1b2c3d4e5`.

**Project slug** (`<slug>`): Top-level directory name of the workspace, sanitized. Example: `my-project`.

---

## sessions.jsonl

**Format**: JSON Lines — one JSON object per line, newline-separated.

**Schema**:

```typescript
interface Session {
  id: string;                    // "20260903-2200-a1b2-c3d4"
  workspaceKey: string;          // SHA-1 hash (10 chars)
  workspaceName: string;         // "my-project"
  startedAt: number;             // Unix timestamp (ms)
  endedAt?: number;              // Unix timestamp (ms) — set when closed
  lastActivityAt: number;        // Unix timestamp (ms)
  activeMinutes: number;         // Total active time (milliseconds, gap-based)
  activeSpans: ActiveSpan[];     // Contiguous active periods (ms) — sum ≈ activeMinutes
  technicalSidecar?: string;  // Absolute path to the technical detail sidecar JSONL (set on first write)
  activityTs: number[];          // Sorted activity timestamps (ms), capped at 20000 — powers the in/out-of-VS-Code split
  type?: SessionType;            // "feature" | "bugfix" | "research" | "refactor" | "review" | "docs" | "ops" | "other"
  description?: string;          // User-provided description
  anonymous?: boolean;           // "background work" — no labeling prompts, dimmed in UI
  projectId?: string;            // Manual project override (beats derived workspace claims)
  notes: { at: number; text: string }[];  // Timestamped notes
  needsDescription: boolean;     // True if session lacks description
  events: {
    edits: number;               // Total edit events
    saves: number;               // Total save events
    terminal: number;            // Total terminal events
    fileops: number;             // File create/delete/rename events
    tasks: number;               // Task execution starts
    debug: number;               // Debug session start/end events
    topFiles: FileTouch[];       // Top 10 most-edited files
  };
  gitBranch?: string;            // Git branch at session end
  commits?: SessionCommits[];    // Commits during session
  closedReason?: ClosedReason;   // "user" | "auto-idle" | "auto-split" | "workspace-switch" | "vscode-shutdown" | "recovery-skip"
}

interface FileTouch {
  path: string;                  // Absolute file path
  edits: number;                 // Edit count
  firstTouch: number;            // First edit timestamp (ms)
  lastTouch: number;             // Last edit timestamp (ms)
}

interface ActiveSpan {
  start: number;                 // Span start timestamp (ms)
  end: number;                   // Span end timestamp (ms) — last activity in the run
}

interface SessionCommits {
  hash: string;                  // Short commit hash (7-40 chars)
  subject: string;               // Commit message subject
}
```

**Example line**:

```json
{"id":"20260903-2200-a1b2-c3d4","workspaceKey":"abc1234567","workspaceName":"my-project","startedAt":1725397200000,"endedAt":1725404400000,"lastActivityAt":1725404400000,"activeMinutes":5700000,"activeSpans":[{"start":1725397200000,"end":1725400800000},{"start":1725402000000,"end":1725404400000}],"activityTs":[1725397200000,1725397800000,1725400200000,1725402000000,1725403200000,1725404400000],"type":"feature","description":"Fix login bug","notes": [{"at":1725400800000,"text":"Fixed validation logic"}],
  "needsDescription": false,
  "events": {"edits":142,"saves":23,"terminal":8,"fileops":11,"tasks":3,"debug":2,"topFiles":[{"path":"/home/user/my-project/src/auth.ts","edits":45,"firstTouch":1725397200000,"lastTouch":1725404400000},{"path":"/home/user/my-project/src/login.ts","edits":32,"firstTouch":1725397500000,"lastTouch":1725404000000}]},
  "gitBranch":"fix/login","commits":[{"hash":"a1b2c3d","subject":"Fix login validation"},{"hash":"e4f5g6h","subject":"Add error handling"}],"closedReason":"user"}
```

**Units**: `activeMinutes` is stored in **milliseconds** (it is accrued as `now − lastActivityAt` gaps). Consumers must NOT multiply by 60000 — old "minutes" consumers did and produced 60000×-inflated durations (fixed in v0.2.0).

**In / out-of-VS-Code split (filter time)**: `activeSpans` are stored untagged. At report time, a span is classified as *in VS Code* iff its `end` timestamp appears in `activityTs` (an outside-VS-Code span ends at an idle-confirmation timestamp, which is never a recorded activity). Legacy sessions without `activeSpans` are reconstructed by walking `activityTs` and summing gaps of ≤ `idleGapMs` (see `src/reporting/spans.ts`).

**Operations**:
- **Append**: `appendLine(file, data)` — POSIX near-atomic (open, write, close)
- **Read all**: `streamLines(file, onLine)` — streaming reader, skips malformed lines
- **Update**: `updateSession(id, patch)` — rewrites the full file (rare, used by "Edit session" command)

---

## Active Snapshots

**Location**: `~/.lalog/active/<wsKey>.json`

**Format**: Pretty-printed JSON (for human readability during debugging).

**Schema**: Same as `Session` above, but `endedAt` and `closedReason` are not set.

**Example**:

```json
{
  "id": "20260903-2200-a1b2-c3d4",
  "workspaceKey": "abc1234567",
  "workspaceName": "my-project",
  "startedAt": 1725397200000,
  "lastActivityAt": 1725400800000,
  "activeMinutes": 3600000,
  "activeSpans": [
    { "start": 1725397200000, "end": 1725400800000 }
  ],
  "activityTs": [1725397200000, 1725397800000, 1725400200000, 1725400800000],
  "type": "feature",
  "description": "Fix login bug",
  "notes": [],
  "needsDescription": false,
  "events": {
    "edits": 85,
    "saves": 12,
    "terminal": 5,
    "fileops": 4,
    "tasks": 1,
    "debug": 1,
    "topFiles": [
      {
        "path": "/home/user/my-project/src/auth.ts",
        "edits": 30,
        "firstTouch": 1725397200000,
        "lastTouch": 1725400800000
      }
    ]
  },
  "gitBranch": "fix/login"
}
```

**Operations**:
- **Write**: `saveSnapshot(file, data)` — atomic (write `.tmp` → rename)
- **Read**: `readSnapshot(file)` — returns `null` if file doesn't exist
- **Delete**: `removeActive(wsKey)` — called when session closes

**Persistence schedule**:
- Every 60 seconds (heartbeat timer)
- On every state change (describe, wrap, start, end)

---

## projects.json (project registry)

**Location**: `~/.lalog/projects.json`

**Format**: Pretty-printed JSON, versioned, rewritten atomically (`.tmp` → rename). Separate from the append-only `sessions.jsonl` because projects are *curated state*, not event history.

**Schema**:

```typescript
interface ProjectFile {
  version: 1;
  projects: Project[];
}

interface Project {
  id: string;                 // "prj_<8hex>" — random
  name: string;               // "LaLog"
  color: string;              // from PROJECT_COLORS palette (10 hex colors), by creation index
  workspaceKeys: string[];    // claimed workspace keys — sessions with any match derive to this project
  pathHints: string[];        // human-readable folder examples for the UI (never matched)
  createdAt: number;          // ms epoch
  archivedAt?: number;        // set → excluded from derivation (explicit assignments stay)
  nameSource?: 'auto' | 'user'; // who owns the name: 'auto' = derived from the VS Code workspace
                                 // and may follow it; 'user' = explicit rename, never auto-changed.
                                 // Absent (pre-0.7 records) reads as 'user'.
}
```

**Example**:

```json
{
  "version": 1,
  "projects": [
    {
      "id": "prj_1a2b3c4d",
      "name": "LaLog",
      "color": "#2ea043",
      "workspaceKeys": ["a1b2c3d4e5"],
      "pathHints": ["/home/lawaty/Projects/lalog"],
      "createdAt": 1725397200000,
      "nameSource": "auto"
    }
  ]
}
```

**Resolution rule** (`resolveProject`, pure): an explicit `session.projectId` wins; otherwise a session belongs to the first **non-archived** project claiming its `workspaceKey`; otherwise it's unassigned. There is **no basename fallback** and **no cross-workspace fallback** — only claims count, which is why the per-workspace migration below resolves one project for the window that is open and never borrows another workspace's key.

### One project per workspace (default, `lalog.multiProject: false`)

On every activation, before the first render, `ProjectRegistry.ensureWorkspaceProject` resolves the project for the open workspace (ADR-030). Two steps:

| Registry state | Result |
|----------------|--------|
| One collapsed, **flag-less** (pre-0.7) project claiming several keys — the ADR-029 collapse artifact | **Split** it into one project per key (see below), then continue |
| A project claims the current `workspaceKey` | Un-archive it, attach `wsPath` as a `pathHint`, and if `nameSource === 'auto'` and the name differs, rename it to the VS Code workspace name (`setNameTracked`) |
| No project claims the current `workspaceKey` | Create one named `vscode.workspace.name ?? workspaceFolders[0].name ?? basename(wsPath)`, claiming `workspaceKey` + `wsPath` |

Other projects are never collapsed, never unioned with this workspace's key, and never removed.

**The one-time split.** Runs only while the registry holds exactly one pre-0.7 (flag-less) project claiming several keys — post-0.7 records always carry `nameSource`, so a multi-key project there is a deliberate union and is never split. For each claimed key: `name` = the `workspaceName` of that key's most recent session (fallback `'Workspace'`); the first still-unused `pathHint` whose basename equals that name is attached; a key with **no session and no matching hint** is skipped. The split projects are new records (`prj_…`, fresh color, `nameSource: 'auto'`) — the collapsed `id`/`color` are not preserved, and the whole split lands in a **single atomic write** (no partial intermediate file — a crash before it simply re-runs next activation). `~/.lalog/projects.json.pre-split.bak` holds the collapsed file byte-for-byte and is written **once** (only if it does not already exist). Idempotent: the next activation sees more than one project, so the guard fails. The `projects.json` schema is unchanged — no version marker, because the split is safe to re-run.

**Session re-pointing**: after the split, any `sessions.jsonl` line whose `projectId` refers to a removed record is rewritten (full-file rewrite, as in US-4.7) to the id of whichever project claims **that session's own** `workspaceKey` — one project per workspace, not one global survivor. Sessions with no `projectId` need no rewrite: they resolve through their own workspace's claim.

With `lalog.multiProject: true` the whole migration is skipped: nothing is split or named automatically, no backup is written, and a workspace claimed by several projects still resolves to the first match (known limitation).

---

## Export: files_by_day.txt

**Location**: `~/.lalog/exports/<slug>/files_by_day.txt`

**Format**: Plain text, compatible with the user's `group_file_histories.sh` script.

**Example**:

```
2026-09-03:
  - backend/auth.py
  - backend/login.py
  - frontend/App.tsx

2026-09-02:
  - backend/config.py
  - backend/oauth.py
```

**Generation**:
- Triggered by `lalog.exportFilesByDay` command
- Files are listed under each calendar day on which they had edit events
- Midnight-spanning sessions: files appear under both days if edits happened on both (derived from `firstTouch` and `lastTouch` timestamps)
- Grouped by project slug (top-level directory name)
- Files sorted alphabetically within each day

---

## Reports

**Location**: `~/.lalog/reports/<start-date>-<range>[-<slug>].md`, e.g. `2026-09-01-this-month.md`, `2026-09-07-custom.md`

**Format**: Markdown, session-centric.

**Example**:

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

### Sep 2, 15:00 → 17:00 · 2h · other-project · bugfix
— Fix CSS layout issue
*Files: styles.css, layout.tsx*
*Branch: fix/layout*
```

**Generation**:
- Triggered by `lalog.report` command
- User selects range: Today, Yesterday, This week, This month, Last month, or a custom `YYYY-MM-DD...YYYY-MM-DD` pair (up to 31 days)
- Sessions are never split across days (start-date attribution)
- The file is date-prefixed with the range start (local date) so each range of a different period gets its own non-overwriting file; a project scope adds a slug (`2026-09-01-this-month-my-project.md`); custom ranges prefix with the custom start date (`2026-09-03-custom.md`)

---

## Example Data

### Complete Workflow Example

**Scenario**: User works on "my-project" from 22:00 to 01:00 (overnight session).

**1. Session starts (22:00)**:

Active snapshot created: `~/.lalog/active/abc1234567.json`

```json
{
  "id": "20260903-2200-a1b2-c3d4",
  "workspaceKey": "abc1234567",
  "workspaceName": "my-project",
  "startedAt": 1725397200000,
  "lastActivityAt": 1725397200000,
  "activeMinutes": 0,
  "activeSpans": [],
  "activityTs": [],
  "notes": [],
  "needsDescription": false,
  "events": { "edits": 0, "saves": 0, "terminal": 0, "fileops": 0, "tasks": 0, "debug": 0, "topFiles": [] }
}
```

**2. User works for 90 minutes (22:00–23:30)**:

Events accrue active minutes. Snapshot updated periodically.

**3. Describe prompt appears (23:30)**:

User describes: "Fix login bug" (type: feature).

Snapshot updated:

```json
{
  "id": "20260903-2200-a1b2-c3d4",
  "workspaceKey": "abc1234567",
  "workspaceName": "my-project",
  "startedAt": 1725397200000,
  "lastActivityAt": 1725400800000,
  "activeMinutes": 5400000,
  "activeSpans": [
    { "start": 1725397200000, "end": 1725400800000 }
  ],
  "activityTs": [1725397200000, 1725397800000, 1725400200000, 1725400800000],
  "type": "feature",
  "description": "Fix login bug",
  "notes": [{"at": 1725400800000, "text": "Fix login bug"}],
  "needsDescription": false,
  "events": {
    "edits": 85,
    "saves": 12,
    "terminal": 5,
    "fileops": 4,
    "tasks": 1,
    "debug": 1,
    "topFiles": [
      {"path": "/home/user/my-project/src/auth.ts", "edits": 30, "firstTouch": 1725397200000, "lastTouch": 1725400800000}
    ]
  }
}
```

**4. User continues past midnight (00:00–01:00)**:

Session spans midnight. `startedAt` remains `2026-09-03T22:00:00`.

**5. User ends session (01:00)**:

Git annotation added. Session closed and appended to `sessions.jsonl`:

```json
{"id":"20260903-2200-a1b2-c3d4","workspaceKey":"abc1234567","workspaceName":"my-project","startedAt":1725397200000,"endedAt":1725404400000,"lastActivityAt":1725404400000,"activeMinutes":9300000,"activeSpans":[{"start":1725397200000,"end":1725400800000},{"start":1725402000000,"end":1725404400000}],"activityTs":[1725397200000,1725397800000,1725400200000,1725402000000,1725403200000,1725404400000],"type":"feature","description":"Fix login bug","notes":[{"at":1725400800000,"text":"Fix login bug"}],"needsDescription":false,"events":{"edits":142,"saves":23,"terminal":8,"fileops":11,"tasks":3,"debug":2,"topFiles":[{"path":"/home/user/my-project/src/auth.ts","edits":45,"firstTouch":1725397200000,"lastTouch":1725404400000}]},"gitBranch":"fix/login","commits":[{"hash":"a1b2c3d","subject":"Fix login validation"}],"closedReason":"user"}
```

Active snapshot deleted: `~/.lalog/active/abc1234567.json` removed.

**6. Report generated (next day)**:

Session appears under "Sep 3" (start-date attribution), even though it ended on Sep 4.

---

## Technical Sidecar

**Location**: `~/.lalog/technical/<sessionId>.jsonl`

**Purpose**: Stores detailed technical content (file diffs, terminal executions, AI interaction metadata) that would make the main `sessions.jsonl` unwieldy. The main session store stays compact; the sidecar captures what was actually done.

**Schema**: JSON Lines — one JSON object per line. Three entry types:

### Diff Entry

```typescript
interface TechnicalDiff {
  type: 'diff';
  ts: number;             // Unix timestamp (ms)
  path: string;           // Absolute file path
  diff: string;           // Unified diff (redacted, may be truncated)
  linesAdded: number;     // Lines added (excludes diff headers)
  linesRemoved: number;   // Lines removed (excludes diff headers)
  newFile: boolean;       // true if this is the first save for this path
}
```

### Terminal Entry

```typescript
interface TechnicalTerminal {
  type: 'terminal';
  ts: number;             // Unix timestamp (ms) of command end
  commandLine: string;    // The executed command (redacted)
  exitCode: number | null; // null if shell didn't report (ctrl+c, sub-shell)
  durationMs: number;     // Wall-clock duration of command execution
  cwd?: string;           // Working directory (if reported by shell integration)
  stdout?: string;        // Captured output (only when captureTerminalStdout is on; ANSI-stripped, redacted, capped)
  confidence: 'low' | 'medium' | 'high'; // Command line parsing confidence from VS Code
}
```

### AI Interaction Entry

```typescript
interface TechnicalAiInteraction {
  type: 'ai';
  ts: number;             // Unix timestamp (ms)
  task: string;           // 'describe' | 'narrative' | 'analysis'
  model: string;          // Model identifier
  latencyMs: number;      // Round-trip time for the AI call
  promptChars: number;    // Character count of the prompt (never the text itself)
  responseChars: number;  // Character count of the response (never the text itself)
  truncated: boolean;     // Whether the response was truncated
}
```

### Caps & Rotation

| Limit | Default | Description |
|-------|---------|-------------|
| `maxDiffChars` | 16,000 | Max characters per diff entry; appended with `\n...[truncated]` |
| `maxStdoutChars` | 32,000 | Max characters per terminal stdout; appended with `\n...[truncated]` |
| File size | 2 MB | When a sidecar exceeds this, it is rotated |
| Entries | 5,000 | On rotation, only the last N entries are kept |

### Retention

Diffs expire; terminal and AI metadata does not.

| Setting | Default | Description |
|---------|---------|-------------|
| `lalog.diffRetentionDays` | 14 | Days to keep `type:'diff'` entries. `0` keeps them forever. |

On every activation, LaLog sweeps `technical/` once:

- Every file matching the sidecar name pattern `<YYYYMMDD-HHMM>-<ws>-<rand>.jsonl` is read, and any `type:'diff'` entry whose own `ts` is older than `now - diffRetentionDays × 24h` is removed. Terminal and AI entries are never removed, regardless of age.
- A sidecar that is left with no entries at all is deleted.
- A sidecar that contains nothing to remove is not rewritten (byte-identical, untouched mtime).
- Any other file in `technical/` (notes, scratch files, anything that is not a sidecar) is never read or written.
- Lines that are not valid JSON are preserved verbatim.
- The rewrite itself is atomic: the filtered content is written to `<file>.tmp` and `renameSync`'d over the original. A file whose size or mtime changed between the read and the rename is skipped (something appended to it mid-sweep), and a stray `.tmp` from an interrupted run is deleted at the start of the next sweep.

A session whose diffs have aged out still shows its terminal commands and AI interactions in the session-detail document, with a note explaining that the diffs are outside the retention window.

### Redaction

All diff content and terminal stdout are scanned against `lalog.redactPatterns` (compiled as case-insensitive global regexes). Matching text is replaced with `[REDACTED]` before storage.

### Storage Notes

- **Sidecar path** is stored in `Session.technicalSidecar` (absolute path, set on first write)
- **Binary files** (null byte in first 8KB) are skipped — no diff entry is written
- **First save** for a path produces a new-file diff (all lines added, `newFile: true`)
- **Identical saves** produce no entry
- **Stdout capture** is opt-in (`lalog.captureTerminalStdout`, default off) because it may contain sensitive data and requires shell integration (`read()` must attach at command start)
- **AI interaction** entries store character counts only — prompt and response text are never captured
- **Best-effort** — all writes are wrapped in try/catch; failures are logged to console.error but never thrown

---

## Related Pages

- [Architecture](architecture.md) — storage model and recovery
- [Features](features.md) — storage and reporting features
- [Decisions](decisions.md) — JSONL storage decision (ADR-004)
- [Development](development.md) — how to build and test