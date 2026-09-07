import test from 'node:test';
import assert from 'node:assert/strict';
import { DiffCapture } from '../src/capture/diffCapture';

test('first save produces a newFile diff with all lines added', () => {
  const cap = new DiffCapture(16000, []);
  const entry = cap.onSave('/test/file.ts', 'line1\nline2\nline3\n');
  assert.ok(entry);
  assert.equal(entry.type, 'diff');
  assert.equal(entry.newFile, true);
  assert.equal(entry.path, '/test/file.ts');
  assert.ok(entry.linesAdded > 0);
  assert.equal(entry.linesRemoved, 0);
  assert.ok(entry.diff.includes('line1'));
});

test('second save produces a real patch with correct line counts', () => {
  const cap = new DiffCapture(16000, []);
  cap.onSave('/test/file.ts', 'line1\nline2\n');
  const entry = cap.onSave('/test/file.ts', 'line1\nline2\nline3\n');
  assert.ok(entry);
  assert.equal(entry.newFile, false);
  assert.ok(entry.linesAdded >= 1);
  assert.equal(entry.linesRemoved, 0);
});

test('binary file (null byte) returns null', () => {
  const cap = new DiffCapture(16000, []);
  const binary = 'text\x00binary';
  const entry = cap.onSave('/test/binary.bin', binary);
  assert.equal(entry, null);
});

test('redaction replaces TOKEN in diff', () => {
  const pats = [new RegExp('TOKEN', 'gi')];
  const cap = new DiffCapture(16000, pats);
  const entry = cap.onSave('/test/file.ts', 'const secret = "TOKEN_VALUE";\n');
  assert.ok(entry);
  assert.ok(entry.diff.includes('[REDACTED]'));
  assert.ok(!entry.diff.includes('TOKEN'));
});

test('cap enforced at maxDiffChars', () => {
  const cap = new DiffCapture(100, []);
  const huge = 'x'.repeat(200);
  const entry = cap.onSave('/test/big.ts', huge + '\n');
  assert.ok(entry);
  assert.ok(entry.diff.length <= 120); // 100 + truncation marker + some diff headers
  assert.ok(entry.diff.includes('[truncated]'));
});

test('reset clears state — next save is newFile again', () => {
  const cap = new DiffCapture(16000, []);
  cap.onSave('/test/file.ts', 'line1\n');
  cap.reset();
  const entry = cap.onSave('/test/file.ts', 'line2\n');
  assert.ok(entry);
  assert.equal(entry.newFile, true);
});

test('identical content returns null', () => {
  const cap = new DiffCapture(16000, []);
  cap.onSave('/test/file.ts', 'same\n');
  const entry = cap.onSave('/test/file.ts', 'same\n');
  assert.equal(entry, null);
});

test('LRU cap at 100 paths does not crash', () => {
  const cap = new DiffCapture(16000, []);
  for (let i = 0; i < 110; i++) {
    cap.onSave(`/test/file${i}.ts`, `content${i}\n`);
  }
  // Should not throw; oldest entries evicted
  const entry = cap.onSave('/test/file110.ts', 'new\n');
  assert.ok(entry);
  assert.equal(entry.newFile, true);
});
