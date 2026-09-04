import test from 'node:test';
import assert from 'node:assert/strict';
import { updateActiveSpan } from '../src/core/spans';
import { splitActiveMinutes } from '../src/reporting/spans';
import { Session } from '../src/core/types';

const MIN = 60 * 1000;
const IDLE_GAP = 15 * MIN;

function makeSession(partial: Partial<Session>): Session {
  return {
    id: 't',
    workspaceKey: 'k',
    workspaceName: 'w',
    startedAt: 0,
    lastActivityAt: 0,
    activeMinutes: 0,
    notes: [],
    needsDescription: false,
    events: { edits: 0, saves: 0, terminal: 0, topFiles: [] },
    activeSpans: [],
    activityTs: [],
    ...partial,
  };
}

test('updateActiveSpan opens a span on first activity', () => {
  let open: number | null = null;
  const r = updateActiveSpan(null, 1000, IDLE_GAP, open);
  assert.equal(r.openSpanStart, 1000);
  assert.equal(r.closed, null);
});

test('updateActiveSpan extends the open span on continuous activity', () => {
  let open: number | null = null;
  open = updateActiveSpan(null, 0, IDLE_GAP, open).openSpanStart;
  const r = updateActiveSpan(0, 5 * MIN, IDLE_GAP, open);
  assert.equal(r.closed, null, 'continuous gap closes nothing');
  assert.equal(r.openSpanStart, 0, 'span start preserved');
});

test('updateActiveSpan closes the run after an idle break', () => {
  let open: number | null = null;
  open = updateActiveSpan(null, 0, IDLE_GAP, open).openSpanStart;
  const r = updateActiveSpan(0, 5 * MIN, IDLE_GAP, open);
  open = r.openSpanStart;
  const closed = updateActiveSpan(5 * MIN, 5 * MIN + 20 * MIN, IDLE_GAP, open); // 20 min idle
  assert.deepEqual(closed.closed, { start: 0, end: 5 * MIN }, 'run [0,5m] finalized');
  assert.equal(closed.openSpanStart, 5 * MIN + 20 * MIN, 'new run opens at the event');
});

test('splitActiveMinutes classifies vscode spans by activity at span end', () => {
  const s = makeSession({
    activeMinutes: 2 * MIN,
    activeSpans: [
      { start: 0, end: MIN }, // ends at an activity → vscode
      { start: 2 * MIN, end: 3 * MIN }, // ends at a confirm (no activity) → outside
    ],
    activityTs: [0, MIN, 2 * MIN],
  });
  const bx = splitActiveMinutes(s, IDLE_GAP);
  assert.ok(Math.abs(bx.vscodeMs - MIN) < 1000, `vscode ≈1m, got ${bx.vscodeMs}`);
  assert.ok(Math.abs(bx.outsideMs - MIN) < 1000, `outside ≈1m, got ${bx.outsideMs}`);
});

test('splitActiveMinutes legacy: no spans, reconstruct from activity gaps', () => {
  const s = makeSession({
    activeMinutes: 30 * MIN,
    activityTs: [0, 5 * MIN, 10 * MIN], // 2 gaps of 5 min each → 10 min vscode
  });
  const bx = splitActiveMinutes(s, IDLE_GAP);
  assert.ok(Math.abs(bx.vscodeMs - 10 * MIN) < 1000, `vscode ≈10m, got ${bx.vscodeMs}`);
  assert.ok(Math.abs(bx.outsideMs - 20 * MIN) < 1000, `outside ≈20m, got ${bx.outsideMs}`);
});

test('splitActiveMinutes treats a confirmed idle span as outside', () => {
  // Real activity at t0 and t0+5m; user idle until t0+20m and confirms.
  const s = makeSession({
    activeMinutes: 20 * MIN,
    activeSpans: [
      { start: 0, end: 5 * MIN }, // vscode run
      { start: 5 * MIN, end: 20 * MIN }, // confirmed outside (no activity inside)
    ],
    activityTs: [0, 5 * MIN],
  });
  const bx = splitActiveMinutes(s, IDLE_GAP);
  assert.ok(Math.abs(bx.vscodeMs - 5 * MIN) < 1000, `vscode ≈5m, got ${bx.vscodeMs}`);
  assert.ok(Math.abs(bx.outsideMs - 15 * MIN) < 1000, `outside ≈15m, got ${bx.outsideMs}`);
});

test('updateActiveSpan + splitActiveMinutes round-trip on a 3-event run', () => {
  // Events: t0, t0+5m, t0+30m. First two continuous (<15m), then idle break.
  let open: number | null = null;
  const spans: { start: number; end: number }[] = [];
  open = updateActiveSpan(null, 0, IDLE_GAP, open).openSpanStart;
  let r = updateActiveSpan(0, 5 * MIN, IDLE_GAP, open);
  open = r.openSpanStart;
  r = updateActiveSpan(5 * MIN, 30 * MIN, IDLE_GAP, open);
  if (r.closed) spans.push(r.closed);

  const s = makeSession({
    activeMinutes: 5 * MIN,
    activeSpans: spans,
    activityTs: [0, 5 * MIN, 30 * MIN],
  });
  const bx = splitActiveMinutes(s, IDLE_GAP);
  assert.equal(spans.length, 1, 'only the [0,5m] run is finalized');
  assert.ok(Math.abs(bx.vscodeMs - 5 * MIN) < 1000, `vscode ≈5m, got ${bx.vscodeMs}`);
});