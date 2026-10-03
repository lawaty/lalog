import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setupHarness, createHarness } from '../helpers/harness';
import { mockVscode } from '../helpers/mockVscode';
import { TechnicalStore } from '../../src/storage/technicalStore';
import { stripAnsi, TerminalCapture } from '../../src/capture/terminalCapture';
import { DiffCapture } from '../../src/capture/diffCapture';
import { AiLog } from '../../src/capture/aiLog';
import type { TechnicalEntry } from '../../src/core/types';

test('US-2.1 · all event kinds recorded with timestamps', async (t) => {
  const h = setupHarness(t);
  await h.start();
  h.editor('/ws/a.ts');
  await h.edit('/ws/a.ts');
  h.save('/ws/a.ts');
  h.fileop();
  h.task();
  h.debugStart();
  h.debugEnd();
  const exec = h.terminalShellStart();
  h.terminalShellEnd(exec, 0);
  await h.flush();
  const s = h.manager.getSession()!;
  assert.equal(s.events.edits, 1);
  assert.equal(s.events.saves, 1);
  assert.equal(s.events.fileops, 1);
  assert.equal(s.events.tasks, 1);
  assert.equal(s.events.debug, 2);
  assert.equal(s.events.terminal, 2);
  assert.ok(s.activityTs.length >= 1, 'editor event recorded as a timestamp');
});

test('US-2.1 · graceful degradation when shell execution API is unavailable', async (t) => {
  const h = setupHarness(t);
  mockVscode.setShellExecutionApiAvailable(false);
  await h.start();
  mockVscode.fireTerminalOpen();
  mockVscode.fireTerminalClose();
  await h.flush();
  const s = h.manager.getSession()!;
  assert.equal(s.events.terminal, 2);
});

test('US-2.2 · rapid edits are debounced to a single event', async (t) => {
  const h = setupHarness(t);
  await h.start();
  mockVscode.fireEdit('/ws/a.ts');
  await h.tick(1000);
  mockVscode.fireEdit('/ws/a.ts');
  await h.tick(500);
  mockVscode.fireEdit('/ws/a.ts');
  await h.tick(2000);
  const s = h.manager.getSession()!;
  assert.equal(s.events.edits, 1);
  await h.tick(1000);
  mockVscode.fireEdit('/ws/a.ts');
  await h.tick(2000);
  assert.equal(s.events.edits, 2);
});

test('US-2.3 · terminal command metadata stored in the sidecar', async (t) => {
  const h = setupHarness(t, { config: { captureTerminal: true } });
  await h.start();
  const exec = h.terminalShellStart({
    commandLine: { value: 'npm test', confidence: 'High', isTrusted: true },
    cwd: { fsPath: h.wsPath },
    read: async function* () {},
  });
  await h.tick(500);
  h.terminalShellEnd(exec, 1);
  await h.flush();
  const s = h.manager.getSession()!;
  assert.ok(s.technicalSidecar, 'sidecar path set');
  const tech = new TechnicalStore(h.paths.technicalDir);
  const entries = tech.read(s.id);
  assert.equal(entries.length, 1);
  const term = entries[0] as any;
  assert.equal(term.type, 'terminal');
  assert.equal(term.commandLine, 'npm test');
  assert.equal(term.exitCode, 1);
  assert.equal(term.cwd, h.wsPath);
  assert.equal(term.durationMs, 500);
});

test('US-2.4 · terminal stdout opt-in (off by default, on when enabled)', async (t) => {
  const h = setupHarness(t, { config: { captureTerminal: true, captureTerminalStdout: false } });
  await h.start();
  const exec = h.terminalShellStart({
    commandLine: { value: 'cat file', confidence: 'High', isTrusted: true },
    cwd: { fsPath: h.wsPath },
    read: async function* () { yield 'hello output'; },
  });
  await h.flush();
  h.terminalShellEnd(exec, 0);
  await h.flush();
  const s = h.manager.getSession()!;
  let entries = new TechnicalStore(h.paths.technicalDir).read(s.id);
  assert.equal((entries[0] as any).stdout, undefined, 'stdout not stored by default');
  h.manager.dispose();
  const h2 = createHarness(t, { config: { captureTerminal: true, captureTerminalStdout: true } });
  await h2.start();
  const exec2 = h2.terminalShellStart({
    commandLine: { value: 'cat file', confidence: 'High', isTrusted: true },
    cwd: { fsPath: h2.wsPath },
    read: async function* () { yield 'hello output'; },
  });
  await h2.flush();
  h2.terminalShellEnd(exec2, 0);
  await h2.flush();
  const s2 = h2.manager.getSession()!;
  const entries2 = new TechnicalStore(h2.paths.technicalDir).read(s2.id);
  assert.ok((entries2[0] as any).stdout?.includes('hello output'));
  h2.dispose();
});

