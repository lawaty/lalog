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
// ---- US-5.5 / US-5.6 · per-workspace projects (ADR-030) ---------------------

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

/** A seeded project record. Omit `nameSource` for a pre-0.7 (flag-less) record. */
function seeded(
  id: string,
  name: string,
  keys: string[],
  hints: string[],
  createdAt: number,
  nameSource?: 'auto' | 'user'
) {
  return nameSource ? { id, name, color: '#409cd4', workspaceKeys: keys, pathHints: hints, createdAt, nameSource } : { id, name, color: '#409cd4', workspaceKeys: keys, pathHints: hints, createdAt };
}

function lastState(): any {
  const msgs = mockVscode._webviewMessages.filter((m: any) => m && m.type === 'state');
  return msgs.length ? msgs[msgs.length - 1] : null;
}

test('US-5.5 · no project yet → one is created for this workspace, named after it', () => {
  const dir = tempDataDir();
  const r = registryOver(dir);
  const res = r.ensureWorkspaceProject({
    wsKey: 'k-new',
    wsPath: '/home/me/lalog',
    vscName: 'lalog',
    // Another workspace's history must NOT be absorbed (no global union).
    history: [session('k-old', { workspaceName: 'worklog' })],
  });
  assert.equal(res.split, false);
  assert.equal(r.list().length, 1);
  assert.equal(res.project.name, 'lalog');
  assert.equal(res.project.nameSource, 'auto');
  assert.deepEqual(res.project.workspaceKeys, ['k-new'], 'only this workspace is claimed');
  assert.deepEqual(res.project.pathHints, ['/home/me/lalog']);
  assert.ok(res.project.id.startsWith('prj_'));
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'projects.json'), 'utf8'));
  assert.equal(onDisk.projects[0].nameSource, 'auto');
});

test('US-5.5 · exact match on an auto name → tracks the workspace name, restores, claims the path', () => {
  const dir = tempDataDir();
  const r = registryOver(dir, [
    { ...seeded('prj_a', 'worklog', ['k-lalog'], [], 1000, 'auto'), archivedAt: 5000 },
  ]);
  const res = r.ensureWorkspaceProject({
    wsKey: 'k-lalog',
    wsPath: '/home/me/lalog',
    vscName: 'lalog',
    history: [],
  });
  assert.equal(res.split, false);
  assert.equal(res.project.id, 'prj_a', 'the claiming project is reused');
  assert.equal(res.project.name, 'lalog', 'auto name follows the workspace');
  assert.equal(res.project.nameSource, 'auto', 'still auto');
  assert.equal(res.project.archivedAt, undefined, 'un-archived');
  assert.deepEqual(res.project.pathHints, ['/home/me/lalog']);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(dir, 'projects.json'), 'utf8')).projects[0].name,
    'lalog',
    'persisted'
  );
});

test('US-5.5 · exact match on a user name → never renamed (flag-less records count as user)', () => {
  for (const nameSource of ['user', undefined] as const) {
    const dir = tempDataDir();
    const r = registryOver(dir, [seeded('prj_a', 'Client X', ['k-lalog'], ['/home/me/lalog'], 1000, nameSource)]);
    const res = r.ensureWorkspaceProject({
      wsKey: 'k-lalog',
      wsPath: '/home/me/lalog',
      vscName: 'lalog',
      history: [],
    });
    assert.equal(res.project.id, 'prj_a');
    assert.equal(res.project.name, 'Client X', `name kept (nameSource: ${String(nameSource)})`);
    assert.equal(res.project.nameSource, nameSource);
  }
});

test('US-5.5 · several projects exist → nothing is collapsed, this workspace only', () => {
  // (a) the current key is unclaimed → create this window's project, keep the rest.
  const dir = tempDataDir();
  const r = registryOver(dir, [
    seeded('prj_a', 'Client A', ['k-a'], ['/a'], 1000, 'user'),
    seeded('prj_b', 'Client B', ['k-b'], ['/b'], 2000, 'user'),
  ]);
  const created = r.ensureWorkspaceProject({
    wsKey: 'k-new',
    wsPath: '/home/me/lalog',
    vscName: 'lalog',
    history: [session('k-a', { workspaceName: 'Client A' })],
  });
  assert.equal(created.split, false);
  assert.deepEqual(r.list().map((p) => p.name).sort(), ['Client A', 'Client B', 'lalog']);
  assert.deepEqual(r.list()[0].workspaceKeys, ['k-a'], 'other claims are untouched');
  assert.deepEqual(r.list()[0].pathHints, ['/a'], 'other hints are untouched');

  // (b) the current key is claimed → that project, no union, no drop.
  const res = r.ensureWorkspaceProject({
    wsKey: 'k-a',
    wsPath: '/a',
    vscName: 'Client A',
    history: [],
  });
  assert.equal(res.project.id, 'prj_a');
  assert.deepEqual(r.list()[0].workspaceKeys, ['k-a'], 'never unioned with other keys');
  assert.equal(r.list().length, 3);
});

