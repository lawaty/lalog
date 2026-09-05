# Architecture

[Home](README.md) > **architecture**

> Module overview, data flow, and design philosophy of the LaLog extension.

---

## Table of Contents

- [Design Philosophy](#design-philosophy)
- [Module Map](#module-map)
- [Data Flow](#data-flow)
- [State Machine](#state-machine)
- [Session Lifecycle](#session-lifecycle)
- [Prompt Flow](#prompt-flow)
- [Storage Model](#storage-model)
- [Recovery Model](#recovery-model)

---

## Design Philosophy

LaLog is built on five principles:

1. **Passive capture, active description** — The extension captures events (edits, saves, terminal, file ops, debug, tasks) automatically. The human only provides descriptions at natural breakpoints.
2. **Sessions are engagement threads** — Not day-bound. An overnight coding session from 22:00 to 02:00 is one session. The only boundary is ~2h idle.
3. **Never trust interval timers; confirm idle** — Active time is computed from event gaps, not `setInterval`. If you step away for more than 15 minutes, that gap is not counted — unless you confirm "Are you still there?", in which case the idle stretch counts as active but *outside* VS Code (tagless spans classified at report time).
4. **Breakpoint-aligned prompting** — Prompts are held until a natural pause (terminal command ends, debug session terminates, return from idle). No interrupting flow.
5. **Local-only, crash-safe** — JSONL append-only storage. Atomic snapshots for active sessions. Zero telemetry.

---

## Module Map

```mermaid
flowchart TB
    subgraph entry["Entry Point"]
        EXT["extension.ts<br/>activate() / deactivate()"]
    end

    subgraph core["core/"]
        SM["stateMachine.ts<br/>Pure state transitions"]
        SEM["sessionManager.ts<br/>Orchestrator"]
        AT["activityTracker.ts<br/>VS Code event listener"]
        BD["breakpoints.ts<br/>Natural breakpoint detector"]
        CFG["config.ts<br/>Settings + thresholds"]
        REC["sessionManager.ts<br/>machine rebuild on open"]
        TYP["types.ts<br/>Shared types"]
    end

    subgraph prompts["prompts/"]
        PC["promptCoordinator.ts<br/>Mutex + spacing"]
        DF["describeFlow.ts<br/>2-step describe UI"]
    end

    subgraph storage["storage/"]
        SS["sessionStore.ts<br/>Session CRUD"]
        ST["store.ts<br/>Filesystem primitives"]
    end

    subgraph reporting["reporting/"]
        AGG["aggregate.ts<br/>todayActiveMs, todayUntrackedMs"]
        RPT["report.ts<br/>Markdown report generation"]
    end

    subgraph integrations["integrations/"]
        GIT["git.ts<br/>Branch + commit annotation"]
        LEG["legacyExport.ts<br/>files_by_day.txt export"]
    end

    subgraph ui["ui/"]
        SB["statusBar.ts<br/>Status bar item"]
        SV["sessionsView.ts<br/>Tree view provider"]
    end

    EXT --> SM
    EXT --> SEM
    EXT --> SS
    EXT --> SB
    EXT --> SV
    EXT --> RPT
    EXT --> LEG
    EXT --> GIT

    SEM --> SM
    SEM --> AT
    SEM --> BD
    SEM --> PC
    SEM --> SS
    SEM --> CFG

    PC --> DF
    SS --> ST
    RPT --> ST
    LEG --> ST
    SV --> SS
    SB --> AGG
```

### Module Responsibilities

| Module | Files | Responsibility |
|--------|-------|----------------|
| **core/** | `stateMachine.ts`, `sessionManager.ts`, `activityTracker.ts`, `breakpoints.ts`, `config.ts`, `spans.ts`, `types.ts` | Pure state machine, session orchestration (idle/progress/auto-end checks), VS Code event capture, breakpoint detection, configuration, active-span arithmetic |
| **prompts/** | `promptCoordinator.ts`, `describeFlow.ts` | Prompt mutex (one at a time, min spacing), 2-step describe UI (type picker → input box), on-start/progress/close note prompts |
| **storage/** | `sessionStore.ts`, `store.ts` | Session CRUD, JSONL append, atomic snapshots, filesystem primitives |
| **reporting/** | `aggregate.ts`, `report.ts`, `spans.ts` | Today's active/untracked time, session-centric markdown reports, in/out-of-VS-Code split |
| **integrations/** | `git.ts`, `legacyExport.ts` | Git branch/commit annotation, legacy `files_by_day.txt` export |
| **ui/** | `statusBar.ts`, `sessionsView.ts` | Status bar (live duration + description), tree view (sessions grouped by day with per-session detail rows) |

---

## Data Flow

```mermaid
flowchart LR
    subgraph vscode["VS Code Events"]
        E1["onDidChangeActiveTextEditor"]
        E2["onDidChangeTextDocument"]
        E3["onDidSaveTextDocument"]
        E4["onDidCreateFiles / onDidDeleteFiles"]
        E5["onDidStartTerminalShellExecution"]
        E6["onDidStartTask / onDidStartDebugSession"]
    end

    AT["ActivityTracker<br/>(2s edit debounce)"]
    SM["SessionManager<br/>.onActivityEvent()"]
    FSM["stateMachine.onActivity()<br/>Pure transition"]
    SS["SessionStore<br/>.recordEvent()"]
    BD["BreakpointDetector<br/>.checkReturnIdle()"]
    PC["PromptCoordinator<br/>acquire() / release()"]
    DF["DescribeFlow / WrapPrompt"]
    FS["~/.lalog/<br/>sessions.jsonl<br/>active/*.json"]

    E1 & E2 & E3 & E4 & E5 & E6 --> AT
    AT -->|"handler(ev, file, ts)"| SM
    SM -->|"onActivity(m, ts, th)"| FSM
    SM -->|"recordEvent(s, ev, file, ts)"| SS
    SM -->|"checkReturnIdle(ts)"| BD
    BD -->|"onBreakpoint(kind)"| SM
    SM -->|"askDescribe / askWrap"| PC
    PC --> DF
    SS --> FS
```

### Event Processing Pipeline

1. **VS Code fires an event** (editor change, document edit, save, file op, terminal, task, debug)
2. **ActivityTracker** receives it, applies a 2-second debounce on edits (to coalesce rapid keystrokes), and calls the handler
3. **SessionManager.onActivityEvent()** is the orchestrator:
   - Calls `stateMachine.onActivity(machine, ts, thresholds)` — pure state transition
   - Calls `sessionStore.recordEvent(session, event, filePath, ts)` — increments counters, updates topFiles
   - Calls `breakpoints.checkReturnIdle(ts)` — detects return-from-idle breakpoint
   - Schedules persistence (`saveActive` snapshot)
   - Evaluates prompt state: if `describePending` or `wrapPending`, schedules prompt delivery
4. **BreakpointDetector** signals natural breakpoints (terminal end, git commit, debug end, return-idle)
5. **PromptCoordinator** enforces mutex (one prompt visible at a time) and minimum spacing
6. **DescribeFlow / WrapPrompt** presents the UI (QuickPick → InputBox)
7. **SessionStore** persists to JSONL (closed sessions) or atomic snapshot (active sessions)

---

## State Machine

The state machine is a pure function: `(state, event, thresholds) → newState`. It lives in `src/core/stateMachine.ts` and has no side effects.

```mermaid
stateDiagram-v2
    [*] --> idle

    idle --> active : first activity event (sessions always auto-start)

    active --> describePending : activeMinutes >= describeAt (90min)
    active --> wrapPending : activeMinutes >= wrapAt (210min) [if describePending skipped]

    describePending --> active : user describes (choice: 'described')
    describePending --> active : user defers (choice: 'later')
    describePending --> wrapPending : activeMinutes >= wrapAt

    wrapPending --> grace : user extends (choice: 'extend')
    wrapPending --> idle : user wraps (choice: 'wrap-new') → endSession + startFresh

    grace --> wrapPending : grace timer expires (30min)
    grace --> describePending : maxGraceExtensions reached → must describe

    note right of idle : No session active
    note right of active : Tracking active minutes<br/>(gap-based accrual)
    note right of describePending : Prompt held until<br/>natural breakpoint
    note right of wrapPending : Prompt held until<br/>natural breakpoint
    note right of grace : 30-min extension window<br/>before re-prompt
```

### State Transitions

| From | To | Trigger | Condition |
|------|----|---------|-----------|
| `idle` | `active` | `onActivity()` | First event after activation (sessions auto-start) |
| `active` | `describePending` | `onActivity()` | `activeMinutes >= describeAt` (default 90 min) |
| `active` | `wrapPending` | `onActivity()` | `activeMinutes >= wrapAt` (default 210 min) |
| `describePending` | `active` | describe reply | User provides description or defers |
| `describePending` | `wrapPending` | `onActivity()` | `activeMinutes >= wrapAt` while waiting for describe |
| `wrapPending` | `grace` | wrap reply | User chooses "Extend 30 min" |
| `wrapPending` | `idle` | wrap reply | User chooses "Wrap & start new" → `endSession()` |
| `grace` | `wrapPending` | timer | Grace period (30 min) expires |
| `grace` | `describePending` | `onActivity()` | `maxGraceExtensions` reached → must describe |

### Active Time Accrual

Active minutes are computed from **event gaps**, not wall-clock time:

```typescript
// In stateMachine.onActivity():
if (m.lastActivityAt !== null) {
  const gap = now - m.lastActivityAt;
  if (gap < th.idleGap) {        // idleGap default: 15 min
    m.activeMinutes += gap;       // only count gaps < 15 min
  }
}
m.lastActivityAt = now;
```

This means:
- If you type continuously with <15 min between events, every millisecond counts
- If you step away for 20 minutes, that gap is **not** counted — unless you confirm "still working", which counts it as active but outside VS Code
- If you step away for 3 hours, the session stays open but accrues 0 active minutes during that time
- After 2h idle (`autoEndIdle`), the session auto-closes with `endedAt = lastActivityAt`

---

## Session Lifecycle

```mermaid
sequenceDiagram
    participant VSCode as VS Code
    participant EXT as extension.ts
    participant SM as SessionManager
    participant FSM as StateMachine
    participant SS as SessionStore
    participant PC as PromptCoordinator
    participant User as User

    Note over VSCode,User: Activation (onStartupFinished)

    VSCode->>EXT: activate()
    EXT->>SM: new SessionManager(store, th, paths)
    EXT->>SM: manager.start()
    SM->>SS: loadActive(wsKey)

    alt Existing session found
        SS-->>SM: Session snapshot
        SM->>SM: Check idle duration
        alt idle >= 2h (autoEndIdle)
            SM->>PC: askClosingNote(session)
            PC->>User: "Unfinished session — closing note?"
            User-->>PC: text or Esc
            SM->>SS: close(session, 'auto-idle', lastActivityAt)
            SM->>FSM: newMachine() → idle
        else idle < 30min (resumeWindow)
            SM->>FSM: recoverActiveMachine(session)
            Note over SM: Resume same session
        else 30min <= idle < 2h
            SM->>FSM: recoverActiveMachine(session)
            Note over SM: Same session continues,<br/>gap uncounted
        end
    else No existing session
        SM->>SS: newSession(wsKey, wsName, now)
        SM->>PC: describeShutdownSession (optional, if last ended on close)
        SM->>FSM: startSession(machine, now) → active
        Note over SM: Always auto-start — never untracked
    end

    Note over VSCode,User: Active Session

    loop Every VS Code event
        VSCode->>SM: onActivityEvent(ev, file, ts)
        SM->>FSM: onActivity(machine, ts, th)
        FSM-->>SM: newState
        SM->>SS: recordEvent(session, ev, file, ts)
        SM->>SS: saveActive(session) [snapshot]

        alt state == describePending
            SM->>SM: schedulePrompt('describe')
            Note over SM: Wait for breakpoint<br/>or force after 30min
            SM->>PC: askDescribe(machine, session, breakpoint)
            PC->>User: QuickPick (task type) → InputBox (description)
            User-->>PC: type + text
            SM->>FSM: state = active (or wrapPending if past wrapAt)
        else state == wrapPending
            SM->>SM: schedulePrompt('wrap')
            SM->>PC: askWrap(machine, session, breakpoint)
            PC->>User: "Session at 3h30m — wrap it up?"
            User-->>PC: "Wrap & new" / "Extend 30m" / "Add description" / "Skip"
            alt Wrap & new
                SM->>SM: endSession('user') → startFresh()
            else Extend
                SM->>FSM: state = grace, graceExtensions++
                Note over SM: Re-arm wrap after 30min
            end
        end
    end

    Note over VSCode,User: Session End

    alt User ends session
        VSCode->>SM: lalog.endSession command
        SM->>FSM: autoClose(machine, now)
        FSM-->>SM: { activeMinutes, endedAt: lastActivityAt }
        SM->>SS: close(session, 'user', endedAt)
        SS->>SS: appendLine(sessions.jsonl, session)
        SS->>SS: removeActive(wsKey)
        EXT->>EXT: annotateSessionWithGit(session, cwd)
    else Auto-close (2h idle)
        SM->>SM: Detect idle >= autoEndIdle
        SM->>PC: askClosingNote(session)
        PC->>User: "Unfinished session — closing note?"
        SM->>SS: close(session, 'auto-idle', lastActivityAt)
    end
```

---

## Prompt Flow

```mermaid
sequenceDiagram
    participant SM as SessionManager
    participant BD as BreakpointDetector
    participant PC as PromptCoordinator
    participant DF as DescribeFlow
    participant User as User

    Note over SM: state = describePending

    SM->>SM: schedulePrompt('describe')
    Note over SM: Set force timer:<br/>describeForce - describeAt<br/>(default: 30 min)

    alt Breakpoint arrives before force timer
        BD->>SM: onBreakpoint('terminal' | 'git-commit' | 'debug' | 'return-idle')
        SM->>PC: askDescribe(machine, session, breakpoint)
    else Force timer expires
        SM->>PC: askDescribe(machine, session, null)
    end

    PC->>PC: acquire() — check mutex + spacing
    PC->>DF: runDescribeFlow(session, sameAsLast?)
    DF->>User: QuickPick: "What are you working on?"
    Note over User: Options: feature, bugfix,<br/>research, refactor, review,<br/>docs, ops, other,<br/>(same as last), Later
    User-->>DF: chosen type

    alt "Later"
        DF-->>PC: { choice: 'later' }
    else "Same as last"
        DF-->>PC: { choice: 'described', type: 'other', text: sameAsLast }
    else Specific type
        DF->>DF: buildPrefill(session) — top files + git branch
        DF->>User: InputBox: "Describe (<type>)"
        Note over User: Pre-filled with:<br/>[branch] file1, file2, file3
        User-->>DF: description text
        DF-->>PC: { choice: 'described', type, text }
    end

    PC-->>SM: DescribeResult
    SM->>SM: applyDescribeResult(session, result)
    Note over SM: state = active<br/>(or wrapPending if past wrapAt)
```

### Prompt Coordinator Mutex

The `PromptCoordinator` enforces:
1. **One prompt visible at a time** — `acquire()` returns false if another prompt is showing
2. **Minimum spacing** — at least 2 minutes between prompts (scaled by `debugTimeScale`)
3. **Non-blocking** — if `acquire()` fails, the prompt is silently skipped (state remains pending)

---

## Storage Model

```mermaid
flowchart TB
    subgraph datadir["~/.lalog/"]
        ACTIVE["active/<br/>&lt;wsKey&gt;.json"]
        JSONL["sessions.jsonl"]
        EXPORTS["exports/<br/>&lt;slug&gt;/files_by_day.txt"]
        REPORTS["reports/<br/>YYYY-MM.md"]
    end

    SS["SessionStore"]
    ST["store.ts"]

    SS -->|"saveActive(session)"| ACTIVE
    SS -->|"close(session)"| JSONL
    SS -->|"removeActive(wsKey)"| ACTIVE
    ST -->|"appendLine()"| JSONL
    ST -->|"saveSnapshot() — atomic tmp+rename"| ACTIVE
    ST -->|"streamLines()"| JSONL
```

### Storage Primitives

| Function | File | Atomicity | Purpose |
|----------|------|-----------|---------|
| `appendLine(file, data)` | `store.ts` | POSIX near-atomic (open-append-write-close) | Append closed session to JSONL |
| `saveSnapshot(file, data)` | `store.ts` | Atomic (write tmp → rename) | Persist active session snapshot |
| `readSnapshot(file)` | `store.ts` | Read-only | Load active session on recovery |
| `streamLines(file, onLine)` | `store.ts` | Streaming | Read all closed sessions (skips malformed lines) |

### Why JSONL?

- **Crash-safe** — append-only, no partial writes corrupt the file
- **Human-readable** — `cat sessions.jsonl | jq .` works
- **Grep-friendly** — `grep '"workspaceKey":"abc"' sessions.jsonl`
- **Append-only** — no read-modify-write cycles for normal operation
- **Exception: `updateSession()`** — rewrites the full file to patch a session's fields (used by the "Edit session" command)

---

## Recovery Model

```mermaid
flowchart TD
    START["VS Code starts / workspace opens"] --> LOAD["SessionStore.loadActive(wsKey)"]
    LOAD --> EXISTS{Session exists?}

    EXISTS -->|No| NEW["createSession + startSession → active<br/>always auto-start"]
    EXISTS -->|Yes| CHECK["Check idle duration"]

    CHECK --> IDLE2H{idle >= 2h?}
    IDLE2H -->|Yes| AUTOCLOSE["Auto-close session<br/>endedAt = lastActivityAt<br/>Ask closing note"]
    IDLE2H -->|No| IDLE30M{idle < 30min?}

    IDLE30M -->|Yes| RESUME["Resume session<br/>Reset lastActivityAt to now<br/>(avoid gap accrual)"]
    IDLE30M -->|No| RECOV_SKIP["Auto-close as recovery-skip<br/>then start fresh"]

    AUTOCLOSE --> IDLE["state = idle"]
    RESUME --> ACTIVE["state = active"]
    RECOV_SKIP --> ACTIVE
    NEW --> ACTIVE
```

### Recovery Guarantees

1. **No zombie sessions** — only a real activity event resets the idle clock, never a periodic timer or window reopen
2. **No gap accrual on reopen** — when recovering, `lastActivityAt` is set to `now` so the first event doesn't accrue a giant gap
3. **Snapshot persistence** — active sessions are saved every 60 seconds (heartbeat) and on every state change
4. **Atomic snapshots** — write to `.tmp` then rename, so a crash mid-write doesn't corrupt the snapshot

---

## Related Pages

- [Features](features.md) — detailed feature documentation
- [Decisions](decisions.md) — Architecture Decision Records
- [Data Format](data-format.md) — JSONL schema and snapshot format
- [Development](development.md) — build, test, and run