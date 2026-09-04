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

---

## Directory Layout

All data is stored in `~/.lalog/` (configurable via `lalog.dataDir`):

```
~/.lalog/
├── sessions.jsonl              # All closed sessions (append-only)
├── active/
│   ├── <wsKey>.json            # Active session snapshot per workspace
│   └── <wsKey>.json.tmp        # Temporary file during atomic write
├── exports/
│   └── <slug>/
│       └── files_by_day.txt    # Legacy export format
└── reports/
    └── YYYY-MM.md              # Monthly report files
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
  activeMinutes: number;         // Total active minutes (gap-based)
  type?: SessionType;            // "feature" | "bugfix" | "research" | "refactor" | "review" | "docs" | "ops" | "other"
  description?: string;          // User-provided description
  notes: { at: number; text: string }[];  // Timestamped notes
  needsDescription: boolean;     // True if session lacks description
  events: {
    edits: number;               // Total edit events
    saves: number;               // Total save events
    terminal: number;            // Total terminal events
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

interface SessionCommits {
  hash: string;                  // Short commit hash (7-40 chars)
  subject: string;               // Commit message subject
}
```

**Example line**:

```json
{"id":"20260903-2200-a1b2-c3d4","workspaceKey":"abc1234567","workspaceName":"my-project","startedAt":1725397200000,"endedAt":1725404400000,"lastActivityAt":1725404400000,"activeMinutes":95,"type":"feature","description":"Fix login bug","notes":[{"at":1725400800000,"text":"Fixed validation logic"}],"needsDescription":false,"events":{"edits":142,"saves":23,"terminal":8,"topFiles":[{"path":"/home/user/my-project/src/auth.ts","edits":45,"firstTouch":1725397200000,"lastTouch":1725404400000},{"path":"/home/user/my-project/src/login.ts","edits":32,"firstTouch":1725397500000,"lastTouch":1725404000000}]},"gitBranch":"fix/login","commits":[{"hash":"a1b2c3d","subject":"Fix login validation"},{"hash":"e4f5g6h","subject":"Add error handling"}],"closedReason":"user"}
```

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
  "activeMinutes": 60,
  "type": "feature",
  "description": "Fix login bug",
  "notes": [],
  "needsDescription": false,
  "events": {
    "edits": 85,
    "saves": 12,
    "terminal": 5,
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

**Location**: `~/.lalog/reports/YYYY-MM.md`

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
- User selects range: Today, Yesterday, This week, This month, Last month
- Sessions are never split across days (start-date attribution)
- Report is saved to monthly file (e.g., `2026-09.md`), overwriting previous content

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
  "notes": [],
  "needsDescription": false,
  "events": { "edits": 0, "saves": 0, "terminal": 0, "topFiles": [] }
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
  "activeMinutes": 90,
  "type": "feature",
  "description": "Fix login bug",
  "notes": [{"at": 1725400800000, "text": "Fix login bug"}],
  "needsDescription": false,
  "events": {
    "edits": 85,
    "saves": 12,
    "terminal": 5,
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
{"id":"20260903-2200-a1b2-c3d4","workspaceKey":"abc1234567","workspaceName":"my-project","startedAt":1725397200000,"endedAt":1725404400000,"lastActivityAt":1725404400000,"activeMinutes":155,"type":"feature","description":"Fix login bug","notes":[{"at":1725400800000,"text":"Fix login bug"}],"needsDescription":false,"events":{"edits":142,"saves":23,"terminal":8,"topFiles":[{"path":"/home/user/my-project/src/auth.ts","edits":45,"firstTouch":1725397200000,"lastTouch":1725404400000}]},"gitBranch":"fix/login","commits":[{"hash":"a1b2c3d","subject":"Fix login validation"}],"closedReason":"user"}
```

Active snapshot deleted: `~/.lalog/active/abc1234567.json` removed.

**6. Report generated (next day)**:

Session appears under "Sep 3" (start-date attribution), even though it ended on Sep 4.

---

## Related Pages

- [Architecture](architecture.md) — storage model and recovery
- [Features](features.md) — storage and reporting features
- [Decisions](decisions.md) — JSONL storage decision (ADR-004)
- [Development](development.md) — how to build and test