test('US-5.5 · a collapsed legacy record is split once into per-workspace projects', () => {
  const dir = tempDataDir();
  // Exactly what ADR-029 left behind: one project claiming every workspace.
  const r = registryOver(dir, [
    seeded('prj_legacy', 'everything', ['k-a', 'k-b', 'k-c', 'k-dead'], ['/home/me/Alpha', '/home/me/Beta', '/home/me/Gamma'], 1000),
  ]);
  const before = fs.readFileSync(path.join(dir, 'projects.json'), 'utf8');
  const history = [
    session('k-a', { id: 's-a-old', workspaceName: 'alpha-old', startedAt: 1000 }),
    session('k-a', { id: 's-a-new', workspaceName: 'Alpha', startedAt: 5000 }),
    session('k-b', { id: 's-b', workspaceName: 'Beta', startedAt: 2000 }),
    session('k-c', { id: 's-c', workspaceName: 'Gamma', startedAt: 4000 }),
    // k-dead: no session and no pathHint → nothing references it.
  ];

  const res = r.ensureWorkspaceProject({
    wsKey: 'k-a',
    wsPath: '/home/me/Alpha',
    vscName: 'Alpha',
    history,
  });
  assert.equal(res.split, true);
  assert.equal(res.project.name, 'Alpha', 'current workspace is named from its own history');
  const projects = r.list();
  assert.equal(projects.length, 3, 'k-dead was skipped');
  assert.deepEqual(projects.map((p) => p.name).sort(), ['Alpha', 'Beta', 'Gamma']);
  assert.deepEqual(projects.map((p) => p.workspaceKeys[0]).sort(), ['k-a', 'k-b', 'k-c']);
  assert.ok(projects.every((p) => p.workspaceKeys.length === 1), 'one key each');
  assert.deepEqual(
    projects.map((p) => p.pathHints[0]).sort(),
    ['/home/me/Alpha', '/home/me/Beta', '/home/me/Gamma'],
    'the matching folder hint is attached'
  );
  assert.ok(projects.every((p) => p.nameSource === 'auto'), 'split records are auto-named');
  assert.ok(
    projects.every((p) => p.id !== 'prj_legacy'),
    'the collapsed id is dropped'
  );
  assert.equal(
    new Set(projects.map((p) => p.color)).size,
    projects.length,
    'split projects get distinct palette colors'
  );

  const bakFile = path.join(dir, 'projects.json.pre-split.bak');
  assert.ok(fs.existsSync(bakFile), 'pre-split backup written');
  assert.equal(fs.readFileSync(bakFile, 'utf8'), before, 'backup holds the collapsed file');
  assert.ok(
    !fs.existsSync(path.join(dir, 'projects.json.pre-collapse.bak')),
    'no collapse backup (that mechanism is gone)'
  );

  // Idempotent: a second call (and a fresh registry over the split file) is a no-op.
  const after = [...r.list()].sort((a, b) => a.name.localeCompare(b.name));
  const bakAfter = fs.readFileSync(bakFile, 'utf8');
  const second = r.ensureWorkspaceProject({ wsKey: 'k-a', wsPath: '/home/me/Alpha', vscName: 'Alpha', history });
  assert.equal(second.split, false);
  assert.equal(r.list().length, 3);
  assert.deepEqual(
    [...r.list()].sort((a, b) => a.name.localeCompare(b.name)).map((p) => [p.id, p.name]),
    after.map((p) => [p.id, p.name]),
    'nothing changed'
  );
  assert.equal(fs.readFileSync(bakFile, 'utf8'), bakAfter, 'backup is never rewritten');
  const third = registryOver(dir).ensureWorkspaceProject({ wsKey: 'k-a', wsPath: '/home/me/Alpha', vscName: 'Alpha', history });
  assert.equal(third.split, false, 'a fresh registry over the split file does not split again');
  assert.equal(third.project.id, after.find((p) => p.name === 'Alpha')!.id);
});

