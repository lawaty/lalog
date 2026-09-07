import test from 'node:test';
import assert from 'node:assert/strict';
import { TerminalCapture, stripAnsi } from '../src/capture/terminalCapture';

test('stripAnsi removes CSI sequences', () => {
  const text = '\x1b[31mred text\x1b[0m';
  assert.equal(stripAnsi(text), 'red text');
});

test('stripAnsi removes OSC sequences', () => {
  const text = '\x1b]0;title\x07hello';
  assert.equal(stripAnsi(text), 'hello');
});

test('stripAnsi collapses carriage returns', () => {
  const text = 'line1\r\nline2';
  assert.equal(stripAnsi(text), 'line1\nline2');
});

test('confidence mapping from VS Code enum', () => {
  let now = 1000;
  const cap = new TerminalCapture(false, 32000, [], () => now);

  const execution = {
    commandLine: { value: 'git status', confidence: 'High', isTrusted: true },
    cwd: { fsPath: '/home/user/project' },
    read: async function* () { yield ''; },
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
});

test('duration computed from injected timestamps', () => {
  let now = 100;
  const cap = new TerminalCapture(false, 32000, [], () => now);

  const execution = {
    commandLine: { value: 'ls', confidence: 'Low', isTrusted: true },
    cwd: undefined,
    read: async function* () { yield ''; },
  };

  cap.onStart(execution);
  now = 2100;
  const entry = cap.onEnd(execution, undefined);
  assert.ok(entry);
  assert.equal(entry.durationMs, 2000);
  assert.equal(entry.exitCode, null);
  assert.equal(entry.cwd, undefined);
  assert.equal(entry.confidence, 'low');
});

test('stdout absent when captureStdout is false', () => {
  let now = 0;
  const cap = new TerminalCapture(false, 32000, [], () => now);

  const execution = {
    commandLine: { value: 'echo hi', confidence: 'High', isTrusted: true },
    cwd: undefined,
    read: async function* () { yield 'hello output'; },
  };

  cap.onStart(execution);
  now = 100;
  const entry = cap.onEnd(execution, 0);
  assert.ok(entry);
  assert.equal(entry.stdout, undefined);
});

test('stdout captured and capped when captureStdout is true', async () => {
  let now = 0;
  const cap = new TerminalCapture(true, 50, [], () => now);

  const chunks = ['hello ', 'world ', 'this is long output that should be truncated'];
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
  assert.ok(entry.stdout.length <= 70); // 50 + truncation marker
  assert.ok(entry.stdout.includes('[truncated]'));
});

test('stdout redacted when patterns match', async () => {
  let now = 0;
  const pats = [new RegExp('SECRET', 'gi')];
  const cap = new TerminalCapture(true, 32000, pats, () => now);

  const execution = {
    commandLine: { value: 'echo SECRET', confidence: 'High', isTrusted: true },
    cwd: undefined,
    read: async function* () { yield 'output with SECRET value'; },
  };

  cap.onStart(execution);
  await cap.flush();
  now = 100;
  const entry = cap.onEnd(execution, 0);
  assert.ok(entry);
  assert.ok(entry.stdout);
  assert.ok(entry.stdout.includes('[REDACTED]'));
  assert.ok(!entry.stdout.includes('SECRET'));
});

test('clearInFlight discards pending executions', () => {
  let now = 0;
  const cap = new TerminalCapture(false, 32000, [], () => now);

  const execution = {
    commandLine: { value: 'long-running', confidence: 'High', isTrusted: true },
    cwd: undefined,
    read: async function* () { yield ''; },
  };

  cap.onStart(execution);
  cap.clearInFlight();
  now = 100;
  const entry = cap.onEnd(execution, 0);
  assert.equal(entry, null);
});

test('onEnd without matching onStart returns null', () => {
  const cap = new TerminalCapture(false, 32000, []);
  const entry = cap.onEnd({}, 0);
  assert.equal(entry, null);
});