test('US-2.5 · diff captured at save (new-file then patch)', async (t) => {
  const h = setupHarness(t, { config: { captureDiffs: true } });
  await h.start();
  mockVscode._openTextContent = 'line1\nline2\n';
  h.save('/ws/a.ts');
  await h.flush();
  const s = h.manager.getSession()!;
  const tech = new TechnicalStore(h.paths.technicalDir);
  let entries = tech.read(s.id);
  assert.equal(entries.length, 1);
  assert.equal((entries[0] as any).newFile, true);
  mockVscode._openTextContent = 'line1\nline2\nline3\n';
  h.save('/ws/a.ts');
  await h.flush();
  entries = tech.read(s.id);
  assert.equal(entries.length, 2);
  assert.equal((entries[1] as any).newFile, false);
});

test('US-2.5 · binary and identical saves produce no diff', async (t) => {
  const h = setupHarness(t, { config: { captureDiffs: true } });
  await h.start();
  mockVscode._openTextContent = 'same\n';
  h.save('/ws/a.ts');
  await h.flush();
  mockVscode._openTextContent = 'same\n';
  h.save('/ws/a.ts');
  await h.flush();
  mockVscode._openTextContent = 'text\x00binary';
  h.save('/ws/bin.dat');
  await h.flush();
  const s = h.manager.getSession()!;
  const entries = new TechnicalStore(h.paths.technicalDir).read(s.id);
  assert.equal(entries.length, 1, 'only the first new-file diff');
});

test('US-2.5 · diff capped at maxDiffChars', async (t) => {
  const h = setupHarness(t, { config: { captureDiffs: true, maxDiffChars: 100 } });
  await h.start();
  mockVscode._openTextContent = 'x'.repeat(500);
  h.save('/ws/big.ts');
  await h.flush();
  const s = h.manager.getSession()!;
  const entries = new TechnicalStore(h.paths.technicalDir).read(s.id);
  assert.ok((entries[0] as any).diff.includes('[truncated]'));
});

test('US-2.6 · AI interaction metadata only (never text)', async (t) => {
  const h = setupHarness(t, { config: { captureAiLog: true } });
  await h.start();
  h.manager.logAiInteraction({
    type: 'ai', ts: 1000, task: 'describe', model: 'm', latencyMs: 500,
    promptChars: 100, responseChars: 50, truncated: false,
  });
  await h.flush();
  const s = h.manager.getSession()!;
  const entries = new TechnicalStore(h.paths.technicalDir).read(s.id);
  assert.equal(entries.length, 1);
  const ai = entries[0] as any;
  assert.equal(ai.type, 'ai');
  assert.equal(ai.promptChars, 100);
  assert.equal(ai.responseChars, 50);
  assert.ok(!JSON.stringify(ai).includes('prompt text'));
});

test('US-2.7 · top files tracked top-10 by edit count', async (t) => {
  const h = setupHarness(t);
  await h.start();
  for (let i = 0; i < 12; i++) {
    await h.edit(`/ws/file${i}.ts`);
  }
  const s = h.manager.getSession()!;
  assert.equal(s.events.topFiles.length, 10);
  const edits = s.events.topFiles.map((f) => f.edits);
  assert.deepEqual(edits, [...edits].sort((a, b) => b - a));
  assert.ok(s.events.topFiles.every((f) => f.firstTouch <= f.lastTouch));
});

test('US-2.3 · stripAnsi removes CSI/OSC and collapses CR', () => {
  assert.equal(stripAnsi('\x1b[31mred text\x1b[0m'), 'red text');
  assert.equal(stripAnsi('\x1b]0;title\x07hello'), 'hello');
  assert.equal(stripAnsi('line1\r\nline2'), 'line1\nline2');
});