test('US-5.5 · a collapsed record the user named is never split', () => {
  const dir = tempDataDir();
  const r = registryOver(dir, [
    seeded('prj_legacy', 'Client X', ['k-a', 'k-b'], ['/a', '/b'], 1000, 'user'),
  ]);
  const res = r.ensureWorkspaceProject({ wsKey: 'k-a', wsPath: '/a', vscName: 'Alpha', history: [session('k-a', { workspaceName: 'Alpha' })] });
  assert.equal(res.split, false);
  assert.equal(r.list().length, 1, 'still one project');
  assert.ok(!fs.existsSync(path.join(dir, 'projects.json.pre-split.bak')), 'no backup');
  assert.equal(res.project.name, 'Client X', 'user name wins');
});

test('US-5.5 · the project is named after the VS Code workspace name', async (t) => {
  const dir = tempDataDir();
  await setupExtension(t, { dir, vscWorkspaceName: 'Daftra Project' });
  const projects = new ProjectRegistry(buildPaths(dir)).list();
  assert.equal(projects.length, 1);
  assert.equal(projects[0].name, 'Daftra Project', 'not the folder basename');
  assert.equal(projects[0].nameSource, 'auto');
});

test('US-5.5 · no VS Code workspace name → the folder basename is the default', async (t) => {
  const dir = tempDataDir();
  const ext = await setupExtension(t, { dir });
  const projects = new ProjectRegistry(buildPaths(dir)).list();
  assert.equal(projects.length, 1);
  assert.equal(projects[0].name, path.basename(ext.wsPath));
  assert.equal(projects[0].nameSource, 'auto');
});

test('US-5.5 · renaming marks the name user-owned — auto-tracking stops', async (t) => {
  const dir = tempDataDir();
  const ext = await setupExtension(t, { dir, vscWorkspaceName: 'worklog' });
  const paths = ext.paths;
  const before = new ProjectRegistry(paths).list();
  assert.equal(before.length, 1);
  assert.equal(before[0].name, 'worklog');
  assert.equal(before[0].nameSource, 'auto');

  mockVscode.queueInputBox('Client X');
  await mockVscode.commands.executeCommand('lalog.renameProject', before[0].id);
  const onDisk = JSON.parse(fs.readFileSync(path.join(paths.dataDir, 'projects.json'), 'utf8'));
  assert.equal(onDisk.projects[0].name, 'Client X');
  assert.equal(onDisk.projects[0].nameSource, 'user', 'rename marks the name user-owned');

  // A later activation naming the workspace differently must leave it alone.
  const res = new ProjectRegistry(paths).ensureWorkspaceProject({
    wsKey: workspaceKey(ext.wsPath),
    wsPath: ext.wsPath,
    vscName: 'renamed folder',
    history: [],
  });
  assert.equal(res.project.name, 'Client X', 'a user name is never stomped');
  assert.equal(res.project.nameSource, 'user');
});

