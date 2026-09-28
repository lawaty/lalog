import test from 'node:test';
import assert from 'node:assert/strict';
import { setupHarness, resolvePanel, flush } from '../helpers/harness';
import { ProjectRegistry } from '../../src/storage/projectRegistry';
import { resolveProject, resolveProjectName, isProjectColor, pickProjectColor, PROJECT_COLORS } from '../../src/core/projects';
import type { Session } from '../../src/core/types';

function session(wsKey: string, extra: Partial<Session> = {}): Session {
  return {
    id: 's-' + wsKey + '-' + Math.random().toString(36).slice(2),
    workspaceKey: wsKey,
    workspaceName: 'ws',
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

test('US-5.1 · create a project from the current workspace in one click', async (t) => {
  const h = setupHarness(t);
  await h.start();
  const { view, registry } = resolvePanel(h);
  view._post({ type: 'newProjectFromWorkspace' });
  await flush();
  const projects = registry.list();
  assert.equal(projects.length, 1);
  assert.equal(projects[0].workspaceKeys[0], h.wsKey);
  assert.equal(projects[0].pathHints[0], h.wsPath);
});

test('US-5.2 · one project claims many workspaces; sessions derive to it', async (t) => {
  const h = setupHarness(t);
  await h.start();
  const { registry } = resolvePanel(h);
  const proj = registry.create({ name: 'Client A', workspaceKey: h.wsKey });
  registry.addClaim(proj.id, 'ws-key-b', '/other/ws');
  assert.equal(resolveProject(session(h.wsKey), registry.list())?.id, proj.id);
  assert.equal(resolveProject(session('ws-key-b'), registry.list())?.id, proj.id);
  assert.equal(resolveProject(session('ws-key-c'), registry.list()), null);
});

test('US-5.2 · claim a workspace via the panel', async (t) => {
  const h = setupHarness(t);
  await h.start();
  const { view, registry } = resolvePanel(h);
  const proj = registry.create({ name: 'Client A' });
  view._post({ type: 'claimWorkspace', projectId: proj.id });
  await flush();
  assert.ok(registry.get(proj.id)!.workspaceKeys.includes(h.wsKey));
});

test('US-5.2 · project colors: palette, cycle, valid hex', () => {
  assert.equal(PROJECT_COLORS.length, 10);
  assert.equal(pickProjectColor(0), PROJECT_COLORS[0]);
  assert.equal(pickProjectColor(10), PROJECT_COLORS[0]);
  assert.equal(pickProjectColor(11), PROJECT_COLORS[1]);
  assert.ok(PROJECT_COLORS.every(isProjectColor));
  assert.ok(!isProjectColor('red'));
});

test('US-5.3 · explicit per-session override beats derived claims', async (t) => {
  const h = setupHarness(t);
  await h.start();
  const { registry } = resolvePanel(h);
  const a = registry.create({ name: 'A', workspaceKey: h.wsKey });
  const b = registry.create({ name: 'B' });
  h.manager.assignProject(b.id);
  assert.equal(h.manager.getSession()!.projectId, b.id);
  const s = session(h.wsKey, { projectId: b.id });
  assert.equal(resolveProject(s, registry.list())?.id, b.id);
  assert.equal(resolveProjectName(s, registry.list()), 'B');
});

test('US-5.4 · archive stops derivation but keeps history and explicit assignments', async (t) => {
  const h = setupHarness(t);
  await h.start();
  const { registry } = resolvePanel(h);
  const proj = registry.create({ name: 'Client A', workspaceKey: h.wsKey });
  assert.equal(resolveProject(session(h.wsKey), registry.list())?.id, proj.id);
  const explicit = session('other-key', { projectId: proj.id });
  assert.equal(resolveProject(explicit, registry.list())?.id, proj.id);
  registry.archive(proj.id);
  assert.ok(registry.get(proj.id)!.archivedAt, 'archived flag set');
  assert.equal(resolveProject(session(h.wsKey), registry.list()), null, 'no longer derives');
  assert.equal(resolveProject(explicit, registry.list())?.id, proj.id, 'explicit assignment kept');
  registry.archive(proj.id, false);
  assert.equal(resolveProject(session(h.wsKey), registry.list())?.id, proj.id, 'restored');
});

test('US-5.4 · archive/restore via the panel', async (t) => {
  const h = setupHarness(t);
  await h.start();
  const { view, registry } = resolvePanel(h);
  const proj = registry.create({ name: 'Client A', workspaceKey: h.wsKey });
  view._post({ type: 'archiveProject', id: proj.id });
  await flush();
  assert.ok(registry.get(proj.id)!.archivedAt);
  view._post({ type: 'archiveProject', id: proj.id });
  await flush();
  assert.equal(registry.get(proj.id)!.archivedAt, undefined);
});