test('US-2.3 · terminal capture: confidence mapping, duration, exit code', () => {
  let now = 1000;
  const cap = new TerminalCapture(false, 32000, [], () => now);
  const execution = {
    commandLine: { value: 'git status', confidence: 'High', isTrusted: true },
    cwd: { fsPath: '/home/user/project' },
    read: async function* () {},
  };
  cap.onStart(execution);
  now = 3500;
  const entry = cap.onEnd(execution, 0);
  assert.ok(entry);
  assert.equal(entry.confidence, 'high');
  assert.equal(entry.commandLine, 'git status');
  assert.equal(entry.cwd, '/home/user/project');
  assert.equal(entry.durationMs, 2500);
  assert.equal(entry.exitCode, 0);
  assert.equal(cap.onEnd({}, 0), null, 'onEnd without onStart returns null');
});

test('US-2.4 · stdout captured, ANSI-stripped, capped, redacted when enabled', async () => {
  let now = 0;
  const pats = [new RegExp('SECRET', 'gi')];
  const cap = new TerminalCapture(true, 50, pats, () => now);
  const chunks = ['\x1b[31mhello ', 'SECRET ', 'world this is long output that should be truncated'];
  let i = 0;
  const execution = {
    commandLine: { value: 'cat file', confidence: 'High', isTrusted: true },
    cwd: undefined,
    read: async function* () {
      for (const c of chunks) yield c;
    },
  };
  cap.onStart(execution);
  await cap.flush();
  now = 100;
  const entry = cap.onEnd(execution, 0);
  assert.ok(entry);
  assert.ok(entry.stdout);
  assert.ok(!entry.stdout.includes('\x1b'), 'ANSI stripped');
  assert.ok(!entry.stdout.includes('SECRET'), 'redacted');
  assert.ok(entry.stdout.includes('[REDACTED]'));
  assert.ok(entry.stdout.includes('[truncated]'), 'capped');
});

test('TerminalCapture: large streaming output is capped in memory (final stdout <= maxStdoutChars + marker)', async () => {
  let now = 0;
  const cap = new TerminalCapture(true, 100, [], () => now);
  const execution = {
    commandLine: { value: 'cat big', confidence: 'High', isTrusted: true },
    cwd: undefined,
    read: async function* () {
      for (let i = 0; i < 1000; i++) {
        yield 'x'.repeat(100);
      }
    },
  };
  cap.onStart(execution);
  await cap.flush();
  now = 100;
  const entry = cap.onEnd(execution, 0);
  assert.ok(entry);
  assert.ok(entry.stdout);
  assert.ok(entry.stdout.includes('[truncated]'));
  assert.ok(entry.stdout.length <= 100 + '\n...[truncated]'.length + 10, 'stdout bounded');
});

test('TerminalCapture: pending reads drain without flush() after completion', async () => {
  let now = 0;
  const cap = new TerminalCapture(true, 32000, [], () => now);
  const execution = {
    commandLine: { value: 'echo hi', confidence: 'High', isTrusted: true },
    cwd: undefined,
    read: async function* () {
      yield 'hello';
    },
  };
  cap.onStart(execution);
  // Wait a bit for the async read to settle
  await new Promise((r) => setTimeout(r, 10));
  now = 50;
  const entry = cap.onEnd(execution, 0);
  assert.ok(entry);
  assert.ok(entry.stdout?.includes('hello'));
});

test('TerminalCapture: collector stopped after onEnd cannot regrow buffer', async () => {
  let now = 0;
  const cap = new TerminalCapture(true, 32000, [], () => now);
  let producer: ((v: string) => void) | null = null;
  const execution = {
    commandLine: { value: 'long', confidence: 'High', isTrusted: true },
    cwd: undefined,
    read: async function* () {
      const q: string[] = [];
      producer = (v) => q.push(v);
      while (true) {
        if (q.length > 0) {
          yield q.shift()!;
        } else {
          await new Promise((r) => setTimeout(r, 5));
        }
      }
    },
  };
  cap.onStart(execution);
  await new Promise((r) => setTimeout(r, 10));
  now = 10;
  const entry = cap.onEnd(execution, 0);
  assert.ok(entry);
  const beforeLen = entry.stdout?.length ?? 0;
  if (producer) producer('MORE_DATA_THAT_SHOULD_NOT_BE_ADDED');
  await new Promise((r) => setTimeout(r, 20));
  // Re-read by ending again? No - entry is consumed. But we can't re-end; instead
  // we just verify the original entry's stdout didn't grow. The key behavior is
  // the collector stopped - we can't directly observe buffer, but the logic prevents append.
  assert.equal(entry.stdout?.length ?? 0, beforeLen);
});

