# Development

[Home](README.md) > **development**

> How to build, test, package, and run the LaLog extension.

---

## Table of Contents

- [Prerequisites](#prerequisites)
- [Project Structure](#project-structure)
- [Build](#build)
- [Watch Mode](#watch-mode)
- [Type Checking](#type-checking)
- [Testing](#testing)
- [Running the Extension](#running-the-extension)
- [Debug Time Scale](#debug-time-scale)
- [Packaging](#packaging)
- [Contribution Flow](#contribution-flow)

---

## Prerequisites

- **Node.js** ≥ 18 (target: `node18` in esbuild config)
- **VS Code** ≥ 1.93.0 (for shell integration API)
- **npm** (comes with Node.js)

Install dependencies:

```bash
cd /home/lawaty/Projects/worklog
npm install
```

---
---

## Project Structure

```
lalog/
├── src/
│   ├── extension.ts           # Entry point: activate() / deactivate()
│   ├── core/
│   │   ├── stateMachine.ts    # Pure state transitions
│   │   ├── sessionManager.ts  # Orchestrator
│   │   ├── activityTracker.ts # VS Code event listener
│   │   ├── breakpoints.ts     # Natural breakpoint detector
│   │   ├── config.ts          # Settings + thresholds
│   │   ├── projects.ts        # Project resolution
│   │   ├── spans.ts           # Active-span builder (updateActiveSpan)
│   │   └── types.ts           # Shared types
│   ├── capture/
│   │   ├── diffCapture.ts     # Per-file diff capture (save events)
│   │   ├── terminalCapture.ts # Terminal command capture
│   │   ├── aiLog.ts           # AI interaction capture
│   │   └── redactText.ts      # Redaction rules
│   ├── prompts/
│   │   ├── promptCoordinator.ts # Mutex + spacing
│   │   └── describeFlow.ts    # Text-first describe UI
│   ├── storage/
│   │   ├── store.ts           # Filesystem primitives + paths
│   │   ├── sessionStore.ts    # Session CRUD (append-only log)
│   │   ├── projectRegistry.ts # projects.json + claims
│   │   └── technicalStore.ts  # Per-session technical sidecar JSONL
│   ├── reporting/
│   │   ├── ranges.ts          # Local calendar-day math (incl. dayKey)
│   │   ├── aggregate.ts       # todayActiveMs, todayUntrackedMs
│   │   ├── insights.ts        # Pure period aggregations + timeline
│   │   ├── report.ts          # Markdown report generation
│   │   ├── sessionDetail.ts   # Session/daily detail documents
│   │   ├── pdf.ts             # Dependency-free PDF writer
│   │   └── pdfReport.ts       # PDF model + presets
│   ├── integrations/
│   │   ├── git.ts             # Branch + commit annotation
│   │   └── legacyExport.ts    # files_by_day.txt export
│   ├── opencode/              # AI analysis bridge
│   └── ui/
│       ├── statusBar.ts       # Status bar item
│       └── panelView.ts       # Webview panel (Sessions/Insights/Projects)
├── test/
│   ├── helpers/
│   │   ├── harness.ts         # Shared test harness
│   │   └── mockVscode.ts      # vscode module mock
│   └── userStories/           # Tests keyed to docs/user-stories.md
├── dist/                      # Build output (gitignored)
│   ├── extension.js
│   └── extension.js.map
├── package.json
├── tsconfig.json
├── esbuild.js                 # Build script
├── esbuild.test.js            # Test build script
└── .vscodeignore
```

---

## Build

Build the extension to `dist/extension.js`:

```bash
npm run build
```

This runs `node esbuild.js`, which:
- Bundles `src/extension.ts` → `dist/extension.js`
- Externalizes `vscode` (provided by VS Code runtime)
- Target: `node18`, format: `cjs`, platform: `node`
- Generates source map: `dist/extension.js.map`

---

## Watch Mode

Auto-rebuild on file changes:

```bash
npm run watch
```

This runs `node esbuild.js --watch`, which uses esbuild's context API to watch for changes and rebuild incrementally.

---

## Type Checking

Run TypeScript type checking without emitting files:

```bash
npm run typecheck
```

This runs `tsc --noEmit` using `tsconfig.json`:
- `strict: true`
- `target: ES2022`
- `module: commonjs`
- `rootDir: src`

---

## Testing

Run the test suite:

```bash
npm test
```

This:
1. Runs `node esbuild.test.js` — bundles every `test/*.test.ts` → `dist-test/*.test.js`
2. Runs `node --test "dist-test/*.test.js"` — executes tests using Node's built-in test runner

**Test files** (`test/`): `stateMachine`, `spans`, `trim`, `sessionStore`, `projects`, `insights`, `diffCapture`, `terminalCapture`, `aiLog`, `redactText`, `technicalStore`, `opencode`.

Tests cover (stateMachine highlights):
- Overnight session spanning midnight (not day-bound)
- Idle gap ends active accrual but keeps session bound
- Describe prompt triggers after 90 active minutes
- Wrap trigger after 210 active minutes
- Auto-close uses `lastActivityAt` not detection time

**Running tests manually**:

```bash
# Build test bundle
node esbuild.test.js

# Run tests
node --test dist-test/stateMachine.test.js

# Run specific test
node --test --test-name-pattern="overnight" dist-test/stateMachine.test.js
```

---

## Running the Extension

### Development Host (F5)

1. Open the `worklog` folder in VS Code
2. Press `F5` (or Run → Start Debugging)
3. A new VS Code window opens (the "Extension Development Host")
4. Open a workspace in the dev host
5. LaLog activates and starts tracking

**Changes are live** — if you're running `npm run watch` in the terminal, changes are rebuilt automatically. Reload the dev host window (Ctrl+Shift+P → "Developer: Reload Window") to pick up changes.

### Installed Extension

Package and install:

```bash
npm run package   # Creates lalog-0.1.0.vsix
code --install-extension lalog-0.1.0.vsix
```

---

## Debug Time Scale

Test the full session lifecycle in minutes instead of hours:

1. Open VS Code settings (Ctrl+,)
2. Search for `lalog.debugTimeScale`
3. Set it to `60` (or any factor)

**Effect**: All time thresholds are divided by the scale factor.

| Setting | Normal (scale=1) | Scaled (scale=60) |
|---------|------------------|-------------------|
| Describe after | 90 min | 90 sec |
| Wrap after | 210 min (3.5h) | 210 sec (3.5 min) |
| Grace period | 30 min | 30 sec |
| Stale cutoff | 60 min (1h) | 60 sec (1 min) |
| Auto-close idle | 120 min (2h, capped at stale cutoff) | 60 sec (1 min, capped) |
| Idle gap | 15 min | 15 sec |

**Example workflow** (scale=60):
1. Start a session
2. Work for 90 seconds → describe prompt appears
3. Describe the session
4. Work for another 120 seconds → wrap prompt appears
5. Choose "Extend 30 sec" or "Wrap & start new"
6. Stop working for 1 minute → session force-closes and a fresh one starts

**Important**: Reset `debugTimeScale` to `1` for normal use.

---

## Packaging

Create a `.vsix` package for distribution:

```bash
npm run package
```

This runs `vsce package`, which:
- Reads `package.json` for metadata
- Bundles the extension (runs `npm run build` first via `vscode:prepublish`)
- Creates `lalog-0.1.0.vsix`

**Install the .vsix** (local development only — see the warning below):

```bash
code --install-extension lalog-0.1.0.vsix
```

---

## Publishing / Releasing

LaLog publishes to **two independent registries**, because they serve different editors
and neither can substitute for the other:

| Registry | CLI | Editor support |
|---|---|---|
| **VS Code Marketplace** (Microsoft) | `vsce` | Stock VS Code, VSCodium, Cursor |
| **Open VSX** (Eclipse Foundation) | `ovsx` | VSCodium, Cursor, Windsurf, Trae, Void, Positron, Theia, Che, Gitpod |

Stock Microsoft VS Code queries **only** the Microsoft Marketplace — the gallery URL is
hard-coded in `resources/app/product.json`. An Open VSX install is invisible to it, which
is why a marketplace publish of the Microsoft flavour is required for stock-VS-Code
auto-update to ever work.

### One-time account setup

**Microsoft Marketplace** (only needed for `vsce`):
1. Sign in at <https://marketplace.visualstudio.com> and create a publisher whose id
   matches `publisher` in `package.json` (currently `Lawaty`). The id must match exactly,
   and it is immutable — the first publish fixes the extension ID forever.
2. Authenticate — pick either:
   - **Azure DevOps PAT.** Generate one with **All accessible organizations** and the
     **Manage Extensions** scope. Set `VSCE_PAT` (as a repository secret for CI, or
     exported locally). Note a PAT can only be created once the Azure DevOps org's
     email is verified.
   - **Microsoft Entra ID.** No secret to create or rotate. `vsce --azure-credential`
     resolves a token through `@azure/identity`'s chain — `EnvironmentCredential`,
     `AzureCliCredential`, `ManagedIdentityCredential`, `AzurePowerShellCredential`,
     `AzureDeveloperCliCredential` — so any of those works. On a workstation that
     normally means installing the Azure CLI and running `az login` with the same
     Microsoft account that owns the publisher. Set `VSCE_AZURE_CREDENTIAL=1`.
   `VSCE_PAT` wins if both are set.

**Open VSX** (only needed for `ovsx`): store an Open VSX personal access token as the
`OVSX_PAT` repository secret (or export it locally).

### Release — local path (works with no CI)

This is the primary path. It needs no GitHub Actions runner, so it is unaffected by
account-level Actions locks:

```bash
npm version <patch|minor|major>      # bumps package.json + package-lock.json
npm run typecheck && npm test         # gate: don't publish a red build
git commit -am "..." && git push origin main --follow-tags
npm run release                       # or: VSCE_PAT=... OVSX_PAT=... npm run release
```

`npm run release` gates on typecheck + tests, then publishes each registry
independently, **skipping** any whose credentials are absent and reporting it in the
summary — so a missing `VSCE_PAT` degrades to "Open VSX only" instead of failing the
release. A non-zero exit means a publish that was actually attempted failed.

To see what would be published, and with which auth, before committing to it:

```bash
npm run release:dry
```

Version numbers are per-registry: 0.7.4 can be on Open VSX while absent from Microsoft
Marketplace without conflict.

Two things to know when verifying a publish:

- **A version must be new to each registry.** Re-running `publish:ovsx` for a version
  that already exists fails with *version already exists*.
- **Open VSX indexing lags the publish.** `/api/<ns>/<name>/versions` is served from the
  search index and can trail by minutes, making a successful publish look like a failure.
  Check `/api/<ns>/<name>/<version>` instead — it reads the entity directly.

### Release — CI path

Both workflows fire on a `v*` tag push, so a tag is the single release action:

```bash
npm version <patch|minor|major>
git commit -am "..."
git tag -a "v<version>" -m "<version>"
git push origin main --follow-tags   # the tag triggers both publish workflows
```

> **This step is not optional for CI.** Both `publish-vscm.yml` and `publish-ovsx.yml`
> trigger on tag pushes only, so a commit on `main` without a matching tag publishes
> nothing. Without CI, `npm version` + a local publish is the equivalent.

To publish via CI without cutting a new tag, run either workflow from the Actions tab
(**Run workflow**) — both accept `workflow_dispatch`.

#### If Actions fails with "account is locked due to a billing issue"

GitHub refuses to schedule *any* runner, with jobs failing in seconds and zero steps
executed. This is an **account-level** lock, not an Actions quota or cost problem — the
standard runner is free for public repositories, so a public repo's workflows cost
nothing and are still blocked. It is typically triggered by a failed subscription charge
(no money taken, so there may be no visible invoice).

Use the local path above. To clear the lock you would need a working payment method to
retry the charge, or — with no card available — cancelling the subscription and asking
GitHub Support to void the never-succeeded charge. Neither is required to ship.

### Local `.vsix` installs do not auto-update

A `.vsix` installed from a local file carries no registry provenance, so VS Code will
never update it, never surface an update notification for it, and it will never appear
in the Extensions view as updatable. This is expected behavior, not a bug. For end users
always install by extension ID (`code --install-extension Lawaty.lalog`).

---

## Contribution Flow

### Deciding What to Work On

1. **Check the roadmap** — see [roadmap.md](roadmap.md) for what's NOT built
2. **Check existing issues** — if this were a public repo, check the issue tracker
3. **Pick a small, well-defined task** — e.g., "add a new session type", "improve report formatting"

### Making Changes

1. **Create a branch** (if using git):
   ```bash
   git checkout -b feature/my-feature
   ```

2. **Make changes** in `src/`

3. **Run type checking**:
   ```bash
   npm run typecheck
   ```

4. **Run tests**:
   ```bash
   npm test
   ```

5. **Test manually** in the dev host (F5):
   - Run `npm run watch` in a terminal
   - Press F5 to launch the dev host
   - Test your changes

6. **Commit**:
   ```bash
   git add .
   git commit -m "Add my feature"
   ```

### Code Style

- **TypeScript strict mode** — no implicit `any`, no unused variables
- **Functional core, imperative shell** — state machine is pure, session manager orchestrates side effects
- **No external dependencies** — only `vscode` (provided by runtime) and Node.js built-ins
- **Local-only** — no network calls, no telemetry

### Testing Guidelines

- **Unit tests** for pure logic (state machine, config, aggregation)
- **Integration tests** for storage (JSONL read/write, snapshot recovery)
- **Manual tests** for UI (prompts, status bar, webview panel)

The current test suite (`test/userStories/*.test.ts`) uses Node's built-in test runner (`node:test`). Tests are synchronous and fast.

### Documentation

If you add a feature, update the relevant doc page:
- **New feature** → [features.md](features.md)
- **Architecture change** → [architecture.md](architecture.md) + [decisions.md](decisions.md)
- **Data format change** → [data-format.md](data-format.md)
- **New setting** → [features.md → Configuration](features.md#configuration)

---

## npm Scripts Summary

| Script | Command | Description |
|--------|---------|-------------|
| `build` | `node esbuild.js` | Bundle to `dist/extension.js` |
| `watch` | `node esbuild.js --watch` | Auto-rebuild on changes |
| `typecheck` | `tsc --noEmit` | Type check without emitting |
| `test` | `node esbuild.test.js && node --test dist-test/stateMachine.test.js` | Build and run tests |
| `package` | `vsce package` | Create `.vsix` package |
| `vscode:prepublish` | `npm run build` | Run before packaging (automatic) |

---

## Related Pages

- [Architecture](architecture.md) — module overview and data flow
- [Features](features.md) — detailed feature documentation
- [Data Format](data-format.md) — JSONL schema and snapshot format
- [Roadmap](roadmap.md) — what's NOT built