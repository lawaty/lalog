import { ThresholdsMs } from '../core/config';
import { Session, TrackedEvent, ClosedReason } from '../core/types';
import {
  LaLogPaths,
  sessionId,
  saveSnapshot,
  readSnapshot,
  streamLines,
  appendLine,
} from './store';

export interface SessionStoreOptions {
  paths: LaLogPaths;
  th: ThresholdsMs;
  /**
   * Test seam only: `pruneShortSessions` calls it after it has read and filtered
   * the file, immediately before the re-stat guard. That guard's window is
   * sub-millisecond inside a fully synchronous method, so a concurrent append
   * can only be simulated from inside the call. Production never sets this.
   */
  onPruneFiltered?: () => void;
}

/**
 * A closed session shorter than this is dropped instead of appended: it would render as
 * "0m" (`fmtDuration`, prompts/promptCoordinator.ts: `Math.round(ms / 60000)`), which is
 * worse than no record at all. This is a *display* boundary in the same clock domain as
 * `activeMinutes`, so it is deliberately NOT routed through `thresholdsMs()` /
 * `debugTimeScale` — scaling it (60 in the test harness) would collapse it to 500ms and
 * make tests drop sessions they are meant to keep. Do not "fix" it into a threshold.
 */
const MIN_SAVED_SESSION_MS = 30000;

/** In-memory event buffer for active sessions, persisted as snapshots. */
export class SessionStore {
  constructor(private opts: SessionStoreOptions) {}

  snapshotPath(wsKey: string): string {
    return `${this.opts.paths.activeDir}/${wsKey}.json`;
  }

  saveActive(s: Session): void {
    saveSnapshot(this.snapshotPath(s.workspaceKey), s);
  }

  loadActive(wsKey: string): Session | null {
    const s = readSnapshot<Session>(this.snapshotPath(wsKey));
    return s ? normalizeSession(s) : null;
  }

  removeActive(wsKey: string): void {
    const fs = require('fs') as typeof import('fs');
    try {
      fs.unlinkSync(this.snapshotPath(wsKey));
    } catch {
      /* ignore */
    }
  }

  /**
   * Record a closed session permanently and remove its active snapshot. A session that
   * would render as "0m" is dropped instead of appended — silently, never prompted about
   * (ADR-017 / ADR-019). The snapshot is removed on BOTH paths: a dropped session whose
   * snapshot survived would be re-loaded by `loadActive` on the next startup, re-enter
   * recovery (`finishRecovered`) and be dropped again forever.
   */
  async close(s: Session, reason: ClosedReason, endedAt: number): Promise<void> {
    s.closedReason = reason;
    s.endedAt = s.lastActivityAt = endedAt;
    if (s.activeMinutes >= MIN_SAVED_SESSION_MS) {
      appendLine(this.opts.paths.sessionsFile, s);
    }
    this.removeActive(s.workspaceKey);
  }

  async loadAll(): Promise<Session[]> {
    const byId = new Map<string, Session>();
    await streamLines(this.opts.paths.sessionsFile, (o) => {
      const s = o as Session;
      if (s.id && s.startedAt !== undefined) {
        // Keep the last occurrence per id: a stale duplicate line (e.g. from an
        // old version or an interrupted close) must never list/count twice.
        byId.set(s.id, normalizeSession(s));
      }
    });
    return [...byId.values()].sort((a, b) => a.startedAt - b.startedAt);
  }

  /** Whether a session with this id is already recorded in the closed log. */
  async hasId(id: string): Promise<boolean> {
    let found = false;
    await streamLines(this.opts.paths.sessionsFile, (o) => {
      if ((o as Session).id === id) found = true;
    });
    return found;
  }

