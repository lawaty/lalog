import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setupHarness, resolvePanel, flush, setupExtension, mockWebviewView, waitFor } from '../helpers/harness';
import { mockVscode } from '../helpers/mockVscode';
import { ProjectRegistry } from '../../src/storage/projectRegistry';
import { SessionStore } from '../../src/storage/sessionStore';
import { buildPaths, ensureDirs, workspaceKey } from '../../src/storage/store';
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
// ---- US-5.5 / US-5.6 · single implicit workspace project (ADR-029) -----------

function tempDataDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lalog-proj-'));
}

/** Build a registry over `dir`, optionally pre-seeding projects.json. */
function registryOver(dir: string, projects?: unknown[]): ProjectRegistry {
  const paths = buildPaths(dir);
  ensureDirs(paths);
  if (projects) {
    fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify({ version: 1, projects }, null, 2));
  }
  return new ProjectRegistry(paths);
}

function seeded(id: string, name: string, keys: string[], hints: string[], createdAt: number) {
  return { id, name, color: '#409cd4', workspaceKeys: keys, pathHints: hints, createdAt };
}

function lastState(): any {
  const msgs = mockVscode._webviewMessages.filter((m: any) => m && m.type === 'state');
  return msgs.length ? msgs[msgs.length - 1] : null;
}

test('US-5.5 · no projects yet → one is created for this workspace', () => {
  const dir = tempDataDir();
  const r = registryOver(dir);
  const res = r.ensureSingleProject({
    wsKey: 'k-new',
    wsPath: '/home/me/lalog',
    fallbackName: 'lalog',
    historyKeys: ['k-old', 'k-old-2', 'k-new'],
  });
  assert.deepEqual(res.droppedIds, []);
  assert.equal(res.project.name, 'lalog');
  assert.deepEqual(r.list().length, 1);
  assert.deepEqual(res.project.workspaceKeys.sort(), ['k-new', 'k-old', 'k-old-2']);
  assert.deepEqual(res.project.pathHints, ['/home/me/lalog']);
  // A name collision never happens here (registry was empty).
  assert.ok(r.list()[0].id.startsWith('prj_'));
});

test('US-5.5 · one project → claims the new key and history, keeps its name', () => {
  const dir = tempDataDir();
  const r = registryOver(dir, [
    { ...seeded('prj_a', 'Client A', ['k-old'], ['/old/worklog'], 1000), archivedAt: 5000 },
  ]);
  const res = r.ensureSingleProject({
    wsKey: 'k-new',
    wsPath: '/home/me/lalog',
    fallbackName: 'lalog',
    historyKeys: ['k-old', 'k-ancient'],
  });
  assert.equal(res.project.name, 'Client A', 'never auto-renamed');
  assert.equal(res.project.archivedAt, undefined, 'sole project is restored');
  assert.deepEqual(res.droppedIds, []);
  assert.deepEqual(res.project.workspaceKeys.sort(), ['k-ancient', 'k-new', 'k-old']);
  assert.deepEqual(res.project.pathHints.sort(), ['/home/me/lalog', '/old/worklog']);
});

test('US-5.5 · several projects → the workspace-named one survives and absorbs the rest', () => {
  const dir = tempDataDir();
  const r = registryOver(dir, [
    seeded('prj_old', 'worklog', ['k-old'], ['/old/worklog'], 1000),
    seeded('prj_new', 'lalog', ['k-new'], ['/new/lalog'], 2000),
  ]);
  const before = fs.readFileSync(path.join(dir, 'projects.json'), 'utf8');
  const res = r.ensureSingleProject({
    wsKey: 'k-new',
    wsPath: '/new/lalog',
    fallbackName: 'lalog',
    historyKeys: ['k-old'],
  });
  assert.equal(res.project.id, 'prj_new', 'name match wins over createdAt');
  assert.equal(res.project.createdAt, 2000, 'survivor keeps its own id/color/createdAt');
  assert.deepEqual(res.droppedIds, ['prj_old']);
  assert.equal(r.list().length, 1);
  assert.deepEqual(res.project.workspaceKeys.sort(), ['k-new', 'k-old']);
  assert.deepEqual(res.project.pathHints.sort(), ['/new/lalog', '/old/worklog']);

  const bak = path.join(dir, 'projects.json.pre-collapse.bak');
  assert.ok(fs.existsSync(bak), 'pre-collapse backup written');
  assert.equal(fs.readFileSync(bak, 'utf8'), before, 'backup holds the original file');
  assert.deepEqual(JSON.parse(fs.readFileSync(bak, 'utf8')).projects.length, 2);
});

