import test from 'node:test';
import assert from 'node:assert/strict';
import { trimToCutoff } from '../src/core/spans';
import { ActiveSpan } from '../src/core/types';

const MIN = 60_000;

// ── span capping ──────────────────────────────────────────────────────

test('span extending past until is capped at until', () => {
  const closed: ActiveSpan[] = [{ start: 0, end: 10 * MIN }];
  const r = trimToCutoff(closed, null, 10 * MIN, 10 * MIN, [], 5 * MIN);
  assert.equal(r.closedSpans.length, 1);
  assert.deepEqual(r.closedSpans[0], { start: 0, end: 5 * MIN });
  assert.equal(r.activeMinutes, 5 * MIN);
});

// ── span fully after until ────────────────────────────────────────────

test('span fully after until is dropped', () => {
  const closed: ActiveSpan[] = [
    { start: 0, end: 3 * MIN },
    { start: 6 * MIN, end: 9 * MIN },
  ];
  const r = trimToCutoff(closed, null, 9 * MIN, 6 * MIN, [], 5 * MIN);
  assert.equal(r.closedSpans.length, 1);
  assert.deepEqual(r.closedSpans[0], { start: 0, end: 3 * MIN });
  assert.equal(r.activeMinutes, 3 * MIN);
});

// ── open span closed at until ─────────────────────────────────────────

test('open span is closed at min(lastActivityAt, until)', () => {
  const r = trimToCutoff(
    [],
    2 * MIN,            // openSpanStart
    8 * MIN,            // lastActivityAt
    8 * MIN,            // activeMinutes (not used for recalc)
    [2 * MIN, 4 * MIN, 6 * MIN, 8 * MIN],
    5 * MIN,            // until
  );
  assert.equal(r.closedSpans.length, 1);
  assert.deepEqual(r.closedSpans[0], { start: 2 * MIN, end: 5 * MIN });
  assert.equal(r.activeMinutes, 3 * MIN);
  assert.equal(r.openSpanStart, null);
  assert.deepEqual(r.activityTs, [2 * MIN, 4 * MIN]);
});

test('open span uses lastActivityAt when it is before until', () => {
  const r = trimToCutoff(
    [],
    2 * MIN,            // openSpanStart
    4 * MIN,            // lastActivityAt (before until)
    4 * MIN,
    [2 * MIN, 4 * MIN],
    8 * MIN,            // until
  );
  assert.equal(r.closedSpans.length, 1);
  assert.deepEqual(r.closedSpans[0], { start: 2 * MIN, end: 4 * MIN });
  assert.equal(r.activeMinutes, 2 * MIN);
});

// ── activeMinutes recomputation ───────────────────────────────────────

test('activeMinutes equals sum of trimmed spans (mixed case)', () => {
  const closed: ActiveSpan[] = [
    { start: 0, end: 3 * MIN },
    { start: 4 * MIN, end: 9 * MIN },
  ];
  const r = trimToCutoff(closed, 9 * MIN, 12 * MIN, 11 * MIN, [], 7 * MIN);
  // Expected spans: [0,3m] + [4m,7m] (capped) + open [9m,7m] → no, 9 >= 7 so dropped
  // Actually: [0,3m] kept as-is; [4m,9m] → [4m,7m]; open at 9m but 9 >= 7 so dropped
  assert.equal(r.closedSpans.length, 2);
  assert.deepEqual(r.closedSpans[0], { start: 0, end: 3 * MIN });
  assert.deepEqual(r.closedSpans[1], { start: 4 * MIN, end: 7 * MIN });
  assert.equal(r.activeMinutes, 3 * MIN + 3 * MIN);
});

// ── exact no-op ───────────────────────────────────────────────────────

test('no-op when everything is already before until', () => {
  const closed: ActiveSpan[] = [
    { start: 0, end: 2 * MIN },
    { start: 3 * MIN, end: 5 * MIN },
  ];
  const r = trimToCutoff(
    closed,
    null,
    5 * MIN,
    4 * MIN,
    [0, 2 * MIN, 3 * MIN, 5 * MIN],
    10 * MIN,           // well past everything
  );
  assert.deepEqual(r.closedSpans, closed);
  assert.equal(r.activeMinutes, 4 * MIN);
  assert.deepEqual(r.activityTs, [0, 2 * MIN, 3 * MIN, 5 * MIN]);
});

// ── openSpanStart at or after until ──────────────────────────────────

test('open span starting at until is not counted', () => {
  const r = trimToCutoff([], 5 * MIN, 8 * MIN, 3 * MIN, [5 * MIN, 8 * MIN], 5 * MIN);
  assert.equal(r.closedSpans.length, 0);
  assert.equal(r.activeMinutes, 0);
  assert.equal(r.openSpanStart, null);
});

// ── edge: empty inputs ────────────────────────────────────────────────

test('empty spans and null openSpanStart returns zeros', () => {
  const r = trimToCutoff([], null, 0, 0, [], 1000);
  assert.deepEqual(r.closedSpans, []);
  assert.equal(r.openSpanStart, null);
  assert.equal(r.activeMinutes, 0);
  assert.deepEqual(r.activityTs, []);
});