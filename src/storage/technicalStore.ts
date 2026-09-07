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