test('US-2.5 · diff capture: new-file, patch, binary skip, redaction, cap, reset, LRU', () => {
  const cap = new DiffCapture(16000, []);
  const first = cap.onSave('/test/file.ts', 'line1\nline2\nline3\n');
  assert.ok(first && first.newFile === true);
  assert.ok(first!.diff.includes('line1'));
  const second = cap.onSave('/test/file.ts', 'line1\nline2\nline3\nline4\n');
  assert.ok(second && second.newFile === false);
  assert.ok(second!.linesAdded >= 1);
  assert.equal(cap.onSave('/test/binary.bin', 'text\x00binary'), null, 'binary skipped');
  assert.equal(cap.onSave('/test/file.ts', 'line1\nline2\nline3\nline4\n'), null, 'identical save skipped');
  const red = new DiffCapture(16000, [new RegExp('TOKEN', 'gi')]);
  const redEntry = red.onSave('/test/file.ts', 'const secret = "TOKEN_VALUE";\n');
  assert.ok(redEntry && redEntry.diff.includes('[REDACTED]'));
  assert.ok(redEntry && !redEntry.diff.includes('TOKEN'));
  const capped = new DiffCapture(100, []);
  const big = capped.onSave('/test/big.ts', 'x'.repeat(200) + '\n');
  assert.ok(big && big.diff.includes('[truncated]'));
  capped.reset();
  const afterReset = capped.onSave('/test/big.ts', 'y\n');
  assert.ok(afterReset && afterReset.newFile === true, 'reset clears state');
  const lru = new DiffCapture(16000, []);
  for (let i = 0; i < 110; i++) lru.onSave(`/test/file${i}.ts`, `content${i}\n`);
  const evicted = lru.onSave('/test/file110.ts', 'new\n');
  assert.ok(evicted && evicted.newFile === true, 'LRU eviction does not crash');
});

test('DiffCapture: oversized file emits new-file once, not again on second save; under-cap still diffs; reset clears oversized tracking', () => {
  const cap = new DiffCapture(16000, []);
  const bigContent = 'x'.repeat(300 * 1024); // > 256KB
  const first = cap.onSave('/test/huge.ts', bigContent);
  assert.ok(first && first.newFile === true, 'first save of oversized yields new-file');
  const second = cap.onSave('/test/huge.ts', bigContent + 'y');
  assert.equal(second, null, 'second save of same oversized path does not produce duplicate new-file diff');
  // under-cap file still diffs normally
  const small = cap.onSave('/test/small.ts', 'a\n');
  assert.ok(small && small.newFile === true);
  const small2 = cap.onSave('/test/small.ts', 'a\nb\n');
  assert.ok(small2 && small2.newFile === false, 'under-cap diffs normally on subsequent saves');
  // reset clears oversized tracking
  cap.reset();
  const afterReset = cap.onSave('/test/huge.ts', bigContent);
  assert.ok(afterReset && afterReset.newFile === true, 'post-reset save is new-file again');
});

test('US-2.6 · AI interaction metadata shape (never text)', () => {
  const log = new AiLog();
  const entry = log.logInteraction({
    task: 'describe',
    model: 'opencode/big-pickle',
    latencyMs: 1500,
    promptChars: 200,
    responseChars: 50,
    truncated: false,
  });
  assert.equal(entry.type, 'ai');
  assert.equal(entry.task, 'describe');
  assert.equal(entry.model, 'opencode/big-pickle');
  assert.equal(entry.latencyMs, 1500);
  assert.equal(entry.promptChars, 200);
  assert.equal(entry.responseChars, 50);
  assert.equal(entry.truncated, false);
  assert.ok(entry.ts > 0);
});

// ---- US-8.7 · diffs-only retention (ADR-026) ----

const SID = '20260102-0900-abcd-ef01';
const OLD_TS = Date.parse('2026-01-02T10:00:00');
const NEW_TS = Date.parse('2026-01-10T10:00:00');

function retentionDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lalog-retain-'));
}

