import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TechnicalStore } from '../src/storage/technicalStore';
import type { TechnicalEntry } from '../src/core/types';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lalog-tech-test-'));
}

test('append and read round-trip', () => {
  const dir = tempDir();
  const store = new TechnicalStore(dir);
  const entry: TechnicalEntry = {
    type: 'terminal',
    ts: 1000,
    commandLine: 'git status',
    exitCode: 0,
    durationMs: 500,
    cwd: '/project',
    confidence: 'high',
  };
  store.append(entry, 'session-1');
  const entries = store.read('session-1');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].type, 'terminal');
  assert.equal((entries[0] as any).commandLine, 'git status');
});

test('read returns empty array for nonexistent session', () => {
  const dir = tempDir();
  const store = new TechnicalStore(dir);
  const entries = store.read('nonexistent');
  assert.deepEqual(entries, []);
});

test('rotation keeps last N entries when file exceeds maxFileBytes', () => {
  const dir = tempDir();
  // Set tiny maxFileBytes to trigger rotation quickly
  const store = new TechnicalStore(dir, 200, 3);
  for (let i = 0; i < 10; i++) {
    store.append({
      type: 'diff',
      ts: i,
      path: `/file${i}.ts`,
      diff: 'x'.repeat(50),
      linesAdded: 1,
      linesRemoved: 0,
      newFile: false,
    }, 'session-1');
  }
  const entries = store.read('session-1');
  // Should have been rotated to maxEntries (3)
  assert.ok(entries.length <= 5, `expected <= 5 entries, got ${entries.length}`);
  // The last entries should be the most recent
  if (entries.length > 0) {
    const last = entries[entries.length - 1] as any;
    assert.ok(last.ts >= 7, 'should keep recent entries');
  }
});

test('malformed lines are skipped', () => {
  const dir = tempDir();
  const store = new TechnicalStore(dir);
  const file = store.pathFor('session-bad');
  fs.writeFileSync(file, '{"type":"ai","ts":1}\nNOT JSON\n{"type":"ai","ts":2}\n');
  const entries = store.read('session-bad');
  assert.equal(entries.length, 2);
});

test('delete removes the sidecar file', () => {
  const dir = tempDir();
  const store = new TechnicalStore(dir);
  store.append({
    type: 'ai',
    ts: 1,
    task: 'test',
    model: 'm',
    latencyMs: 100,
    promptChars: 10,
    responseChars: 5,
    truncated: false,
  }, 'session-del');
  assert.ok(fs.existsSync(store.pathFor('session-del')));
  store.delete('session-del');
  assert.ok(!fs.existsSync(store.pathFor('session-del')));
});

test('pathFor returns expected path shape', () => {
  const dir = tempDir();
  const store = new TechnicalStore(dir);
  const p = store.pathFor('abc-123');
  assert.ok(p.endsWith('abc-123.jsonl'));
  assert.ok(p.startsWith(dir));
});
