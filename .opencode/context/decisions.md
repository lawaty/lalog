# Decisions not in the ADR log

The project's own decision record is [`docs/decisions.md`](../../docs/decisions.md)
(ADR-001 … ADR-030). Read it for *behavioral* rationale — why sessions aren't
day-bound, why prompts never fire on close, why retention is diffs-only, and so on.
This file records only architectural and tooling decisions that were **not** written
there and would otherwise be re-litigated or assumed wrong.

---

## The `vscode` import boundary is a real constraint

Only nine files import `vscode`: `extension.ts`, `core/{sessionManager,activityTracker,
breakpoints,config}.ts`, `prompts/{promptCoordinator,describeFlow}.ts`,
`ui/{panelView,statusBar}.ts`. Everything else — all of `storage/`, `reporting/`,
`capture/`, `integrations/`, `opencode/`, plus `core/{stateMachine,spans,projects,types}.ts` —
is plain Node.

> Confidence: high — verified by import scan, not inferred from docs.

`docs/development.md` states the intent as "functional core, imperative shell", but no
ADR records the constraint or its blast radius. Consequence: adding a `vscode` call to a
"pure" module silently removes it from the unit-testable set, and the test suite is the
only thing standing in for a VS Code host.

## `diff` is a deliberate runtime dependency

`src/capture/diffCapture.ts` imports `createTwoFilesPatch` from `diff` (the project's
only runtime dependency; `@types/diff` is the matching dev dependency).

No ADR covers this, and `docs/development.md` still claims "No external dependencies —
only `vscode` and Node.js built-ins", which is now stale. Hand-rolling unified diffs was
judged preferable for the PDF writer (ADR-024); the patch generator was not. Treat
"reduce dependencies" as a live constraint and expect pushback before adding a second.

## Tests are bundled, mocked at the module seam

`esbuild.test.js` discovers `test/**/*.test.ts` by filename, bundles each entry point, and
installs a plugin that resolves the bare `vscode` specifier to
`test/helpers/mockVscode.ts`. `npm test` then runs `node --test "dist-test/**/*.test.js"`.

Consequences worth knowing before editing tests:
- a test file outside `test/` matching `*.test.ts` still runs, but nothing outside `test/`
  is bundled — the pattern is the discovery rule, not the directory.
- `tsconfig.json` has `include: ["src"]`, so `npm run typecheck` never checks test code.
  A type error in a test surfaces only when the test bundle builds.
- `test/helpers/mockVscode.ts` is a hand-maintained fake; if production code starts using
  a new `vscode` API surface, the mock must grow or the tests fail for the wrong reason.

## `.opencode/` is excluded from the packaged extension

`.vscodeignore` lists `.opencode/**` (added alongside `src/`, `docs/`, `test/`,
`dist-test/`, `tsconfig.json`, `*.map`). The released `.vsix` ships only `dist/`, `README`,
`LICENSE`, and `resources/`.

Any new top-level directory is shipped or not by omission, so check `.vscodeignore` when
adding one.

## The repo's own docs are the source of truth for behavior

`codemap.md`, `docs/architecture.md`, `docs/features.md`, `docs/data-format.md`, and
`docs/decisions.md` are maintained in-repo and are more precise than this map. Treat
those as authoritative for behavior, and this map only as a navigation layer — when they
disagree with code, the code wins and the doc is what needs fixing.

**Known doc drift found during bootstrap (verify before citing):**
- `docs/README.md` says "v0.6.0"; `package.json` is at `0.7.0`.
- `docs/development.md` lists old test file names (`test/stateMachine.test.ts`, etc.) and
  an `npm test` command that runs only `dist-test/stateMachine.test.js`; the real command
  runs `dist-test/**/*.test.js` and the tests live in `test/userStories/`.
- `docs/development.md` still instructs `cd /home/lawaty/Projects/worklog` — the repo was
  renamed to `lalog`.
- `docs/development.md`'s "no external dependencies" claim (see above).