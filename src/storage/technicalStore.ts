/**
 * Per-session technical detail sidecar storage.
 *
 * Each session's technical entries (diffs, terminal executions, AI interactions)
 * are stored in a separate JSONL file under ~/.lalog/technical/<sessionId>.jsonl.
 * This keeps the main session store compact while preserving full technical detail.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { TechnicalEntry } from '../core/types';

const MAX_FILE_BYTES = 2 * 1024 * 1024; // 2 MB
const MAX_ENTRIES = 5000;

/**
 * Sidecar filename shape (see `store.ts` `sessionId`). Used ONLY to identify a
 * sidecar file — the timestamp prefix is never parsed.
 */
const SIDECAR_RE = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})-[0-9a-f]{4}-[0-9a-f]{4}\.jsonl$/;

export class TechnicalStore {
  constructor(
    private technicalDir: string,
    private maxFileBytes: number = MAX_FILE_BYTES,
    private maxEntries: number = MAX_ENTRIES
  ) {}

  /** Absolute path for a session's sidecar file. */
  pathFor(sessionId: string): string {
    return path.join(this.technicalDir, `${sessionId}.jsonl`);
  }

  /** Append a technical entry to the session's sidecar. Best-effort. */
  append(entry: TechnicalEntry, sessionId: string): void {
    try {
      const file = this.pathFor(sessionId);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const fd = fs.openSync(file, 'a');
      try {
        fs.writeSync(fd, JSON.stringify(entry) + '\n');
      } finally {
        fs.closeSync(fd);
      }
      this.rotateIfNeeded(file);
    } catch (e) {
      console.error('[lalog] technical store append failed:', e);
    }
  }

  /** Read all entries for a session. Skips malformed lines. */
  read(sessionId: string): TechnicalEntry[] {
    const file = this.pathFor(sessionId);
    try {
      if (!fs.existsSync(file)) return [];
      const raw = fs.readFileSync(file, 'utf8');
      const entries: TechnicalEntry[] = [];
      for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          entries.push(JSON.parse(trimmed) as TechnicalEntry);
        } catch {
          /* skip malformed */
        }
      }
      return entries;
    } catch {
      return [];
    }
  }

  /** Delete a session's sidecar file. */
  delete(sessionId: string): void {
    try {
      const file = this.pathFor(sessionId);
      if (fs.existsSync(file)) fs.unlinkSync(file);
    } catch {
      /* ignore */
    }
  }

  /**
   * Diffs-only retention: remove `type:'diff'` entries with `ts < cutoffTs`
   * from every sidecar. Terminal and AI entries kept forever. Per file:
   * read → filter → write `<file>.tmp` → rename (atomic, same pattern as
   * saveSnapshot, store.ts:86-91). A re-stat guard skips a file that changed
   * mid-sweep. A sidecar left with zero entries is deleted. Files not
   * matching SIDECAR_RE are never touched. Best-effort.
   * Returns the number of diff entries removed.
   */
  pruneDiffEntriesBefore(cutoffTs: number): number {
    let removed = 0;
    try {
      if (!fs.existsSync(this.technicalDir)) return 0;
      for (const name of fs.readdirSync(this.technicalDir)) {
        if (name.endsWith('.tmp')) {
          try {
            fs.unlinkSync(path.join(this.technicalDir, name));
          } catch {
            /* best-effort */
          }
        }
      }
      for (const name of fs.readdirSync(this.technicalDir)) {
        if (!SIDECAR_RE.test(name)) continue;
        const file = path.join(this.technicalDir, name);
        try {
          const before = fs.statSync(file);
          const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());
          let dropped = false;
          const kept: string[] = [];
          for (const line of lines) {
            let isOldDiff = false;
            try {
              const e = JSON.parse(line) as TechnicalEntry;
              isOldDiff = e.type === 'diff' && typeof e.ts === 'number' && e.ts < cutoffTs;
            } catch {
              /* keep malformed lines verbatim */
            }
            if (isOldDiff) {
              dropped = true;
              removed += 1;
              continue;
            }
            kept.push(line);
          }
          if (!dropped) continue;
          const after = fs.statSync(file);
          if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) continue; // concurrent append — skip
          if (kept.length === 0) {
            fs.unlinkSync(file);
            continue;
          }
          const tmp = file + '.tmp';
          fs.writeFileSync(tmp, kept.join('\n') + '\n');
          fs.renameSync(tmp, file);
        } catch {
          /* best-effort per file */
        }
      }
    } catch {
      /* best-effort */
    }
    return removed;
  }

  /** If the file exceeds maxFileBytes, keep only the last maxEntries lines. */
  private rotateIfNeeded(file: string): void {
    try {
      const stat = fs.statSync(file);
      if (stat.size <= this.maxFileBytes) return;
      const raw = fs.readFileSync(file, 'utf8');
      const lines = raw.split('\n').filter((l) => l.trim());
      if (lines.length <= this.maxEntries) return;
      const kept = lines.slice(-this.maxEntries);
      fs.writeFileSync(file, kept.join('\n') + '\n');
    } catch {
      /* best-effort */
    }
  }
}