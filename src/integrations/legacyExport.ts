import * as fs from 'fs';
import * as path from 'path';
import { Session } from '../core/types';
import { LaLogPaths } from '../storage/store';

/**
 * Maintains `<projectSlug>/files_by_day.txt` in the exact format that the user's
 * `group_file_histories.sh` script produces:
 *
 *   2026-09-03:
 *     - backend/foo.py
 *
 * Files are listed under each calendar day on which they had edit events
 * (derived from event timestamps, not session summaries) so existing
 * downstream consumers keep working across midnight-spanning sessions.
 */
export async function exportFilesByDay(
  paths: LaLogPaths,
  sessions: Session[]
): Promise<string[]> {
  // file -> Set<day>
  const fileDays = new Map<string, Set<string>>();
  const fileEdits = new Map<string, number>();

  for (const s of sessions) {
    for (const f of s.events.topFiles) {
      const day = new Date(f.firstTouch).toISOString().slice(0, 10);
      const set = fileDays.get(f.path) ?? new Set<string>();
      set.add(day);
      // Midnight-spanning: add the lastTouch day too if edits happened there.
      const lastDay = new Date(f.lastTouch).toISOString().slice(0, 10);
      if (lastDay !== day) set.add(lastDay);
      fileDays.set(f.path, set);
      fileEdits.set(f.path, (fileEdits.get(f.path) ?? 0) + f.edits);
    }
  }

  // Group by project slug.
  const byProject = new Map<string, Map<string, Set<string>>>();
  for (const [file, days] of fileDays) {
    const slug = projectSlugFor(paths, file);
    const proj = byProject.get(slug) ?? new Map<string, Set<string>>();
    for (const day of days) {
      const set = proj.get(day) ?? new Set<string>();
      set.add(file);
      proj.set(day, set);
    }
    byProject.set(slug, proj);
  }

  const written: string[] = [];
  for (const [slug, byDay] of byProject) {
    const outFile = path.join(paths.exportsDir, slug, 'files_by_day.txt');
    const lines: string[] = [];
    const days = [...byDay.keys()].sort();
    for (const day of days) {
      lines.push(`${day}:`);
      const files = [...byDay.get(day)!].sort();
      for (const f of files) {
        lines.push(`  - ${relativePath(paths, f)}`);
      }
    }
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, lines.join('\n') + '\n');
    written.push(outFile);
  }
  return written;
}

function projectSlugFor(paths: LaLogPaths, file: string): string {
  // Best-effort: top-level dir of workspace path; fall back to a hash.
  const parts = file.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.length >= 2 ? sanitize(parts[parts.length - 2]) : `ws-${file.length}`;
}

function relativePath(paths: LaLogPaths, file: string): string {
  return file.replace(/\\/g, '/');
}

function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]/g, '_');
}
