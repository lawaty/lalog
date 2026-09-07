import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveProject, resolveProjectName, isProjectColor, pickProjectColor, PROJECT_COLORS } from '../src/core/projects';
import type { Project, Session } from '../src/core/types';

function session(wsKey: string, extra: Partial<Session> = {}): Session {
  return {
    id: 's1',
    workspaceKey: wsKey,
    workspaceName: 'proj',
    startedAt: 1000,
    lastActivityAt: 2000,
    activeMinutes: 60000,
    notes: [],
    needsDescription: false,
    events: { edits: 0, saves: 0, terminal: 0, fileops: 0, tasks: 0, debug: 0, topFiles: [] },
    activeSpans: [],
    activityTs: [],
    ...extra,
  };
}

function project(id: string, workspaceKeys: string[], archived?: boolean): Project {
  return { id, name: id, color: '#2ea043', workspaceKeys, pathHints: [], createdAt: 0, archivedAt: archived ? 1 : undefined };
}

const A = project('a', ['key-a']);
const B = project('b', ['key-b', 'key-a']);
const archived = project('arch', ['key-z'], true);

test('resolveProject derives from the first matching non-archived claim', () => {
  const s = session('key-a');
  assert.equal(resolveProject(s, [A, B])?.id, 'a');
});

test('resolveProject falls back to null when nothing claims the key', () => {
  assert.equal(resolveProject(session('key-missing'), [A, B]), null);
});

test('resolveProject ignores archived projects for derivation', () => {
  assert.equal(resolveProject(session('key-z'), [archived]), null);
});

test('explicit projectId beats derived claims', () => {
  const s = session('key-a', { projectId: 'b' });
  assert.equal(resolveProject(s, [A, B])?.id, 'b');
});

test('explicit projectId resolves even when the project is archived', () => {
  const s = session('key-q', { projectId: 'arch' });
  assert.equal(resolveProject(s, [archived])?.id, 'arch');
});

test('explicit projectId that no longer exists resolves to null', () => {
  const s = session('key-a', { projectId: 'nope' });
  assert.equal(resolveProject(s, [A, B]), null);
});

test('resolveProjectName falls back to the workspace name', () => {
  assert.equal(resolveProjectName(session('key-missing'), [A]), 'proj');
  assert.equal(resolveProjectName(session('key-a'), [A]), 'a');
});

test('project colors: palette, cycle, and valid hex', () => {
  assert.equal(PROJECT_COLORS.length, 10);
  assert.equal(pickProjectColor(0), PROJECT_COLORS[0]);
  assert.equal(pickProjectColor(10), PROJECT_COLORS[0]);
  assert.equal(pickProjectColor(11), PROJECT_COLORS[1]);
  assert.ok(PROJECT_COLORS.every(isProjectColor));
  assert.ok(!isProjectColor('red'));
});