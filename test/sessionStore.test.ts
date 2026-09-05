import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildPaths, LaLogPaths } from '../src/storage/store';
import { SessionStore, normalizeSession } from '../src/storage/sessionStore';
import type { ThresholdsMs } from '../src/core/config';
import type { Session } from '../src/core/types';

const MIN = 60 * 1000;
const th: ThresholdsMs = {
  idleGap: 5 * MIN,
  idleConfirm: 15 * MIN,
  describeAt: 90 * MIN,
  describeForce: 120 * MIN,
  wrapAt: 210 * MIN,
  wrapForce: 240 * MIN,
  grace: 30 * MIN,
  hardSplit: 300 * MIN,
  autoEndIdle: 120 * MIN,
  resumeWindow: 30 * MIN,
  maxGraceExtensions: 3,
};

function tempStore(): SessionStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lalog-test-'));
  return new SessionStore({ paths: buildPaths(dir), th });
}

test('newSession starts with zeroed event counters', () => {
  const store = tempStore();
  const s = store.newSession('abcd123456', 'demo', 1000);
  assert.deepEqual(s.events, {
    edits: 0,
    saves: 0,
    terminal: 0,
    fileops: 0,
    tasks: 0,
    debug: 0,
    topFiles: [],
  });
  assert.equal(s.activeMinutes, 0);
});

test('recordEvent counts each event kind and edits touch topFiles', () => {
  const store = tempStore();
  const s = store.newSession('abcd123456', 'demo', 0);
  store.recordEvent(s, 'edit', '/x/a.ts', 10);
  store.recordEvent(s, 'edit', '/x/a.ts', 20);
  store.recordEvent(s, 'save', undefined, 30);
  store.recordEvent(s, 'terminal', undefined, 40);
  store.recordEvent(s, 'fileop', undefined, 50);
  store.recordEvent(s, 'task', undefined, 60);
  store.recordEvent(s, 'debug', undefined, 70);
  assert.equal(s.events.edits, 2);
  assert.equal(s.events.saves, 1);
  assert.equal(s.events.terminal, 1);
  assert.equal(s.events.fileops, 1);
  assert.equal(s.events.tasks, 1);
  assert.equal(s.events.debug, 1);
  assert.equal(s.lastActivityAt, 70, 'lastActivityAt tracks every event');
  assert.equal(s.events.topFiles.length, 1);
  assert.equal(s.events.topFiles[0].edits, 2);
});

test('normalizeSession backfills legacy fields and counters', () => {
  const legacy = {
    id: 'legacy',
    startedAt: 0,
    lastActivityAt: 0,
    activeMinutes: 0,
    notes: undefined,
    needsDescription: false,
    events: { edits: 3, saves: 1, terminal: 0, topFiles: [] },
  } as unknown as Session;
  const n = normalizeSession(legacy);
  assert.ok(Array.isArray(n.activeSpans), 'activeSpans backfilled');
  assert.ok(Array.isArray(n.activityTs), 'activityTs backfilled');
  assert.ok(Array.isArray(n.notes), 'notes backfilled');
  assert.equal(n.events.fileops, 0, 'fileops defaulted');
  assert.equal(n.events.tasks, 0, 'tasks defaulted');
  assert.equal(n.events.debug, 0, 'debug defaulted');
  assert.equal(n.events.edits, 3, 'existing counters preserved');
  assert.ok(Array.isArray(n.events.topFiles));
});

test('close persists a session JSONL and loadAll normalizes it back', async () => {
  const store = tempStore();
  const s = store.newSession('abcd123456', 'demo', 0);
  store.recordEvent(s, 'edit', '/x/a.ts', 5000);
  store.recordEvent(s, 'debug', undefined, 6000);
  await store.close(s, 'user', 7000);
  const all = await store.loadAll();
  assert.equal(all.length, 1);
  assert.equal(all[0].events.edits, 1);
  assert.equal(all[0].events.debug, 1);
  assert.equal(all[0].closedReason, 'user');
  assert.equal(all[0].endedAt, 7000);
});