  /**
   * Atomically replace the sessions file (tmp + rename). Rewrites must never
   * leave a truncated sessions.jsonl behind — a crash mid-write would silently
   * drop the user's entire history on the next read.
   */
  private writeSessionsFile(contents: string): void {
    const file = this.opts.paths.sessionsFile;
    const fs = require('fs') as typeof import('fs');
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, contents);
    fs.renameSync(tmp, file);
  }

  /** Rewrite the full sessions file, replacing the targeted session's fields. */
  async updateSession(id: string, patch: Partial<Session>): Promise<void> {
    const all = await this.loadAll();
    const idx = all.findIndex((s) => s.id === id);
    if (idx < 0) return;
    all[idx] = { ...all[idx], ...patch };
    this.writeSessionsFile(all.map((s) => JSON.stringify(s)).join('\n') + '\n');
  }

  /**
   * Remove every line for a session id by rewriting the file. Operates on the
   * RAW lines (not loadAll, which dedupes) so stale duplicate lines for the id
   * are removed too, while malformed lines and other sessions' lines are kept
   * verbatim. Returns true if anything was removed; false means the id was not
   * found and no write happened.
   */
  async deleteSession(id: string): Promise<boolean> {
    const file = this.opts.paths.sessionsFile;
    const fs = require('fs') as typeof import('fs');
    if (!fs.existsSync(file)) return false;
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    const kept: string[] = [];
    let removed = 0;
    for (const line of lines) {
      if (line.trim()) {
        try {
          if ((JSON.parse(line) as Session).id === id) {
            removed += 1;
            continue;
          }
        } catch {
          /* keep malformed lines verbatim */
        }
      }
      kept.push(line);
    }
    if (!removed) return false;
    this.writeSessionsFile(kept.join('\n'));
    return true;
  }

  /**
   * One-time backfill for rows written before `MIN_SAVED_SESSION_MS` existed:
   * drop every line whose `activeMinutes` is under the floor `close` now applies,
   * so a history recorded under the old rule does not keep its "0m" rows (US-8.9).
   *
   * Modelled on `deleteSession`, and for the same reason (ADR-023 decision 2): the
   * filter runs on the RAW lines, never `loadAll()` — which dedupes, normalizes and
   * re-sorts, and would therefore rewrite the user's whole history to prune a few
   * rows. Malformed lines and blank lines are kept verbatim, and BOTH lines of a
   * duplicated sub-floor id are dropped, exactly as `deleteSession` does.
   *
   * Safety, in the order it happens:
   * - a stray `.tmp` from an interrupted write is removed first (same as
   *   `TechnicalStore.pruneDiffEntriesBefore`), so it can never be renamed over
   *   a good file later;
   * - the file is stat'ed before the read and again before the rename; if its
   *   size or mtime changed — another window sharing this `dataDir` closed a
   *   session while we were filtering — the rewrite is skipped and nothing is
   *   lost. `writeSessionsFile` has no such guard and needs none: it runs only
   *   from a user-driven command, this runs unattended on every startup;
   * - `.pre-prune-short.bak` holds the complete original, written once (the
   *   `splitLegacyCollapse` idiom) so re-running never overwrites the true original;
   * - nothing to remove → returns 0 having written nothing at all. That is the
   *   idempotency guard, and why no persistent "has this run" flag is needed: a
   *   crash mid-migration simply re-runs and finds nothing left to do.
   *
   * Returns the number of lines removed.
   */
  pruneShortSessions(): number {
    const file = this.opts.paths.sessionsFile;
    const fs = require('fs') as typeof import('fs');
    if (!fs.existsSync(file)) return 0;
    const tmp = file + '.tmp';
    if (fs.existsSync(tmp)) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* best-effort */
      }
    }
    const before = fs.statSync(file);
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    const kept: string[] = [];
    let removed = 0;
    for (const line of lines) {
      if (line.trim()) {
        try {
          const { activeMinutes } = JSON.parse(line) as Session;
          // A line with no numeric activeMinutes cannot be judged — keep it.
          if (typeof activeMinutes === 'number' && activeMinutes < MIN_SAVED_SESSION_MS) {
            removed += 1;
            continue;
          }
        } catch {
          /* keep malformed lines verbatim */
        }
      }
      kept.push(line);
    }
    this.opts.onPruneFiltered?.();
    if (!removed) return 0;
    const after = fs.statSync(file);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) return 0; // concurrent append — skip
    const bak = file + '.pre-prune-short.bak';
    if (!fs.existsSync(bak)) fs.copyFileSync(file, bak);
    this.writeSessionsFile(kept.join('\n'));
    return removed;
  }

  newSession(wsKey: string, wsName: string, now: number): Session {
    const id = sessionId(now, wsKey);
    return {
      id,
      workspaceKey: wsKey,
      workspaceName: wsName,
      startedAt: now,
      lastActivityAt: now,
      activeMinutes: 0,
      notes: [],
      needsDescription: false,
      events: { edits: 0, saves: 0, terminal: 0, fileops: 0, tasks: 0, debug: 0, opencode: 0, topFiles: [] },
      activeSpans: [],
      activityTs: [],
    };
  }

  recordEvent(s: Session, event: TrackedEvent, filePath: string | undefined, now: number): void {
    if (event === 'edit') {
      s.events.edits += 1;
      if (filePath) this.touchFile(s, filePath, now);
    } else if (event === 'save') {
      s.events.saves += 1;
    } else if (event === 'terminal') {
      s.events.terminal += 1;
    } else if (event === 'fileop') {
      s.events.fileops += 1;
    } else if (event === 'task') {
      s.events.tasks += 1;
    } else if (event === 'debug') {
      s.events.debug += 1;
    } else if (event === 'opencode') {
      s.events.opencode += 1;
    }
    s.lastActivityAt = now;
  }

  private touchFile(s: Session, filePath: string, now: number): void {
    const top = s.events.topFiles;
    const existing = top.find((t) => t.path === filePath);
    if (existing) {
      existing.edits += 1;
      existing.lastTouch = now;
    } else {
      top.push({ path: filePath, edits: 1, firstTouch: now, lastTouch: now });
      if (top.length > 10) {
        top.sort((a, b) => b.edits - a.edits);
        top.length = 10;
      }
    }
  }
}

/** Backfill fields added in later versions so old sessions behave like new ones. */
export function normalizeSession(s: Session): Session {
  if (!Array.isArray(s.activeSpans)) s.activeSpans = [];
  if (!Array.isArray(s.activityTs)) s.activityTs = [];
  if (!Array.isArray(s.notes)) s.notes = [];
  if (!s.events || !Array.isArray(s.events.topFiles)) {
    s.events = { edits: 0, saves: 0, terminal: 0, fileops: 0, tasks: 0, debug: 0, opencode: 0, topFiles: [] };
  }
  if (typeof s.events.fileops !== 'number') s.events.fileops = 0;
  if (typeof s.events.tasks !== 'number') s.events.tasks = 0;
  if (typeof s.events.debug !== 'number') s.events.debug = 0;
  if (typeof s.events.opencode !== 'number') s.events.opencode = 0;
  return s;
}
