# Changelog

All notable changes to LaLog are recorded in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Versions are
listed newest first.

Installed as `Lawaty.lalog` on the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=Lawaty.lalog)
and as `lawaty.lalog` on [Open VSX](https://open-vsx.org/extension/lawaty/lalog).

For what each feature *does*, see [`docs/features.md`](docs/features.md). For the reasoning
behind a design choice, see [`docs/decisions.md`](docs/decisions.md).

## [Unreleased]

## [0.7.6] - 2026-10-10

### Added

- **`CHANGELOG.md`** — release history for every published version, reconstructed from commit
  history and the published `.vsix` artifacts. It ships inside the `.vsix`, so the extension
  page on the Marketplace and on Open VSX now lists what changed in each release.

### Changed

- **`LICENSE`** keeps the MIT grant verbatim and adds a short, plain-language *Attribution*
  section asking that anyone who uses, modifies, or forks LaLog keep a credit line back to
  the project. It is deliberately a courtesy request rather than a new requirement: MIT
  already obliges people to keep the copyright notice, and making attribution mandatory would
  no longer be MIT. No patent or trademark terms were added, and nothing about the copyright
  grant changed.
- `README.md` and `docs/README.md` link to the changelog and mention the attribution request;
  `docs/README.md` also had a stale version claim corrected (it still read `v0.6.0` from
  several releases ago).

## [0.7.5] - 2026-10-09

### Changed

- Prompt thresholds are now intervals counted **from your last answer**, not cumulative
  session totals, so a prompt never re-asks a question you just answered
  ([ADR-035](docs/decisions.md)).
- `lalog.describeAfterMinutes` and `lalog.wrapAfterMinutes` descriptions updated to match.

### Internal

- Releases are local-first: `npm run release` gates on typecheck + test, then publishes to
  each registry independently, **skipping and reporting** any registry with no credentials
  rather than prompting for them.
- `npm run release:dry` is a pre-flight that prints the resolved auth and the exact command
  per registry without building or publishing.
- Marketplace authentication accepts a PAT **or** Microsoft Entra ID
  (`--azure-credential`). The PAT remains the documented preferred path — `AzureCliCredential`
  needs a default account, which a personal Microsoft account without a subscription does
  not get from a plain `az login`.

## [0.7.4] - 2026-10-08

### Added

- Published to the **VS Code Marketplace**. The extension id is `Lawaty.lalog` (capital
  `L`); Open VSX keeps the lowercase `lawaty.lalog`.

### Internal

- Release documentation describes `v*`-tag-triggered publishing.

## [0.7.3] - 2026-10-08

### Changed

- **opencode chat activity is now on by default.** It was opt-in in 0.7.2. Set
  `lalog.opencode.activity.enabled` to `false` for a fully local, zero-request install
  ([ADR-034](docs/decisions.md)).

### Added

- **Open VSX publishing path**, so the extension is available in VSCodium, Cursor, Windsurf,
  and other Open VSX-based editors.

## [0.7.2] - 2026-10-03

### Added

- An open **opencode chat** in the workspace counts as activity
  ([ADR-032](docs/decisions.md)). Only chat metadata is read — never message content.
- **Reuse-first `opencode serve` lifecycle**: LaLog reuses a serve you already run, and only
  spawns (and later stops) its own on loopback when `lalog.opencode.activity.manageServe` is
  on. Only a serve LaLog itself started is ever stopped
  ([ADR-033](docs/decisions.md)).
- New settings `lalog.opencode.activity.*`: `enabled`, `manageServe`, `url`,
  `pollIntervalSec`, `discoverySec`, `spawnPort`, `opencodePath`, `authUser`,
  `authPassword`.

### Fixed

- Bounded in-extension-host memory during capture: cached per-path diff text is capped, and
  an oversized path is no longer cached just because it exceeded the stored-diff cap.

## [0.7.1] - 2026-10-01

### Added

- **Adjust a session's tracked time** — `lalog.adjustTrackedTime`, also reachable from the
  Now box. Trimming is reduction-only and removes the outside window first, so a wrong
  "I'm still working" confirmation can be rolled back
  ([ADR-031](docs/decisions.md)).

## [0.7.0] - 2026-10-01

### Added

- Projects are **per workspace** and named from the VS Code workspace; a one-time split
  migrates the previously collapsed project registry, and each workspace's history stays in
  its own project ([ADR-030](docs/decisions.md)).
- Project records carry a `nameSource` flag, so a name LaLog chose can be told apart from one
  you set.
- A distinct palette color per project, a window-scoped palette rename, and an **Unassigned**
  chip for a workspace with no folder.

### Internal

- `.opencode/` is excluded from the packaged extension.

## [0.6.0] - 2026-09-29

### Added

- **Session detail as a document**: clicking a session opens it as an untitled markdown
  document instead of expanding an inline block, so the list stays cheap to scan
  ([ADR-025](docs/decisions.md)).
- `lalog.dayDiffs` — every file change for one local day in a single document.
- `lalog.renameProject`.
- **One local day key everywhere**, so day grouping is correct on calendar days rather than
  UTC days ([ADR-027](docs/decisions.md)).
- The hour timeline carries session identity ([ADR-028](docs/decisions.md)).
- **Diffs-only retention** — `lalog.diffRetentionDays` (default `14`, `0` = forever). Terminal
  and AI metadata are kept regardless ([ADR-026](docs/decisions.md)).
- Settings `lalog.staleSessionAfterMinutes` (`60`), `lalog.diffRetentionDays` (`14`), and
  `lalog.multiProject` (`false`).

### Removed

- `lalog.resumeWindowMinutes`.

## [0.5.0] - 2026-09-28

### Added

- **Delete a session** — `lalog.deleteSession`, behind a modal confirmation and with no undo
  path ([ADR-023](docs/decisions.md)).
- **PDF export** — `lalog.exportPdf`, with per-detail toggles and personal/client presets,
  written by a hand-rolled PDF 1.4 writer so no second runtime dependency is added
  ([ADR-024](docs/decisions.md)).

### Internal

- The test suite was reorganized into user-story files under `test/userStories/`.

## [0.4.0] - 2026-09-21

### Added

- **Hard 1h stale-session cutoff** — `lalog.staleSessionAfterMinutes` (default `60`). A
  session idle that long is force-closed and a new one starts automatically; there is
  deliberately no continuation path ([ADR-022](docs/decisions.md)).
- Idle **"I was away"** trimming removes the gap before tracked time accrues.

### Removed

- The **describe-before-exit** (focus-loss) prompt ([ADR-020](docs/decisions.md)) and the
  **on-start description** prompt ([ADR-021](docs/decisions.md)). Both asked more often than
  they earned their place. Description now happens once, text-first, mid-session
  ([ADR-019](docs/decisions.md)).

## [0.3.1] - 2026-09-07

### Added

- **Technical detail capture** — a per-session sidecar recording what happened during the
  session, separate from the session record itself
  ([ADR-018](docs/decisions.md)).
- A describe-before-exit (focus-loss) prompt ([ADR-016](docs/decisions.md)) — later removed in
  0.4.0.
- Preloader / startup performance work.

### Internal

- Packaging fixes.

## [0.3.0] - 2026-09-07

### Added

- Capture becomes **independently switchable**, with each new setting:
  `lalog.captureDiffs` (`true`), `lalog.captureTerminal` (`true`),
  `lalog.captureTerminalStdout` (`false`), `lalog.captureAiLog` (`true`), plus the caps
  `lalog.maxDiffChars` (`16000`) and `lalog.maxStdoutChars` (`32000`).

## [0.2.3] - 2026-09-07

### Internal

- Bundle-only change. No command, setting, view, or activation event changed; the specific
  change is not recoverable from the published package.

## [0.2.2] - 2026-09-07

### Internal

- Bundle-only change. No command, setting, view, or activation event changed; the specific
  change is not recoverable from the published package.

## [0.2.1] - 2026-09-07

### Internal

- Repack of 0.2.0. The published bundle is **byte-identical** to 0.2.0; only the version
  number differs.

## [0.2.0] - 2026-09-04

First published release.

### Added

- Passive session tracking with prompts at natural breakpoints, storing everything locally
  under `~/.lalog/`.
- Commands: `lalog.startSession`, `lalog.endSession`, `lalog.endSessionRestart`,
  `lalog.pauseSession`, `lalog.resumeSession`, `lalog.describeNow`, `lalog.report`,
  `lalog.background`, `lalog.exportCsv`, `lalog.analysis`, `lalog.showSessions`,
  `lalog.editSession`, `lalog.exportFilesByDay`.
- Optional AI assistance, **off by default** ([ADR-011](docs/decisions.md)).

### Fixed

- Tracked durations were inflated 60,000× by a minutes/milliseconds mismatch.

## Notes on this changelog

Entries were reconstructed from evidence, not memory:

- **0.2.0 and 0.3.1 – 0.7.5** come from commit history. The repository has 19 commits on a
  single branch and exactly **one tag, `v0.7.4`**, so most versions have no tag to point at.
- **0.2.1 – 0.3.0** predate versioned commit history and were reconstructed from the
  published `.vsix` artifacts by diffing each package's manifest and bundle. Where an artifact
  shows a changed bundle against an unchanged manifest, the entry says exactly that rather
  than guessing at the change.
- Published artifacts were built from the working tree, so a package can contain work that was
  committed under a later version. Git was treated as authoritative for *when* a change
  shipped.
- A `v0.1.0` is referenced in older documentation, but it has neither a release artifact nor a
  versioned commit, so it is not listed above.