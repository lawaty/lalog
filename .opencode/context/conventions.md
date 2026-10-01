# Conventions

## Naming and shape

- Files are `camelCase.ts`; exported functions `camelCase`, types `PascalCase`.
- No classes in pure modules. Classes exist only where there is state or a disposable:
  `SessionManager`, `SessionStore`, `TechnicalStore`, `ProjectRegistry`,
  `LaLogPanelProvider`, `LaLogStatusBar`. Everything else is exported functions.
- Public API is explicit `export function` / `export const`; no default exports.

## Time

- **Timestamps are epoch milliseconds everywhere.** Settings are in *minutes*; convert
  once in `thresholdsMs()` (`core/config.ts`). Never store minutes internally.
- **Time is injected, never read from the clock,** in pure modules: functions take a
  `now: number` parameter. Only `SessionManager` and `extension.ts` call `Date.now()`.
- A single day key exists — `dayKey()` in `reporting/ranges.ts` (ADR-027). Do not format
  `YYYY-MM-DD` anywhere else; UTC-based `toISOString().slice(0,10)` is a bug here
  because days are *local* calendar days.
- `lalog.debugTimeScale` divides every threshold in `thresholdsMs()`; new time gates must
  go through that function so scaling keeps working.

## Modules and dependencies

- Direction is strictly downward (see `architecture.md`). Shared leaves are
  `core/types.ts`, `core/config.ts`, `core/projects.ts`.
- Prefer `import type` for type-only imports — the codebase does this consistently, which
  keeps the runtime dependency graph small.
- Only the nine files listed in `architecture.md` may import `vscode`.
- Only `extension.ts` composes subsystems; wire cross-cutting behavior through
  `SessionManager`'s setter hooks (`setOnStateChanged`, `setAiDraft`,
  `setAiInteractionLogger`, `setLastDescriptionProvider`).

## Error handling

- No framework and no logging layer. Errors surface as rejected promises from
  `SessionManager` methods (e.g. `endSession`) and are caught at the `extension.ts`
  command boundary, which shows the message to the user.
- Storage writes are atomic where it matters: `saveSnapshot` writes a temp file and
  renames; `appendLine` is a single append for crash safety (ADR-004).
- Session deletion is a full-file rewrite of `sessions.jsonl` with **no fallback**
  (ADR-023) — do not add a "restore previous" path.
- Timers created in `SessionManager` are `unref()`ed and cleared in `dispose()`.

## Privacy and capture

- Everything is local; no network call exists unless `lalog.ai.enabled` is true.
- AI receives the compact session summary only — never file contents, terminal output,
  prompt/response text, or commit bodies. Commit subjects are gated by
  `lalog.ai.data.sendCommitSubjects`.
- Terminal text passes through `compileRedactPatterns` (`capture/redactText.ts`) before
  it is stored.
- AI output is always labeled as AI-generated and is never silently persisted as truth.

## Tests

- Node's built-in runner (`node:test`) only — no Jest/Mocha. Tests are synchronous and
  fast.
- Discovery is by filename: `test/**/*.test.ts`, bundled to `dist-test/` by
  `esbuild.test.js`. A test outside that pattern will not run.
- Tests import production modules directly; the `vscode` specifier is resolved to
  `test/helpers/mockVscode.ts` by an esbuild plugin at build time.
- Time is controlled with `t.mock.timers` via the harness helpers `tick()` and
  `waitFor()`; never `sleep` in a real duration.
- Every test file sits under `test/userStories/` and is named after the epic it covers;
  sections are commented with the `US-` ids from `docs/user-stories.md`.
- `tsconfig.json` includes only `src`, so `npm run typecheck` does **not** check tests.

## Build and packaging

- `npm run build` → `dist/extension.js` (cjs, node18, `vscode` external, sourcemap on,
  not minified).
- `npm test` bundles and runs `dist-test/**/*.test.js`.
- `npm run package` runs `vsce package`; `vscode:prepublish` builds first.
- `.vscodeignore` keeps `src/`, `test/`, `docs/`, `dist-test/`, and `.opencode/` out of
  the `.vsix`. If you add a top-level directory, decide deliberately whether it ships.

## Adding things

- New setting → `package.json` `contributes.configuration` **and** `core/config.ts`
  (`LaLogConfig`, plus `thresholdsMs()` if it is a time gate), and document it in
  `docs/features.md`.
- New command → `package.json` `contributes.commands` **and** `extension.ts`
  `registerCommand`, and `README.md` + `docs/README.md` command tables.
- Behavior or architecture change → update `docs/features.md`, `docs/architecture.md`,
  and add an ADR in `docs/decisions.md`.
- Persisted field change → `docs/data-format.md`.