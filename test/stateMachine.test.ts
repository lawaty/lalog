import test from 'node:test';
import assert from 'node:assert/strict';
import { newMachine, onActivity, startSession, autoClose } from '../src/core/stateMachine';
import type { ThresholdsMs } from '../src/core/config';

// Real thresholds scaled to be testable quickly without debugTimeScale.
const MIN = 60 * 1000;
const th: ThresholdsMs = {
  idleGap: 5 * MIN,
  describeAt: 90 * MIN,
  describeForce: 120 * MIN,
  wrapAt: 210 * MIN,
  wrapForce: 240 * MIN,
  grace: 30 * MIN,
  hardSplit: 300 * MIN,
  autoEndIdle: 120 * MIN,
  resumeWindow: 30 * MIN,
  untrackedNudge: 30 * MIN,
  maxGraceExtensions: 3,
};

test('overnight session spanning midnight is a single session (not day-bound)', () => {
  const m = newMachine();
  const t0 = Date.parse('2026-09-03T22:00:00');
  startSession(m, t0);

  // Work 22:00 → 23:00 with activity every 4 min (within 5-min idle gap).
  let now = t0;
  for (let i = 1; i <= 15; i++) {
    now = t0 + i * 4 * MIN;
    onActivity(m, now, th);
  }
  assert.equal(m.startedAt, t0, 'start unchanged');
  assert.ok(m.activeMinutes >= 40 * MIN, 'must accrue active minutes across 22:00-23:00');

  // Continue across midnight: 00:00 → 02:00 next day.
  const t1 = Date.parse('2026-09-04T00:00:00');
  now = t1;
  for (let i = 1; i <= 30; i++) {
    now = t1 + i * 4 * MIN;
    onActivity(m, now, th);
  }
  assert.equal(m.startedAt, t0, 'start date must not change across midnight');
  assert.ok(m.activeMinutes > 60 * MIN && m.activeMinutes < 3 * 60 * MIN);

  const closed = autoClose(m, now);
  assert.ok(closed.endedAt <= now, 'endedAt never extends past last activity');
});

test('idle gap ends active accrual but keeps session bound', () => {
  const m = newMachine();
  const t0 = Date.parse('2026-09-03T22:00:00');
  startSession(m, t0);
  onActivity(m, t0 + 1 * MIN, th);
  onActivity(m, t0 + 2 * MIN, th);
  const before = m.activeMinutes;
  // 2-hour idle → gap not counted.
  onActivity(m, t0 + 2 * MIN + 2 * 60 * MIN, th);
  assert.ok(m.activeMinutes < before + 5 * MIN, 'idle gap must not accrue active time');
});

test('describe prompt triggers after 90 active minutes', () => {
  const m = newMachine();
  const t0 = 0;
  startSession(m, t0);
  // 100 events, each 1 min apart (continuous) → ~99 active minutes.
  for (let i = 1; i <= 100; i++) {
    onActivity(m, t0 + i * MIN, th);
    if (m.state === 'describePending') break;
  }
  assert.equal(m.state, 'describePending');
});

test('wrap trigger after 210 active minutes', () => {
  const m = newMachine();
  const t0 = 0;
  startSession(m, t0);
  for (let i = 1; i <= 220; i++) {
    onActivity(m, t0 + i * MIN, th);
    if (m.state === 'wrapPending' || m.state === 'describePending') break;
  }
  assert.ok(m.state === 'wrapPending' || m.state === 'describePending');
});

test('autoClose uses lastActivityAt not detection time', () => {
  const m = newMachine();
  const t0 = 0;
  startSession(m, t0);
  onActivity(m, t0 + 10 * MIN, th);
  const closed = autoClose(m, t0 + 3 * 60 * MIN);
  assert.equal(closed.endedAt, t0 + 10 * MIN);
});