test('US-5.5 · collapsed data is split on activation: each workspace keeps its own project (regression)', async (t) => {
  const dir = tempDataDir();
  const paths = buildPaths(dir);
  ensureDirs(paths);
  const lalogWs = path.join(dir, 'lalog');
  const daftraWs = path.join(dir, 'Daftra Project');
  fs.mkdirSync(lalogWs, { recursive: true });
  fs.mkdirSync(daftraWs, { recursive: true });
  const kLalog = workspaceKey(lalogWs);
  const kDaftra = workspaceKey(daftraWs);
  assert.notEqual(kLalog, kDaftra);

  // The user's actual data: one collapsed project claiming both workspaces.
  fs.writeFileSync(
    path.join(dir, 'projects.json'),
    JSON.stringify(
      { version: 1, projects: [seeded('prj_all', 'lalog', [kLalog, kDaftra], [lalogWs, daftraWs], 1000)] },
      null,
      2
    )
  );
  const sessions = [
    session(kLalog, { id: 's-lalog-1', workspaceName: 'lalog', startedAt: 1000 }),
    session(kLalog, { id: 's-lalog-2', workspaceName: 'lalog', startedAt: 9000, projectId: 'prj_all' }),
    session(kDaftra, { id: 's-daftra-1', workspaceName: 'Daftra Project', startedAt: 5000 }),
    session(kDaftra, { id: 's-daftra-2', workspaceName: 'Daftra Project', startedAt: 9500, projectId: 'prj_all' }),
  ];
  fs.writeFileSync(paths.sessionsFile, sessions.map((s) => JSON.stringify(s)).join('\n') + '\n');

  const ext = await setupExtension(t, { dir, wsPath: lalogWs });

  const projects = new ProjectRegistry(paths).list();
  assert.equal(projects.length, 2, 'one project per workspace, nothing collapsed');
  const lalogProj = projects.find((p) => p.workspaceKeys.includes(kLalog))!;
  const daftraProj = projects.find((p) => p.workspaceKeys.includes(kDaftra))!;
  assert.deepEqual(lalogProj.workspaceKeys, [kLalog], 'the lalog project claims only the lalog key');
  assert.deepEqual(lalogProj.pathHints, [lalogWs]);
  assert.equal(lalogProj.name, 'lalog');
  assert.equal(lalogProj.nameSource, 'auto');
  assert.equal(daftraProj.name, 'Daftra Project', 'named from its own history');
  assert.deepEqual(daftraProj.pathHints, [daftraWs]);
  assert.ok(fs.existsSync(path.join(dir, 'projects.json.pre-split.bak')));

  // Every session resolves to the project of its own workspace.
  const stored = await new SessionStore({ paths, th: ext.th }).loadAll();
  for (const s of stored) {
    assert.equal(
      resolveProject(s, projects)!.id,
      s.workspaceKey === kLalog ? lalogProj.id : daftraProj.id,
      `${s.id} resolves to its own workspace's project`
    );
  }
  // Explicit pointers at the collapsed id are re-pointed at the owner of each key.
  assert.equal(stored.find((s) => s.id === 's-lalog-2')!.projectId, lalogProj.id);
  assert.equal(stored.find((s) => s.id === 's-daftra-2')!.projectId, daftraProj.id);

  // The panel shows this window's project under its own name — and nothing else.
  const view = mockWebviewView();
  mockVscode._webviewProvider.resolveWebviewView(view);
  await waitFor(() => lastState() !== null);
  const st = lastState();
  assert.equal(st.multiProject, false);
  assert.equal(st.projects.length, 1, "single mode pushes only this window's project");
  assert.equal(st.projects[0].id, lalogProj.id);
  assert.equal(st.projects[0].name, 'lalog');
});

test('US-5.5 · palette rename in single mode targets this window project', async (t) => {
  const dir = tempDataDir();
  const paths = buildPaths(dir);
  ensureDirs(paths);
  const ws = path.join(dir, 'workspace');
  fs.mkdirSync(ws, { recursive: true });
  const k = workspaceKey(ws);
  // Another (non-archived) project sorts first — the palette fallback must NOT
  // pick it, because a single-mode window shows (and may rename) only its own.
  fs.writeFileSync(
    path.join(dir, 'projects.json'),
    JSON.stringify(
      {
        version: 1,
        projects: [
          seeded('prj_other', 'Other Client', ['k-other'], ['/other'], 1000, 'user'),
          seeded('prj_win', 'Mine', [k], [ws], 2000, 'user'),
        ],
      },
      null,
      2
    )
  );
  await setupExtension(t, { dir, wsPath: ws });
  mockVscode.queueInputBox('Renamed');
  await mockVscode.commands.executeCommand('lalog.renameProject');
  const prompts = mockVscode._promptCalls.filter((c) => c.title === 'Rename project');
  assert.equal(prompts.at(-1)?.value, 'Mine', "the prefill is this window's project, not the first one");
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'projects.json'), 'utf8'));
  assert.equal(onDisk.projects.find((p) => p.id === 'prj_win')!.name, 'Renamed');
  assert.equal(
    onDisk.projects.find((p) => p.id === 'prj_other')!.name,
    'Other Client',
    "the other workspace project is untouched"
  );
});

test('US-5.5 · a deliberate multi-key union (nameSource present) is never split', () => {
  // Post-0.7 records always carry nameSource; a multi-key project there is a
  // deliberate union built in multi mode, not a 0.6.0 collapse artifact.
  for (const nameSource of ['auto', 'user'] as const) {
    const dir = tempDataDir();
    const r = registryOver(dir, [
      seeded('prj_u', 'Client ABC', ['k-a', 'k-b'], ['/a', '/b'], 1000, nameSource as any),
    ]);
    const res = r.ensureWorkspaceProject({
      wsKey: 'k-a',
      wsPath: '/a',
      vscName: 'Alpha',
      history: [session('k-a', { workspaceName: 'Alpha' })],
    });
    assert.equal(res.split, false, `nameSource '${nameSource}' is never split`);
    assert.equal(r.list().length, 1, 'the union survives');
    assert.equal(res.project.id, 'prj_u', 'the union is reused by its key');
    assert.ok(!fs.existsSync(path.join(dir, 'projects.json.pre-split.bak')), 'no backup');
  }
});