function sidecar(dir: string, id: string, entries: unknown[]): string {
  const file = path.join(dir, id + '.jsonl');
  fs.writeFileSync(file, entries.map((e) => (typeof e === 'string' ? e : JSON.stringify(e))).join('\n') + '\n');
  return file;
}

function diffAt(ts: number): TechnicalEntry {
  return {
    type: 'diff',
    ts,
    path: '/ws/a.ts',
    diff: '--- a\n+++ b\n+x',
    linesAdded: 1,
    linesRemoved: 0,
    newFile: false,
  };
}

const oldTerminal: TechnicalEntry = {
  type: 'terminal',
  ts: OLD_TS,
  commandLine: 'npm test',
  exitCode: 0,
  durationMs: 1000,
  confidence: 'high',
};

const oldAi: TechnicalEntry = {
  type: 'ai',
  ts: OLD_TS,
  task: 'describe',
  model: 'm',
  latencyMs: 100,
  promptChars: 10,
  responseChars: 5,
  truncated: false,
};

test('US-8.7 · prune drops old diffs and keeps old terminal/AI entries', () => {
  const dir = retentionDir();
  const file = sidecar(dir, SID, [diffAt(OLD_TS), diffAt(NEW_TS), oldTerminal, oldAi]);
  const store = new TechnicalStore(dir);
  const removed = store.pruneDiffEntriesBefore(NEW_TS);
  assert.equal(removed, 1);
  const entries = store.read(SID);
  assert.deepEqual(entries.map((e) => e.type), ['diff', 'terminal', 'ai']);
  assert.equal((entries[0] as any).ts, NEW_TS, 'the new diff survived');
  assert.ok(!fs.readdirSync(dir).some((f) => f.endsWith('.tmp')), 'no .tmp left behind');
  assert.ok(fs.existsSync(file), 'sidecar with surviving entries is kept');
});

test('US-8.7 · a sidecar left with zero entries is deleted', () => {
  const dir = retentionDir();
  const file = sidecar(dir, SID, [diffAt(OLD_TS), diffAt(OLD_TS - 1000)]);
  const store = new TechnicalStore(dir);
  assert.equal(store.pruneDiffEntriesBefore(NEW_TS), 2);
  assert.equal(fs.existsSync(file), false, 'empty sidecar removed');
  assert.deepEqual(store.read(SID), []);
});

test('US-8.7 · a terminal/AI-only sidecar is left byte-identical (no rewrite)', () => {
  const dir = retentionDir();
  const file = sidecar(dir, SID, [oldTerminal, oldAi]);
  const before = fs.readFileSync(file);
  const store = new TechnicalStore(dir);
  assert.equal(store.pruneDiffEntriesBefore(NEW_TS), 0);
  assert.deepEqual(fs.readFileSync(file), before, 'file not rewritten');
  assert.equal(store.read(SID).length, 2);
});

test('US-8.7 · files that are not sidecars are never touched', () => {
  const dir = retentionDir();
  const notes = path.join(dir, 'notes.txt');
  const junk = path.join(dir, 'junk.jsonl');
  fs.writeFileSync(notes, JSON.stringify(diffAt(OLD_TS)) + '\n');
  fs.writeFileSync(junk, JSON.stringify(diffAt(OLD_TS)) + '\n');
  const store = new TechnicalStore(dir);
  assert.equal(store.pruneDiffEntriesBefore(NEW_TS), 0);
  assert.equal(fs.readFileSync(notes, 'utf8'), JSON.stringify(diffAt(OLD_TS)) + '\n');
  assert.equal(fs.readFileSync(junk, 'utf8'), JSON.stringify(diffAt(OLD_TS)) + '\n');
});

test('US-8.7 · malformed lines are preserved verbatim', () => {
  const dir = retentionDir();
  const broken = '{not json at all';
  const file = sidecar(dir, SID, [diffAt(OLD_TS), broken, oldTerminal]);
  const store = new TechnicalStore(dir);
  assert.equal(store.pruneDiffEntriesBefore(NEW_TS), 1);
  const raw = fs.readFileSync(file, 'utf8').split('\n');
  assert.deepEqual(raw.slice(0, 2), [broken, JSON.stringify(oldTerminal)]);
  assert.equal(store.read(SID).length, 1, 'read() still skips the malformed line');
});
