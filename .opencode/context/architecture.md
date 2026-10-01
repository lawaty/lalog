# Architecture

> Navigation-level view only. The authoritative module map, diagrams, and lifecycle
> narrative live in [`docs/architecture.md`](../../docs/architecture.md); the task→file
> lookup table lives in [`codemap.md`](../../codemap.md); ADR rationale in
> [`docs/decisions.md`](../../docs/decisions.md).

## What this is

A single-process VS Code extension (`main: ./dist/extension.js`) that converts VS Code
activity into local work-session records under `~/.lalog/`. No server, no daemon, no
telemetry. One runtime dependency (`diff`). Activates on `onStartupFinished`.

## Layers and dependency direction

Dependencies flow downward only. No layer imports the one above it.

| Layer | Location | May import | `vscode` API |
|---|---|---|---|
| Wiring | `src/extension.ts` | all | yes |
| Orchestration | `src/core/sessionManager.ts` | storage, prompts, capture, pure core | yes |
| Shared leaves | `src/core/types.ts`, `core/config.ts`, `core/projects.ts` | nothing | no |
| Pure core | `src/core/stateMachine.ts`, `core/spans.ts` | shared leaves | no |
| Interaction | `src/prompts/`, `src/ui/` | pure core, reporting, storage | yes |
| Persistence | `src/storage/` | shared leaves only | no |
| Derivation | `src/reporting/` | shared leaves, `storage/store.ts` | no |
| Capture | `src/capture/` | `core/types` only | no |
| Adapters | `src/integrations/`, `src/opencode/` | shared leaves | no |

**The load-bearing rule: exactly nine files import `vscode`** — `extension.ts`,
`core/{sessionManager,activityTracker,breakpoints,config}.ts`,
`prompts/{promptCoordinator,describeFlow}.ts`, `ui/{panelView,statusBar}.ts`. Everything
else is plain Node, so it is directly unit-testable without the VS Code host. Preserve
this when adding modules.

Notably, `src/core/` is not uniformly impure: `config.ts` reads settings through
`vscode.workspace.getConfiguration` and `sessionManager.ts` owns every side effect.
The pure subset is only `stateMachine.ts`, `spans.ts`, `projects.ts`, `types.ts`.

## Entry points, in the order a request reaches them

1. `src/extension.ts` → `activate()` — builds stores, `SessionManager`, panel, status
   bar; registers every `lalog.*` command; runs startup sweeps.
2. `SessionManager` (`core/sessionManager.ts`) — the sole orchestrator. Every session
   mutation funnels through it; nothing else may start, close, or mutate a session.
3. `SessionStore` / `TechnicalStore` / `ProjectRegistry` (`storage/`) — all persistence.
4. `reporting/*` — pure functions over already-loaded sessions, invoked at render time.
5. `ui/panelView.ts` + `ui/statusBar.ts` — presentation, reached only through
   callbacks wired in `extension.ts`.

The two largest files are `src/ui/panelView.ts` (~1040 lines) and
`src/core/sessionManager.ts` (~830 lines); both are broad but not layered internally.

## Boundaries worth defending

- **`storage/` never imports `reporting/`, `sessionManager`, or `vscode`.** It reads and
  writes files and returns plain objects.
- **Derivation is never cached.** Reporting computes everything from the append-only
  `sessions.jsonl` at render time; there is no aggregate store to invalidate.
- **`SessionManager` is the only composition root.** If two subsystems need to
  coordinate, wire them in `extension.ts` via `setOnStateChanged` / `setAiDraft` /
  `setAiInteractionLogger`, not by importing each other.
- **AI is optional at the type level.** `SessionManager` receives AI hooks as
  assignable function fields, so when `lalog.ai.enabled` is false no `opencode` object
  is ever constructed.

## Build shape

`esbuild.js` bundles `src/extension.ts` → `dist/extension.js` (cjs, node18, `vscode`
external). `esbuild.test.js` bundles `test/**/*.test.ts` → `dist-test/` with a plugin
that resolves the bare `vscode` specifier to `test/helpers/mockVscode.ts`.
`npm test` runs both via `node --test`. Details in
[`docs/development.md`](../../docs/development.md).