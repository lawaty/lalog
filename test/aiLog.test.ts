import test from 'node:test';
import assert from 'node:assert/strict';
import { AiLog } from '../src/capture/aiLog';

test('logInteraction produces correct shape', () => {
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

test('truncated passthrough', () => {
  const log = new AiLog();
  const entry = log.logInteraction({
    task: 'narrative',
    model: 'test-model',
    latencyMs: 500,
    promptChars: 100,
    responseChars: 6000,
    truncated: true,
  });
  assert.equal(entry.truncated, true);
});
