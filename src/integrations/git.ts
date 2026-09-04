import { exec } from 'child_process';
import { promisify } from 'util';
import { Session } from '../core/types';

const run = promisify(exec);
const GIT_HASH_RE = /^([0-9a-f]{7,40})\s+(.*)$/;

/** Best-effort git integration: capture branch + commits within session. */
export async function annotateSessionWithGit(s: Session, cwd: string): Promise<void> {
  try {
    // Only annotate if the workspace looks like a git repo.
    await run('git rev-parse --is-inside-work-tree', { cwd });
  } catch {
    return;
  }

  try {
    const { stdout } = await run('git branch --show-current', { cwd });
    const branch = stdout.trim();
    if (branch) s.gitBranch = branch;
  } catch {
    /* ignore */
  }

  if (!s.endedAt) return;
  try {
    const since = new Date(s.startedAt).toISOString();
    const until = new Date(s.endedAt).toISOString();
    const { stdout } = await run(
      `git log --since="${since}" --until="${until}" --pretty=format:"%h %s"`
        .replace(/\n/g, ' '),
      { cwd, maxBuffer: 1024 * 1024 }
    );
    const commits: { hash: string; subject: string }[] = [];
    for (const line of stdout.split('\n')) {
      const m = GIT_HASH_RE.exec(line);
      if (m) commits.push({ hash: m[1], subject: m[2] });
    }
    if (commits.length) s.commits = commits;
  } catch {
    /* ignore */
  }
}