test('US-5.5 · a renamed folder is a new identity: the old project is preserved', () => {
  const dir = tempDataDir();
  const r = registryOver(dir, [
    seeded('prj_old', 'lalog', ['k-old'], ['/home/me/lalog'], 1000, 'auto'),
  ]);
  // The folder was renamed; the current workspace has a brand-new key.
  const res = r.ensureWorkspaceProject({
    wsKey: 'k-new',
    wsPath: '/home/me/lalog2',
    vscName: 'lalog2',
    history: [session('k-old', { workspaceName: 'lalog' })],
  });
  assert.equal(res.split, false);
  assert.notEqual(res.project.id, 'prj_old', 'the new key gets its own project');
  assert.equal(res.project.name, 'lalog2');
  assert.equal(r.list().length, 2, 'no merge, no drop');
  assert.deepEqual(r.list().find((p) => p.id === 'prj_old')!.workspaceKeys, ['k-old']);
  assert.equal(
    resolveProject(session('k-old'), r.list())!.id,
    'prj_old',
    'old sessions keep resolving to the old project'
  );
  assert.equal(resolveProject(session('k-new'), r.list())!.id, res.project.id);
});

test('US-5.5 · activation never re-points a session whose projectId already resolves', async (t) => {
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
          seeded('prj_a', 'Client A', [workspaceKey(ws)], [ws], 1000, 'auto'),
          seeded('prj_b', 'Client B', ['k-b'], ['/b'], 2000, 'user'),
        ],
      },
      null,
      2
    )
  );
  // A session in ws (claimed by prj_a) is explicitly assigned to prj_b — a
  // valid pointer to a live project, unrelated to the split.
  fs.writeFileSync(
    paths.sessionsFile,
    JSON.stringify(session(workspaceKey(ws), { id: 's-a', workspaceName: 'Client A', startedAt: 1000, projectId: 'prj_b' })) + '\n'
  );

  const ext = await setupExtension(t, { dir, wsPath: ws });
  const stored = await new SessionStore({ paths, th: ext.th }).loadAll();
  assert.equal(stored[0].projectId, 'prj_b', 'explicit-beats-derived is not “healed” away');
});

test('US-5.5 · the single project can be renamed from the panel', async (t) => {
  const ext = await setupExtension(t, { vscWorkspaceName: 'worklog' });
  const paths = ext.paths;
  const view = mockWebviewView();
  mockVscode._webviewProvider.resolveWebviewView(view);
  await waitFor(() => lastState() !== null);
  const before = lastState();
  assert.equal(before.projects.length, 1, 'one implicit project');
  assert.equal(before.projects[0].name, 'worklog', 'named after the VS Code workspace');

  mockVscode.queueInputBox('Client X');
  view._post({ type: 'renameProject', id: before.projects[0].id });
  await waitFor(
    () => lastState() !== null && lastState().projects[0]?.name === 'Client X'
  );
  const onDisk = JSON.parse(fs.readFileSync(path.join(paths.dataDir, 'projects.json'), 'utf8'));
  assert.equal(onDisk.projects[0].name, 'Client X', 'projects.json updated');
  assert.equal(onDisk.projects[0].nameSource, 'user');
  const prompt = mockVscode._promptCalls.find((c) => c.title === 'Rename project');
  assert.ok(prompt, 'the input box was prefilled with the current name');
  assert.equal(prompt.value, 'worklog');
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
  assert.equal(projects.length, 2, 'no split and no collapse in multi mode');
  assert.deepEqual(projects.map((p) => p.name).sort(), ['Client A', 'Client B']);
  assert.ok(!fs.existsSync(path.join(dir, 'projects.json.pre-split.bak')), 'no backup written');

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
  // In single mode the window's project owns the workspace key up front.
  const p = registry.create({ name: 'Client A', workspaceKey: h.wsKey, pathHint: h.wsPath });
  await waitFor(() => lastState() !== null && lastState().projects.length === 1);
  view._post({ type: 'newProjectFromWorkspace' });
  view._post({ type: 'newProject' });
  view._post({ type: 'claimWorkspace', projectId: p.id });
  view._post({ type: 'archiveProject', id: p.id });
  await flush();
  assert.equal(registry.list().length, 1, 'nothing was created');
  assert.equal(registry.list()[0].name, 'Client A');
  assert.deepEqual(registry.list()[0].workspaceKeys, [h.wsKey], 'claim was gated — no extra key was added');
  assert.equal(registry.list()[0].archivedAt, undefined, 'archive was gated');
  assert.equal(lastState().multiProject, false);
  assert.equal(lastState().projects.length, 1, "single mode shows only this window's project");
});