test('US-5.5 · no name match → oldest live project survives, archived ones fold in', () => {
  const dir = tempDataDir();
  const r = registryOver(dir, [
    { ...seeded('prj_archived', 'Client X', ['k-x'], ['/x'], 1000), archivedAt: 9000 },
    seeded('prj_mid', 'Client Y', ['k-y'], ['/y'], 3000),
    seeded('prj_newest', 'Client Z', ['k-z'], ['/z'], 5000),
  ]);
  const res = r.ensureSingleProject({
    wsKey: 'k-new',
    wsPath: '/new/lalog',
    fallbackName: 'lalog',
    historyKeys: [],
  });
  assert.equal(res.project.id, 'prj_mid', 'oldest non-archived survives');
  assert.deepEqual(res.droppedIds.sort(), ['prj_archived', 'prj_newest']);
  assert.equal(r.list().length, 1);
  assert.deepEqual(res.project.workspaceKeys.sort(), ['k-new', 'k-x', 'k-y', 'k-z']);
  assert.deepEqual(res.project.pathHints.sort(), ['/new/lalog', '/x', '/y', '/z']);
  assert.equal(res.project.archivedAt, undefined, 'survivor is live');
});

test('US-5.5 · the collapse is idempotent across activations', () => {
  const dir = tempDataDir();
  const r = registryOver(dir, [
    seeded('prj_old', 'worklog', ['k-old'], ['/old/worklog'], 1000),
    seeded('prj_new', 'lalog', ['k-new'], ['/new/lalog'], 2000),
  ]);
  const bakFile = path.join(dir, 'projects.json.pre-collapse.bak');
  const opts = {
    wsKey: 'k-new',
    wsPath: '/new/lalog',
    fallbackName: 'lalog',
    historyKeys: ['k-old', 'k-ancient'],
  };
  const first = r.ensureSingleProject(opts);
  const bakAfterFirst = fs.readFileSync(bakFile, 'utf8');
  const keysAfterFirst = [...first.project.workspaceKeys];

  const second = r.ensureSingleProject(opts);
  assert.deepEqual(second.droppedIds, [], 'nothing left to drop');
  assert.equal(second.project.id, first.project.id);
  assert.deepEqual(second.project.workspaceKeys, keysAfterFirst, 'claims unchanged');
  assert.equal(fs.readFileSync(bakFile, 'utf8'), bakAfterFirst, 'backup is never rewritten');

  const third = registryOver(dir).ensureSingleProject(opts);
  assert.deepEqual(third.droppedIds, [], 'a fresh registry over the collapsed file is a no-op');
  assert.equal(third.project.id, first.project.id);
  assert.deepEqual(third.project.workspaceKeys, keysAfterFirst);
});

test('US-5.5 · a folder rename keeps every old session in the project (regression)', async (t) => {
  const dir = tempDataDir();
  const paths = buildPaths(dir);
  ensureDirs(paths);
  const oldWs = path.join(dir, 'worklog');
  const newWs = path.join(dir, 'lalog');
  fs.mkdirSync(oldWs, { recursive: true });
  fs.mkdirSync(newWs, { recursive: true });
  const kOld = workspaceKey(oldWs);
  const kNew = workspaceKey(newWs);
  assert.notEqual(kOld, kNew);

  // The user's actual data: two projects, history recorded under the old key,
  // and one session carrying an explicit pointer at the project that is about
  // to be collapsed away.
  fs.writeFileSync(
    path.join(dir, 'projects.json'),
    JSON.stringify(
      {
        version: 1,
        projects: [
          seeded('prj_worklog', 'worklog', [kOld], [oldWs], 1000),
          seeded('prj_lalog', 'lalog', [kNew], [newWs], 2000),
        ],
      },
      null,
      2
    )
  );
  const orphan = session(kOld, { id: 's-orphan', projectId: 'prj_worklog' });
  const plain = session(kOld, { id: 's-plain' });
  fs.writeFileSync(
    paths.sessionsFile,
    [JSON.stringify(orphan), JSON.stringify(plain)].join('\n') + '\n'
  );

  const ext = await setupExtension(t, { dir, wsPath: newWs });

  const registry = new ProjectRegistry(paths);
  const projects = registry.list();
  assert.equal(projects.length, 1, 'collapsed to a single project');
  assert.equal(projects[0].name, 'lalog');
  assert.ok(projects[0].workspaceKeys.includes(kOld), 'old folder key is claimed');
  assert.ok(projects[0].workspaceKeys.includes(kNew), 'new folder key is claimed');
  assert.ok(fs.existsSync(path.join(dir, 'projects.json.pre-collapse.bak')));
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(dir, 'projects.json.pre-collapse.bak'), 'utf8')).projects
      .length,
    2,
    'both originals are in the backup'
  );

  // The explicit pointer at the dropped project is re-pointed, not left dangling.
  const stored = await new SessionStore({ paths, th: ext.th }).loadAll();
  const healed = stored.find((s) => s.id === 's-orphan')!;
  assert.equal(healed.projectId, projects[0].id, 'sessions.jsonl re-pointed to the survivor');
  // …and the old-key session now resolves to the single project.
  assert.equal(resolveProject(stored.find((s) => s.id === 's-plain')!, projects)?.id, projects[0].id);
  assert.equal(resolveProject(healed, projects)?.id, projects[0].id);

  // The panel shows one project and says so.
  const view = mockWebviewView();
  mockVscode._webviewProvider.resolveWebviewView(view);
  await waitFor(() => lastState() !== null);
  const st = lastState();
  assert.equal(st.multiProject, false);
  assert.equal(st.projects.length, 1);
  assert.equal(st.projects[0].name, 'lalog');
});

