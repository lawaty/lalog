import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import { annotateSessionWithGit } from '../../src/integrations/git';
import type { Session } from '../../src/core/types';

function session(startedAt: number, endedAt: number): Session {
  return {
    id: 's1',
    workspaceKey: 'wk',
    workspaceName: 'ws',
    startedAt,
    endedAt,
    lastActivityAt: endedAt,
    activeMinutes: endedAt - startedAt,
    notes: [],
    needsDescription: false,
    events: { edits: 0, saves: 0, terminal: 0, fileops: 0, tasks: 0, debug: 0, topFiles: [] },
    activeSpans: [],
    activityTs: [],
  };
}

test('US-7.1 · git annotation is best-effort on a non-git workspace', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lalog-nogit-'));
  const s = session(Date.now() - 60000, Date.now());
  await annotateSessionWithGit(s, dir); // must not throw
  assert.equal(s.gitBranch, undefined);
  assert.equal(s.commits, undefined);
});

test('US-7.1 · git annotation captures branch and commits in a git repo', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lalog-git-'));
  execSync('git init -q', { cwd: dir });
  execSync('git config user.email test@example.com', { cwd: dir });
  execSync('git config user.name Test', { cwd: dir });
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello\n');
  execSync('git add a.txt', { cwd: dir });
  execSync('git commit -q -m "Initial commit"', { cwd: dir });
  execSync('git checkout -q -b feature/x', { cwd: dir });
  fs.writeFileSync(path.join(dir, 'b.txt'), 'world\n');
  execSync('git add b.txt', { cwd: dir });
  execSync('git commit -q -m "Add b"', { cwd: dir });
  const startedAt = Date.now() - 5 * 60 * 1000;
  const endedAt = Date.now() + 60 * 1000;
  const s = session(startedAt, endedAt);
  await annotateSessionWithGit(s, dir);
  assert.equal(s.gitBranch, 'feature/x');
  assert.ok(s.commits && s.commits.length >= 1);
  assert.ok(s.commits!.some((c) => c.subject === 'Add b'));
});