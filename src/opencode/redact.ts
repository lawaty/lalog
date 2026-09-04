import { Session } from '../core/types';

/**
 * Redaction + size cap for AI egress.
 *
 * Only the compact `Session` summary is ever sent: file paths, edit/save/terminal
 * counters, git branch, and (optionally) commit subjects. File contents and
 * terminal command text are never captured by LaLog in the first place, so they
 * can never be sent.
 */

const MAX_SUBJECTS = 15;
const MAX_FILES = 10;

/** Build a size-capped, redacted textual snapshot of a session for AI consumption. */
export function sessionSnapshot(s: Session, sendCommitSubjects: boolean): string {
  const parts: string[] = [];
  parts.push(`Workspace: ${s.workspaceName}`);
  parts.push(
    `Active: ${Math.round(s.activeMinutes / 60000)} min (started ${new Date(s.startedAt).toLocaleString()})`
  );
  parts.push(`Edits: ${s.events.edits}, Saves: ${s.events.saves}, Terminal actions: ${s.events.terminal}`);
  if (s.type) parts.push(`Type: ${s.type}`);
  if (s.description) parts.push(`Description: ${s.description}`);
  if (s.gitBranch) parts.push(`Git branch: ${s.gitBranch}`);
  const files = s.events.topFiles.slice(0, MAX_FILES).map((f) => f.path);
  if (files.length) parts.push(`Top files:\n${files.join('\n')}`);
  if (sendCommitSubjects && s.commits?.length) {
    const subjects = s.commits.slice(0, MAX_SUBJECTS).map((c) => c.subject);
    parts.push(`Commits:\n${subjects.join('\n')}`);
  }
  return parts.join('\n');
}

/** Cap the total prompt size so a runaway history can never blow the model context. */
export function capLength(s: string, maxChars = 6000): string {
  return s.length <= maxChars ? s : s.slice(0, maxChars) + '\n...[truncated]';
}
