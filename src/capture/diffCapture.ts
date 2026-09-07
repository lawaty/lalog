/**
 * Unified diff capture at file save time.
 *
 * Produces TechnicalDiff entries from successive saves. First save for a path
 * emits a new-file diff; subsequent saves produce a standard unified patch.
 * Binary files (null byte in first 8KB) are skipped.
 */

import { createTwoFilesPatch } from 'diff';
import type { TechnicalDiff } from '../core/types';
import { redactText } from './redactText';

const MAX_TRACKED_PATHS = 100;

export class DiffCapture {
  private lastContent: Map<string, string> = new Map();

  constructor(
    private maxDiffChars: number,
    private redactPatterns: RegExp[]
  ) {}

  /** Process a file save. Returns a TechnicalDiff or null if skipped. */
  onSave(filePath: string, currentText: string): TechnicalDiff | null {
    // Binary guard: null byte in first 8KB
    const sample = currentText.slice(0, 8192);
    if (sample.indexOf('\0') !== -1) return null;

    const before = this.lastContent.get(filePath);
    const isNew = before === undefined;

    let patch: string;
    if (isNew) {
      // First save: emit a new-file diff (all lines added)
      patch = createTwoFilesPatch('/dev/null', filePath, '', currentText);
    } else {
      patch = createTwoFilesPatch(filePath, filePath, before, currentText);
      // If content is identical, skip
      if (patch.split('\n').length <= 5) return null;
    }

    // Redact
    patch = redactText(patch, this.redactPatterns);

    // Parse added/removed line counts from hunk lines
    const lines = patch.split('\n');
    let linesAdded = 0;
    let linesRemoved = 0;
    for (const line of lines) {
      if (line.startsWith('+') && !line.startsWith('+++')) linesAdded++;
      else if (line.startsWith('-') && !line.startsWith('---')) linesRemoved++;
    }

    // Cap size
    let truncated = false;
    if (patch.length > this.maxDiffChars) {
      patch = patch.slice(0, this.maxDiffChars) + '\n...[truncated]';
      truncated = true;
    }

    // Update stored content
    this.lastContent.set(filePath, currentText);
    this.evictIfNeeded();

    return {
      type: 'diff',
      ts: Date.now(),
      path: filePath,
      diff: patch,
      linesAdded,
      linesRemoved,
      newFile: isNew,
    };
  }

  /** Clear all tracked file content (called on session end). */
  reset(): void {
    this.lastContent.clear();
  }

  /** Keep the map at most MAX_TRACKED_PATHS entries (LRU-ish: drop oldest). */
  private evictIfNeeded(): void {
    if (this.lastContent.size <= MAX_TRACKED_PATHS) return;
    const iter = this.lastContent.keys();
    const first = iter.next();
    if (!first.done) {
      this.lastContent.delete(first.value);
    }
  }
}