test('US-5.5 · the single project can be renamed from the panel', async (t) => {
  const ext = await setupExtension(t);
  const paths = ext.paths;
  const view = mockWebviewView();
  mockVscode._webviewProvider.resolveWebviewView(view);
  await waitFor(() => lastState() !== null);
  const before = lastState();
  assert.equal(before.projects.length, 1, 'one implicit project');
  assert.equal(before.projects[0].name, 'workspace', 'named after the folder');

  mockVscode.queueInputBox('Client X');
  view._post({ type: 'renameProject', id: before.projects[0].id });
  await waitFor(
    () => lastState() !== null && lastState().projects[0]?.name === 'Client X'
  );
  const onDisk = JSON.parse(fs.readFileSync(path.join(paths.dataDir, 'projects.json'), 'utf8'));
  assert.equal(onDisk.projects[0].name, 'Client X', 'projects.json updated');
  const prompt = mockVscode._promptCalls.find((c) => c.title === 'Rename project');
  assert.ok(prompt, 'the input box was prefilled with the current name');
  assert.equal(prompt.value, 'workspace');
  // Cancelling leaves the name alone.
  mockVscode.queueInputBox('   ');
  view._post({ type: 'renameProject', id: before.projects[0].id });
  await waitFor(() => mockVscode._promptCalls.filter((c) => c.title === 'Rename project').length === 2);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(paths.dataDir, 'projects.json'), 'utf8')).projects[0].name,
    'Client X',
    'blank input does not rename'
  );
});

test('US-5.6 · lalog.multiProject keeps every project untouched', async (t) => {
  const dir = tempDataDir();
  const paths = buildPaths(dir);
  ensureDirs(paths);
  const ws = path.join(dir, 'workspace');
  fs.mkdirSync(ws, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'projects.json'),
    JSON.stringify(
      {
        version: 1,
        projects: [
          seeded('prj_a', 'Client A', [workspaceKey(ws)], [ws], 1000),
          seeded('prj_b', 'Client B', ['k-old'], ['/old'], 2000),
        ],
      },
      null,
      2
    )
  );

  await setupExtension(t, { dir, wsPath: ws, config: { multiProject: true } });
  const projects = new ProjectRegistry(paths).list();
  assert.equal(projects.length, 2, 'no collapse in multi mode');
  assert.deepEqual(projects.map((p) => p.name).sort(), ['Client A', 'Client B']);
  assert.ok(!fs.existsSync(path.join(dir, 'projects.json.pre-collapse.bak')), 'no backup written');

  const view = mockWebviewView();
  mockVscode._webviewProvider.resolveWebviewView(view);
  await waitFor(() => lastState() !== null);
  const st = lastState();
  assert.equal(st.multiProject, true);
  assert.equal(st.projects.length, 2);
  // Management actions stay available in this mode.
  view._post({ type: 'newProjectFromWorkspace' });
  await waitFor(() => new ProjectRegistry(paths).list().length === 3);
});

test('US-5.5 · the Projects tab shows one name, and hides create/claim/archive', async (t) => {
  const h = setupHarness(t);
  await h.start();
  const { view, registry } = resolvePanel(h, { multiProject: false });
  // No workspace key up front — the gated claim must not add one.
  const p = registry.create({ name: 'Client A' });
  await waitFor(() => lastState() !== null && lastState().projects.length === 1);
  view._post({ type: 'newProjectFromWorkspace' });
  view._post({ type: 'newProject' });
  view._post({ type: 'claimWorkspace', projectId: p.id });
  view._post({ type: 'archiveProject', id: p.id });
  await flush();
  assert.equal(registry.list().length, 1, 'nothing was created');
  assert.equal(registry.list()[0].name, 'Client A');
  assert.equal(registry.list()[0].workspaceKeys.length, 0, 'claim was gated — no key was added');
  assert.equal(registry.list()[0].archivedAt, undefined, 'archive was gated');
  assert.equal(lastState().multiProject, false);
});
