# Subsystems

Start-here lists are deliberately short. For any task, cross-check
[`codemap.md`](../../codemap.md), which already maps "change X" → "edit Y" for the
whole repo, and [`docs/architecture.md`](../../docs/architecture.md) for the diagrams.

---

## Wiring / activation — `src/extension.ts`

Command registration, status bar, panel, AI service wiring, and the startup sweeps
(diffs-only retention prune, per-workspace project resolution, `.pre-split.bak` split,
dangling-`projectId` heal).

**Start here**
- `src/extension.ts` — the single `activate()`; every `lalog.*` command and every
  cross-subsystem callback is defined here.
- `src/extension.ts` (`commands` object, ~line 142) — the command table; add new
  commands here and to `package.json` `contributes.commands` together.

**Boundary:** owns composition and nothing else. It may hold prompt/QuickPick flows for
report ranges and export options; it must not contain session logic.

**Do not:** let `SessionManager` or a subsystem import `extension.ts`.

---

## Session orchestration — `src/core/sessionManager.ts`

The orchestrator: session lifecycle, heartbeat (`checkIdle`, `checkAutoEnd`,
`checkProgress`), prompt scheduling and delivery, describe-result application,
recovery, technical-capture wiring.

**Start here**
- `src/core/sessionManager.ts` — every session mutation path (`endSession`,
  `endAndRestart`, `startFresh`, `pause`/`resume`) and the heartbeat loop.
- `src/core/stateMachine.ts` — pure transitions that decide *when*; the manager decides
  *what happens*.
- `src/prompts/promptCoordinator.ts` — the mutex and min-spacing that all prompt
  delivery goes through.
- `src/core/spans.ts` — active-time span arithmetic (`updateActiveSpan`, `trimToCutoff`).

**Depends on:** storage, prompts, capture, pure core. **Boundary:** the only place that
may call session-mutating storage.

**Do not** (ADR-017 / ADR-019, and invariants in `codemap.md`):
- ask any question about a *closed* session — `endSession` closes silently;
- let tracking lapse: every event starts a session if none is open, and
  `openWorkspace` always auto-starts;
- let anything bypass `PromptCoordinator` (one prompt at a time, minimum spacing).

---

## Persistence — `src/storage/`

**Start here**
- `src/storage/store.ts` — fs primitives (`appendLine`, `saveSnapshot`), `workspaceKey`,
  `buildPaths`. Use these; do not open files directly elsewhere.
- `src/storage/sessionStore.ts` — `sessions.jsonl` CRUD; `close`, `loadActive`,
  `deleteSession` (full-file rewrite, no fallback — ADR-023).
- `src/storage/technicalStore.ts` — per-session sidecar `technical/<id>.jsonl`, rotation,
  `pruneDiffEntriesBefore` (diffs only; terminal/AI entries are kept forever — ADR-026).
- `src/storage/projectRegistry.ts` — `projects.json`, folder claims,
  `ensureWorkspaceProject`, and the `nameSource: 'auto' | 'user'` flag (ADR-030).

**Boundary:** imports only `core/types`, `core/config`, `core/projects`. No `vscode`,
no `reporting`, no `SessionManager`.

**Do not:** make storage mutating-out-of-band. Sessions close *only* through
`SessionManager.endSession`, so `closedAt`/`endedAt` semantics stay in one place.

---

## Capture — `src/capture/`

**Start here**
- `src/capture/diffCapture.ts` — unified diffs at save time, redacted and capped at
  `maxDiffChars`.
- `src/capture/terminalCapture.ts` — shell-integration command metadata; stdout only when
  `lalog.captureTerminalStdout` is on.
- `src/capture/redactText.ts` — compiles `lalog.redactPatterns`; route text through it.
- `src/capture/aiLog.ts` — AI interaction *metadata* only (char counts, latency).

**Do not:** log prompt/response text, file contents, or commit bodies (ADR-005 / ADR-011).
Terminal commands must pass through redaction before storage.

---

## Prompts — `src/prompts/`

**Start here**
- `src/prompts/promptCoordinator.ts` — mutex + min-spacing (`acquire`/`release`);
  the only legitimate way to show a prompt.
- `src/prompts/describeFlow.ts` — text-first describe (InputBox → task-type QuickPick),
  `SESSION_TYPES`, `buildPrefill`, `DescribeResult`.

**Do not:** add a prompt that fires at close/restart. The task-type QuickPick **must**
pre-select a default (`quickPickWithDefault`) — a bare `showQuickPick` resolves to
`undefined` on Enter and loses the typed description.

---

## Reporting / derivation — `src/reporting/`

**Start here**
- `src/reporting/ranges.ts` — range math and `dayKey`, the single local `YYYY-MM-DD`
  definition (ADR-027). Nothing else may format a day.
- `src/reporting/insights.ts` — pure aggregations and the hour timeline; hour cells carry
  per-project `parts` with contributing `sessionIds` (ADR-028).
- `src/reporting/sessionDetail.ts` — `renderSessionDetail`, `renderDayDiffs`; pure
  markdown for the untitled preview documents (ADR-025).
- `src/reporting/report.ts` / `pdfReport.ts` — markdown and PDF report assembly;
  `pdf.ts` is the hand-rolled PDF 1.4 writer (ADR-024).
- `src/reporting/spans.ts`, `aggregate.ts` — in/out-of-VS-Code split and today's totals.

**Boundary:** pure functions over loaded sessions. No caching of derived aggregates —
compute at render time.

---

## UI — `src/ui/`

**Start here**
- `src/ui/panelView.ts` — the webview panel: Sessions / Insights / Projects tabs, the
  fixed "Current Session" footer, day grouping, project filter chips, hour timeline.
- `src/ui/statusBar.ts` — status bar item and quick-actions menu.

**Boundary:** reads state through injected callbacks; mutates sessions only by invoking
the command handlers it was given (delete/rename/project-assign).

---

## Projects — `src/core/projects.ts` + `storage/projectRegistry.ts`

Split on purpose: `core/projects.ts` is the pure model (`Project`, `resolveProject`,
`pickProjectColor`, `isAutoNamed`); the registry owns persistence.

**Start here:** `src/core/projects.ts` — the record shape and `nameSource` semantics.

**Do not:** collapse the default single-project mode. `lalog.multiProject` is opt-in
advanced behavior; one workspace → one project is the default (ADR-029 / ADR-030).

---

## AI (optional) — `src/opencode/`

**Start here**
- `src/opencode/service.ts` — task API and lazy construction gating.
- `src/opencode/runTransport.ts` — spawns the `opencode` CLI over a JSON-line transport,
  with timeout/retry.
- `src/opencode/redact.ts` + `modelPolicy.ts` — what may leave the machine, and which
  models are allowed.

**Boundary:** reachable only through function hooks injected by `extension.ts`. Never
construct the service when `lalog.ai.enabled` is false.

---

## Tests — `test/`

`test/userStories/*.test.ts`, one file per epic, sections labeled with the `US-` ids from
[`docs/user-stories.md`](../../docs/user-stories.md). `test/helpers/mockVscode.ts` is the
`vscode` stand-in; `test/helpers/harness.ts` provides a real `SessionManager` over a temp
`dataDir` with mock timers.

**Start here:** `test/helpers/harness.ts` — `defaultConfig()` (note: `debugTimeScale: 60`
and near-disabled idle thresholds by default), `tick()`, `waitFor()`.

**Do not:** add a test outside `test/**/*.test.ts` — `esbuild.test.js` discovers by that
pattern.