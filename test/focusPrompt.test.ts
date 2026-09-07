import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldPromptOnFocusLost } from '../src/core/focusPrompt';
import type { Session, SessionState } from '../src/core/types';

const MIN = 60 * 1000;

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: 's1',
    workspaceKey: 'ws',
    workspaceName: 'ws',
    startedAt: Date.now() - 2 * 60 * MIN,
    lastActivityAt: Date.now() - MIN,
    activeMinutes: 95 * MIN,
    notes: [],
    needsDescription: false,
    events: { edits: 1, saves: 0, terminal: 0, fileops: 0, tasks: 0, debug: 0, topFiles: [] },
    activeSpans: [],
    activityTs: [],
    ...overrides,
  };
}

test('prompts when a description is due (describePending) and none exists', () => {
  assert.equal(shouldPromptOnFocusLost(session(), 'describePending', false), true);
});

test('never prompts without a session', () => {
  assert.equal(shouldPromptOnFocusLost(null, 'describePending', false), false);
});

test('never prompts when the cooldown already fired for this window', () => {
  assert.equal(shouldPromptOnFocusLost(session(), 'describePending', true), false);
});

test('never prompts for background (anonymous) sessions', () => {
  assert.equal(shouldPromptOnFocusLost(session({ anonymous: true }), 'describePending', false), false);
});

test('never prompts once a description exists', () => {
  assert.equal(
    shouldPromptOnFocusLost(session({ description: 'did a thing' }), 'describePending', false),
    false
  );
});

test('never prompts outside the describe-due state (active/grace/wrapPending/idle)', () => {
  for (const state of ['active', 'wrapPending', 'grace', 'idle']) {
    assert.equal(
      shouldPromptOnFocusLost(session(), state as SessionState, false),
      false,
      `expected no prompt in ${state}`
    );
  }
});