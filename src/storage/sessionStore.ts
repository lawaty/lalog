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
}

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

  /** Record a closed session permanently and remove its active snapshot. */
  async close(s: Session, reason: ClosedReason, endedAt: number): Promise<void> {
    s.closedReason = reason;
    s.endedAt = s.lastActivityAt = endedAt;
    appendLine(this.opts.paths.sessionsFile, s);
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
      events: { edits: 0, saves: 0, terminal: 0, fileops: 0, tasks: 0, debug: 0, topFiles: [] },
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
    s.events = { edits: 0, saves: 0, terminal: 0, fileops: 0, tasks: 0, debug: 0, topFiles: [] };
  }
  if (typeof s.events.fileops !== 'number') s.events.fileops = 0;
  if (typeof s.events.tasks !== 'number') s.events.tasks = 0;
  if (typeof s.events.debug !== 'number') s.events.debug = 0;
  return s;
}
