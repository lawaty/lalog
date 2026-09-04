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
│   │   ├── spans.ts           # Active-span builder (updateActiveSpan)
│   │   └── types.ts           # Shared types
│   ├── prompts/
│   │   ├── promptCoordinator.ts # Mutex + spacing
│   │   └── describeFlow.ts    # 2-step describe UI
│   ├── storage/
│   │   ├── sessionStore.ts    # Session CRUD
│   │   └── store.ts           # Filesystem primitives
│   ├── reporting/
│   │   ├── aggregate.ts       # todayActiveMs, todayUntrackedMs
│   │   └── report.ts          # Markdown report generation
│   ├── integrations/
│   │   ├── git.ts             # Branch + commit annotation
│   │   └── legacyExport.ts    # files_by_day.txt export
│   └── ui/
│       ├── statusBar.ts       # Status bar item
│       └── sessionsView.ts    # Tree view provider
├── test/
│   └── stateMachine.test.ts   # State machine tests
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
1. Runs `node esbuild.test.js` — bundles `test/stateMachine.test.ts` → `dist-test/stateMachine.test.js`
2. Runs `node --test dist-test/stateMachine.test.js` — executes tests using Node's built-in test runner

**Test file**: `test/stateMachine.test.ts`

Tests cover:
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
| Auto-close idle | 120 min (2h) | 120 sec (2 min) |
| Idle gap | 5 min | 5 sec |

**Example workflow** (scale=60):
1. Start a session
2. Work for 90 seconds → describe prompt appears
3. Describe the session
4. Work for another 120 seconds → wrap prompt appears
5. Choose "Extend 30 sec" or "Wrap & start new"
6. Stop working for 2 minutes → session auto-closes

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

**Install the .vsix**:

```bash
code --install-extension lalog-0.1.0.vsix
```

**Publish to VS Code Marketplace** (requires publisher account):

```bash
vsce publish
```

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
- **Manual tests** for UI (prompts, status bar, tree view)

The current test suite (`test/stateMachine.test.ts`) uses Node's built-in test runner (`node:test`). Tests are synchronous and fast.

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