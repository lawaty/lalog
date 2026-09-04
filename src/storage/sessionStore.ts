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
    const sessions: Session[] = [];
    await streamLines(this.opts.paths.sessionsFile, (o) => {
      const s = o as Session;
      if (s.id && s.startedAt !== undefined) sessions.push(normalizeSession(s));
    });
    return sessions.sort((a, b) => a.startedAt - b.startedAt);
  }

  /** Rewrite the full sessions file, replacing the targeted session's fields. */
  async updateSession(id: string, patch: Partial<Session>): Promise<void> {
    const all = await this.loadAll();
    const idx = all.findIndex((s) => s.id === id);
    if (idx < 0) return;
    all[idx] = { ...all[idx], ...patch };
    const fs = require('fs') as typeof import('fs');
    fs.writeFileSync(this.opts.paths.sessionsFile, all.map((s) => JSON.stringify(s)).join('\n') + '\n');
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
