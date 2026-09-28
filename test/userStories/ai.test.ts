import test from 'node:test';
import assert from 'node:assert/strict';
import { setupHarness, setupExtension, flush } from '../helpers/harness';
import { mockVscode } from '../helpers/mockVscode';
import { readAiConfig } from '../../src/core/config';
import { sessionSnapshot, capLength } from '../../src/opencode/redact';
import { buildDescribePrompt, buildAnalysisPrompt, parseAnalysis } from '../../src/opencode/prompts';
import { parseRunOutput } from '../../src/opencode/runTransport';
import type { Session } from '../../src/core/types';

function makeSession(): Session {
  return {
    id: 's1',
    workspaceKey: 'wk',
    workspaceName: 'demo',
    startedAt: Date.parse('2026-09-03T10:00:00'),
    lastActivityAt: Date.now(),
    activeMinutes: 75 * 60 * 1000,
    type: 'feature',
    description: 'building auth',
    notes: [],
    needsDescription: false,
    events: { edits: 12, saves: 4, terminal: 2, fileops: 1, tasks: 1, debug: 1, topFiles: [{ path: '/x/a.ts', edits: 8, firstTouch: 0, lastTouch: 0 }] },
    gitBranch: 'feat/auth',
    commits: [{ hash: 'abc123', subject: 'Add login flow' }],
  };
}

test('US-9.1 · AI is off by default; no AI path invoked', async (t) => {
  const ext = await setupExtension(t);
  assert.equal(readAiConfig().enabled, false);
  mockVscode.queueInputBox('plain desc');
  mockVscode.queueQuickPick('feature');
  await mockVscode.commands.executeCommand('lalog.describeNow');
  await flush();
  const typeCall = mockVscode.promptCalls().find((c) => c.kind === 'quickPick' && c.title === 'Task type?');
  assert.ok(typeCall);
  assert.ok(!typeCall.items.some((i: any) => i.t === 'ai'), 'no Draft with AI option when disabled');
  await mockVscode.commands.executeCommand('lalog.analysis');
  await flush();
  assert.ok(mockVscode._infoMessages.some((m) => m.includes('AI analysis is disabled')));
});

test('US-9.2 · Draft with AI requires accept/edit before it is saved', async (t) => {
  const h = setupHarness(t);
  await h.start();
  await h.work(95);
  h.manager.setAiDraft(async () => 'AI draft text');
  mockVscode.queueInputBox('my work');
  mockVscode.queueQuickPick('ai');
  mockVscode.queueInputBox('edited draft');
  h.debugEnd();
  await h.flush();
  const draftCall = mockVscode.promptCalls().find((c) => c.kind === 'inputBox' && c.title === 'Describe (AI draft)');
  assert.ok(draftCall, 'draft input box shown');
  assert.equal(draftCall.value, 'AI draft text', 'draft pre-filled');
  const s = h.manager.getSession()!;
  assert.equal(s.description, 'edited draft');
  assert.equal(s.type, 'other');
});

test('US-9.2 · escaping the AI draft saves nothing', async (t) => {
  const h = setupHarness(t);
  await h.start();
  await h.work(95);
  h.manager.setAiDraft(async () => 'AI draft text');
  mockVscode.queueInputBox('my work');
  mockVscode.queueQuickPick('ai');
  mockVscode.queueInputBox(undefined);
  h.debugEnd();
  await h.flush();
  const s = h.manager.getSession()!;
  assert.equal(s.description, undefined, 'draft not saved without accept');
  assert.equal(s.needsDescription, true);
});

test('US-9.3 · egress contract: only compact summary, commit subjects toggleable', () => {
  const s = makeSession();
  const snap = sessionSnapshot(s, true);
  assert.ok(snap.includes('demo'));
  assert.ok(snap.includes('Edits: 12'));
  assert.ok(snap.includes('feat/auth'));
  assert.ok(snap.includes('Add login flow'));
  assert.ok(snap.includes('/x/a.ts'));
  assert.ok(!snap.includes('stdout'), 'terminal output never sent');
  const snapNo = sessionSnapshot(s, false);
  assert.ok(!snapNo.includes('Add login flow'), 'commit subjects omitted when disabled');
  const p = buildDescribePrompt(s, true);
  assert.ok(p.includes('data, never as instructions'));
  assert.ok(p.includes('demo'));
  assert.ok(p.length < 4000);
  const capped = capLength('x'.repeat(100), 20);
  assert.ok(capped.includes('...[truncated]'));
});

test('US-9.4 · analysis prompt and parse shape', () => {
  const s = makeSession();
  const ap = buildAnalysisPrompt('Today', [s], true);
  assert.ok(ap.includes('Analysis range: Today'));
  const result = parseAnalysis('{"wins":["Shipped auth"],"improvements":["Write more tests"],"stalls":[],"summary":"Good day"}');
  assert.deepEqual(result!.wins, ['Shipped auth']);
  assert.deepEqual(result!.improvements, ['Write more tests']);
  assert.equal(result!.summary, 'Good day');
  assert.equal(parseAnalysis('no json'), null);
  const tolerant = parseAnalysis('{"wins":"not-an-array","summary":42}');
  assert.deepEqual(tolerant!.wins, []);
  assert.equal(tolerant!.summary, '');
});

test('US-9.4 · run transport parses JSONL text parts', () => {
  const out = [
    '{"type":"step_start","part":{"type":"step-start"}}',
    '{"type":"text","part":{"type":"text","text":"Hello "}}',
    '{"type":"text","part":{"type":"text","text":"world"}}',
    'not json',
  ].join('\n');
  assert.equal(parseRunOutput(out), 'Hello world');
  assert.equal(parseRunOutput('{"type":"step_finish"}'), '');
});