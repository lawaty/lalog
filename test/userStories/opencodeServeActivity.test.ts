// test/userStories/opencodeServeActivity.test.ts
import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ServeWatcher } from '../../src/opencode/serveWatcher';
import type { ServeLifecycle } from '../../src/opencode/serveWatcher';
import type { DiscoveredServe, ExitInfo, OwnedServe, SpawnOptions } from '../../src/opencode/serveProcess';
import { opencodePollMs, opencodeSlowPollMs, opencodeDiscoveryMs, thresholdsMs, readOpencodeActivityConfig } from '../../src/core/config';
import type { OpencodeActivityConfig } from '../../src/core/config';
import { SessionStore } from '../../src/storage/sessionStore';
import { mockVscode } from '../helpers/mockVscode';
import {
  BASE_TIME,
  defaultConfig,
  flush,
  setupExtension,
  setupHarness,
  waitFor,
} from '../helpers/harness';

const POLL_MS = 1000;
const ROOT = '/ws/app';
const OTHER_ROOT = '/ws/other';

/**
 * `time.updated` values here are epoch ms against the *mocked* clock, which
 * starts at `BASE_TIME`. The watcher skips a tracked session whose `time.updated`
 * is older than one discovery window, so a "recent" session must actually look
 * recent to `BASE_TIME` — otherwise the freshness skip (correctly) means it is
 * never re-fetched and the tick under test never happens.
 */
const RECENT = BASE_TIME;
const BUMPED = BASE_TIME + 1000;

/** One `GET /session` entry, shaped like opencode's own metadata. */
function entry(id: string, directory: string, updated: number, title = 'chat'): unknown {
  return {
    id,
    directory,
    title,
    agent: 'build',
    model: 'opencode/x',
    time: { created: updated - 1000, updated },
  };
}

interface FakeReply {
  status?: number;
  body?: unknown;
  error?: Error;
}

/** `/session/{id}` — the per-session endpoint; null for the full list. */
function singleSessionId(url: string): string | null {
  const m = /\/session\/([^/?#]+)$/.exec(url);
  return m ? decodeURIComponent(m[1]) : null;
}

/**
 * Injected fetch: never touches the network, just replays scripted replies.
 * `reply(call)` is consulted per request, so the script keeps counting requests
 * in order — which is also what the request-mix tests assert on.
 *
 * The URL decides the payload shape, exactly as the real server does: `/session`
 * answers the whole scripted list, `/session/{id}` answers the one entry with
 * that id, and 404 when the script no longer has it (a deleted session).
 */
function fakeFetch(reply: (call: number) => FakeReply): {
  fetchImpl: typeof fetch;
  urls: string[];
  calls: () => number;
} {
  const urls: string[] = [];
  const impl = async (url: string) => {
    const target = String(url);
    const id = singleSessionId(target);
    const r = reply(urls.length);
    urls.push(target);
    if (r.error) throw r.error;
    const status = r.status ?? 200;
    const ok = status >= 200 && status < 300;
    if (id !== null && ok && Array.isArray(r.body)) {
      const found = r.body.find(
        (e): e is Record<string, unknown> =>
          !!e && typeof e === 'object' && (e as { id?: unknown }).id === id
      );
      if (!found) return { ok: false, status: 404, json: async () => ({ error: 'not found' }) };
      return { ok: true, status, json: async () => found };
    }
    return { ok, status, json: async () => r.body };
  };
  return { fetchImpl: impl as unknown as typeof fetch, urls, calls: () => urls.length };
}

interface WatcherHarness {
  w: ServeWatcher;
  events: number[];
  warnings: string[];
  calls: () => number;
  urls: string[];
}

interface WatcherExtras {
  roots?: string[];
  pollMs?: number;
  slowMs?: number;
  discoveryMs?: number;
  shouldObserve?: () => boolean;
  manageServe?: boolean;
  opencodePath?: string;
  spawnPort?: number;
  lifecycle?: ServeLifecycle;
}

function makeWatcher(
  reply: (call: number) => FakeReply,
  opts: WatcherExtras = {}
): WatcherHarness {
  const fake = fakeFetch(reply);
  const events: number[] = [];
  const warnings: string[] = [];
  const w = new ServeWatcher({
    url: 'http://127.0.0.1:4096',
    pollMs: opts.pollMs ?? POLL_MS,
    slowMs: opts.slowMs,
    discoveryMs: opts.discoveryMs,
    roots: opts.roots ?? [ROOT],
    shouldObserve: opts.shouldObserve,
    manageServe: opts.manageServe,
    opencodePath: opts.opencodePath,
    spawnPort: opts.spawnPort,
    lifecycle: opts.lifecycle,
    onActivity: (now) => events.push(now),
    log: (m) => warnings.push(m),
    fetchImpl: fake.fetchImpl,
  });
  return { w, events, warnings, calls: fake.calls, urls: fake.urls };
}

/**
 * A lifecycle whose three calls are recorded instead of performed: no process is
 * ever spawned, no pid is ever signalled, and no server is ever contacted.
 */
function fakeLifecycle(
  opts: {
    discovered?: DiscoveredServe | null;
    url?: string;
    authPassword?: string;
    spawnError?: Error;
  } = {}
): {
  impl: ServeLifecycle;
  discoverCalls: string[][];
  spawns: SpawnOptions[];
  stops: OwnedServe[];
  exitChild: (n: number) => void;
} {
  const discoverCalls: string[][] = [];
  const spawns: SpawnOptions[] = [];
  const stops: OwnedServe[] = [];
  const children: Array<{ emitExit: () => void }> = [];
  const impl: ServeLifecycle = {
    async discover(roots) {
      discoverCalls.push(roots);
      return opts.discovered ?? null;
    },
    async spawn(spawnOpts) {
      spawns.push(spawnOpts);
      if (opts.spawnError) throw opts.spawnError;
      const listeners: Array<(info: ExitInfo) => void> = [];
      children.push({
        emitExit: () => {
          for (const cb of listeners) cb({ code: 0, signal: null });
        },
      });
      return {
        pid: 5000 + children.length,
        url: opts.url ?? 'http://127.0.0.1:5555',
        authUser: 'opencode',
        authPassword: opts.authPassword ?? 'spawned-secret',
        onExit: (cb: (info: ExitInfo) => void) => listeners.push(cb),
      } as unknown as OwnedServe;
    },
    async stop(handle) {
      stops.push(handle);
    },
  };
  return { impl, discoverCalls, spawns, stops, exitChild: (n) => children[n - 1].emitExit() };
}

/** Advance the mocked clock, then settle the poll's fetch promise. */
async function step(t: TestContext, ms = POLL_MS): Promise<void> {
  t.mock.timers.tick(ms);
  await flush();
}

function enableTimers(t: TestContext): void {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'] });
  t.mock.timers.setTime(BASE_TIME);
  t.after(() => t.mock.timers.reset());
}

// ---------------------------------------------------------------------------
// US-7.2 · the watcher reports only what it observed
// ---------------------------------------------------------------------------

test('US-7.2 · first poll is a baseline: a session seen for the first time emits nothing', async (t) => {
  enableTimers(t);
  const { w, events, calls } = makeWatcher(() => ({ body: [entry('s1', ROOT, RECENT)] }));
  w.start();
  await step(t, 0);
  assert.equal(calls(), 1, 'the first poll happened');
  assert.deepEqual(events, [], 'a baseline is not activity');
  await step(t);
  await step(t);
  assert.deepEqual(events, [], 'still nothing while time.updated stands still');
  w.dispose();
});

test('US-7.2 · a strictly larger time.updated emits exactly one event', async (t) => {
  enableTimers(t);
  const { w, events } = makeWatcher((call) => ({
    body: [entry('s1', ROOT, call === 0 ? RECENT : BUMPED)],
  }));
  w.start();
  await step(t, 0); // baseline
  await step(t); // bump → one event
  assert.equal(events.length, 1);
  await step(t); // nothing changed
  assert.equal(events.length, 1, 'one bump, one event');
  w.dispose();
});

test('US-7.2 · several sessions bumping in the same poll still emit one event', async (t) => {
  enableTimers(t);
  const { w, events } = makeWatcher((call) => ({
    body: [
      entry('s1', ROOT, call === 0 ? RECENT : BUMPED),
      entry('s2', `${ROOT}/api`, call === 0 ? RECENT : BUMPED + 3000),
      entry('s3', ROOT, call === 0 ? RECENT : RECENT), // unchanged
    ],
  }));
  w.start();
  await step(t, 0);
  await step(t);
  assert.equal(events.length, 1, 'at most one event per poll');
  w.dispose();
});

test('US-7.2 · no increase means no event, however often we poll', async (t) => {
  enableTimers(t);
  const { w, events } = makeWatcher(() => ({ body: [entry('s1', ROOT, RECENT)] }));
  w.start();
  await step(t, 0);
  for (let i = 0; i < 5; i++) await step(t);
  assert.deepEqual(events, []);
  w.dispose();
});

test('US-7.2 · a session outside the workspace never counts', async (t) => {
  enableTimers(t);
  const { w, events } = makeWatcher((call) => ({
    body: [entry('s1', '/somewhere/else', call === 0 ? RECENT : BUMPED)],
  }));
  w.start();
  await step(t, 0);
  await step(t);
  await step(t);
  assert.deepEqual(events, []);
  w.dispose();
});

test('US-7.2 · matching is by root and by subdirectory, across several roots', async (t) => {
  enableTimers(t);
  const { w, events } = makeWatcher(
    (call) => ({
      body: [
        entry('in-root', ROOT, call === 0 ? RECENT : BUMPED),
        entry('in-sub', `${ROOT}/packages/api/src`, call === 0 ? RECENT : BUMPED),
        entry('in-other-root', OTHER_ROOT, call === 0 ? RECENT : BUMPED),
        // Shares a string prefix with a root but is NOT under it.
        entry('lookalike', `${ROOT}-sandbox`, call === 0 ? RECENT : BUMPED),
      ],
    }),
    { roots: [ROOT, OTHER_ROOT] }
  );
  w.start();
  await step(t, 0);
  await step(t);
  assert.equal(events.length, 1, 'the three workspace sessions bumped');
  w.dispose();
});

test('US-7.2 · a session that disappears is forgotten', async (t) => {
  enableTimers(t);
  const bodies = [
    [entry('s1', ROOT, RECENT)], // poll 1: the discovery list → baseline
    [], // poll 2: `GET /session/s1` → 404 → forgotten
    [entry('s1', ROOT, BUMPED + 5000)], // (never requested: s1 is no longer tracked)
  ];
  const { w, events } = makeWatcher((call) => ({ body: bodies[call] ?? [] }));
  w.start();
  await step(t, 0);
  await step(t);
  assert.deepEqual(w.retainedSessionIds(), [], 'the 404 forgot it');
  await step(t);
  assert.deepEqual(events, [], 'no phantom activity for a forgotten session');
  w.dispose();
});

test('US-7.2 · "LaLog …" sessions are ignored (self-feedback guard)', async (t) => {
  enableTimers(t);
  const { w, events } = makeWatcher((call) => ({
    body: [
      // LaLog's own bridge creates these, in this very directory.
      entry('bridge', ROOT, call === 0 ? RECENT : BUMPED + 5000, 'LaLog preflight'),
      entry('bridge2', ROOT, call === 0 ? RECENT : BUMPED + 5000, 'LaLog report 2026-09-21'),
      entry('real', ROOT, call === 0 ? RECENT : BUMPED, 'fix the login bug'),
    ],
  }));
  w.start();
  await step(t, 0);
  await step(t);
  await step(t);
  assert.equal(events.length, 1, 'only the user chat counted, and only once');
  w.dispose();
});

test('US-7.2 · malformed entries are skipped, valid ones still count', async (t) => {
  enableTimers(t);
  const { w, events } = makeWatcher((call) => ({
    body: [
      { id: 'no-dir', time: { updated: 5000 } },
      { id: 'bad-updated', directory: ROOT, time: { updated: 'soon' } },
      { id: 42, directory: ROOT, time: { updated: 5000 } },
      entry('good', ROOT, call === 0 ? RECENT : BUMPED),
    ],
  }));
  w.start();
  await step(t, 0);
  await step(t);
  assert.equal(events.length, 1);
  w.dispose();
});

test('US-7.2 · the event carries the observation time', async (t) => {
  enableTimers(t);
  const { w, events } = makeWatcher((call) => ({
    body: [entry('s1', ROOT, call === 0 ? RECENT : BUMPED)],
  }));
  w.start();
  await step(t, 0);
  await step(t); // the bump lands on the second poll, at BASE_TIME + POLL_MS
  assert.deepEqual(events, [BASE_TIME + POLL_MS]);
  w.dispose();
});

// ---------------------------------------------------------------------------
// US-7.2 · failure handling: silent retries, stop only when retrying is pointless
// ---------------------------------------------------------------------------

test('US-7.2 · a refused connection is silent and keeps retrying', async (t) => {
  enableTimers(t);
  const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:4096'), {
    code: 'ECONNREFUSED',
  });
  const { w, events, warnings, calls } = makeWatcher(() => ({ error: refused }));
  w.start();
  await step(t, 0);
  await step(t);
  await step(t);
  assert.deepEqual(warnings, [], 'no noise for a server that is simply not running');
  assert.deepEqual(events, []);
  await step(t, 5000); // the backoff interval, so the next attempt fits
  assert.ok(calls() >= 4, `kept retrying (got ${calls()} attempts)`);
  w.dispose();
});

test('US-7.2 · backoff after 3 failures, then a re-baseline that invents nothing', async (t) => {
  enableTimers(t);
  let down = true;
  const fake = fakeFetch((call) => {
    if (down) return { error: Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' }) };
    return { body: [entry('s1', ROOT, RECENT)] };
  });
  const events: number[] = [];
  const warnings: string[] = [];
  const w = new ServeWatcher({
    url: 'http://127.0.0.1:4096',
    pollMs: POLL_MS,
    roots: [ROOT],
    onActivity: (now) => events.push(now),
    log: (m) => warnings.push(m),
    fetchImpl: fake.fetchImpl,
  });
  w.start();
  await step(t, 0); // failure 1
  await step(t); // failure 2
  await step(t); // failure 3 — backoff starts from here
  assert.equal(fake.calls(), 3, 'one attempt per interval while failures are rare');
  assert.deepEqual(warnings, [], 'an outage is never surfaced to the user');
  await step(t); // inside the backed-off window
  assert.equal(fake.calls(), 3, 'backoff: no poll before 5× the interval');
  await step(t, 4000); // the backed-off poll fires
  assert.equal(fake.calls(), 4, 'the backoff is bounded, so it does retry');
  down = false; // the user restarts their server
  await step(t, 5000);
  assert.equal(fake.calls(), 5, 'the outage was followed by another attempt');
  assert.deepEqual(events, [], 'the outage gap is never reported as activity');
  await step(t);
  assert.equal(fake.calls(), 6, 'success reset the backoff to the poll interval');
  assert.deepEqual(events, []);
  w.dispose();
});

test('US-7.2 · a malformed payload stops the watcher with exactly one warning', async (t) => {
  enableTimers(t);
  let healthy = false;
  const { w, warnings, calls } = makeWatcher(() =>
    healthy ? { body: [entry('s1', ROOT, RECENT)] } : { body: { sessions: [] } }
  );
  w.start();
  await step(t, 0);
  await step(t);
  await step(t);
  assert.equal(warnings.length, 1, 'exactly one warning');
  assert.match(warnings[0], /payload/i);
  assert.equal(calls(), 1, 'no retry storm after an unusable payload');
  healthy = true;
  w.start(); // a config change re-arms it
  await step(t, 0);
  assert.equal(calls(), 2, 'start() recovers');
  assert.equal(warnings.length, 1, 'a healthy payload after recovery warns nothing');
  w.dispose();
});

test('US-7.2 · 401/403/404 stop the watcher with one warning and no retries', async (t) => {
  enableTimers(t);
  for (const status of [401, 403, 404]) {
    const { w, warnings, calls } = makeWatcher(() => ({ status }));
    w.start();
    await step(t, 0);
    await step(t);
    await step(t);
    assert.equal(warnings.length, 1, `one warning for ${status}`);
    assert.match(warnings[0], new RegExp(String(status)));
    assert.equal(calls(), 1, `no retries after ${status}`);
    w.dispose();
  }
});

test('US-7.2 · a 5xx is transient: silent retry, no warning', async (t) => {
  enableTimers(t);
  const { w, warnings, calls } = makeWatcher(() => ({ status: 503 }));
  w.start();
  await step(t, 0);
  await step(t);
  await step(t);
  assert.deepEqual(warnings, []);
  assert.ok(calls() >= 3, `kept polling (${calls()} attempts)`);
  w.dispose();
});

test('US-7.2 · dispose() clears the timer and the watcher never polls again', async (t) => {
  enableTimers(t);
  const { w, calls } = makeWatcher(() => ({ body: [] }));
  w.start();
  await step(t, 0);
  assert.equal(calls(), 1);
  w.dispose();
  await step(t);
  await step(t);
  await step(t, 100_000);
  assert.equal(calls(), 1, 'no poll after dispose');
  w.start(); // even an explicit restart must not resurrect it
  await step(t, 0);
  await step(t);
  assert.equal(calls(), 1, 'a disposed watcher stays disposed');
});

test('US-7.2 · polls <url>/session, with HTTP Basic only when a password is set', async (t) => {
  enableTimers(t);
  const seen: { url: string; headers?: Record<string, string> }[] = [];
  const impl = (async (url: string, init: { headers?: Record<string, string> }) => {
    seen.push({ url: String(url), headers: init.headers });
    return { ok: true, status: 200, json: async () => [] };
  }) as unknown as typeof fetch;
  const w = new ServeWatcher({
    url: 'http://127.0.0.1:7777/',
    pollMs: POLL_MS,
    roots: [ROOT],
    authUser: 'me',
    authPassword: 'secret',
    onActivity: () => {},
    log: () => {},
    fetchImpl: impl,
  });
  w.start();
  await step(t, 0);
  assert.equal(seen[0].url, 'http://127.0.0.1:7777/session', 'trailing slash trimmed, /session appended');
  assert.equal(
    seen[0].headers?.authorization,
    `Basic ${Buffer.from('me:secret').toString('base64')}`,
    'basic auth when a password is configured'
  );
  w.dispose();

  // No password → no Authorization header at all.
  const anonymous: Record<string, string>[] = [];
  const plain = (async (_url: string, init: { headers?: Record<string, string> }) => {
    anonymous.push(init.headers ?? {});
    return { ok: true, status: 200, json: async () => [] };
  }) as unknown as typeof fetch;
  const anon = new ServeWatcher({
    url: 'http://127.0.0.1:7777',
    pollMs: POLL_MS,
    roots: [ROOT],
    onActivity: () => {},
    log: () => {},
    fetchImpl: plain,
  });
  anon.start();
  await step(t, 0);
  assert.equal(anonymous[0].authorization, undefined, 'no auth header without a password');
  anon.dispose();
});

// ---------------------------------------------------------------------------
// US-7.2 · the poll interval is a time gate like every other
// ---------------------------------------------------------------------------

test('US-7.2 · poll interval: 5s floor, debugTimeScale divisor, idleConfirm/3 ceiling', () => {
  const scaled = defaultConfig({ debugTimeScale: 60 });
  const thScaled = thresholdsMs(scaled);
  assert.equal(opencodePollMs(1, scaled, thScaled), 83, 'below the floor → 5s, then scaled');
  assert.equal(opencodePollMs(5, scaled, thScaled), 83, 'at the floor');
  assert.equal(opencodePollMs(20, scaled, thScaled), 333, 'the default, scaled');
  assert.equal(opencodePollMs(120, scaled, thScaled), 2000, 'above the floor, scaled');

  const real = defaultConfig({ debugTimeScale: 1 });
  const thReal = thresholdsMs(real);
  assert.equal(opencodePollMs(1, real, thReal), 5000, 'unscaled floor is 5s');
  assert.equal(opencodePollMs(20, real, thReal), 20000, 'unscaled default is 20s');

  // A short idleConfirm caps the poll, so a few polls can still cross it.
  const capped = defaultConfig({ debugTimeScale: 1, idleConfirmAfterMinutes: 1 });
  assert.equal(opencodePollMs(600, capped, thresholdsMs(capped)), 20000, 'capped at idleConfirm/3');

  // Even an absurd scale must not yield a zero or negative interval.
  const tiny = defaultConfig({ debugTimeScale: 1_000_000 });
  assert.equal(opencodePollMs(5, tiny, thresholdsMs(tiny)), 1, 'never below 1ms');
});

test('US-7.2 · the config namespace is off by default and independent of lalog.ai.enabled', () => {
  try {
    mockVscode.reset();
    const off = readOpencodeActivityConfig();
    assert.equal(off.enabled, false);
    assert.equal(off.url, 'http://127.0.0.1:4096');
    assert.equal(off.pollIntervalSec, 30);
    assert.equal(off.discoverySec, 180);
    assert.equal(off.authUser, 'opencode');
    assert.equal(off.authPassword, undefined, 'unset means LaLog generates a random password');

    mockVscode.setConfig('lalog.ai', { enabled: true });
    assert.equal(readOpencodeActivityConfig().enabled, false, 'AI on does not turn it on');

    mockVscode.setConfig('lalog.opencode.activity', { enabled: true });
    const on = readOpencodeActivityConfig();
    assert.equal(on.enabled, true);
    assert.equal(on.url, 'http://127.0.0.1:4096', 'unset keys keep their defaults');
  } finally {
    mockVscode.reset();
  }
});

// ---------------------------------------------------------------------------
// US-7.2 · the event flows through the existing activity pipeline
// ---------------------------------------------------------------------------

test('US-7.2 · opencode bumps accrue like any other activity, and are counted', async (t) => {
  // At debugTimeScale 60 this means, in real time: a 10s idle gap (so a 5s
  // chat bump accrues), a 120s idle confirmation and a 180s stale cutoff — both
  // crossed by the heartbeat inside the window this test covers.
  const h = setupHarness(t, { config: chatConfig() });
  const stub = {
    started: 0,
    disposed: 0,
    start(): void {
      this.started += 1;
    },
    dispose(): void {
      this.disposed += 1;
    },
  };
  h.manager.setServeWatcher(stub);
  await h.start();
  assert.equal(stub.started, 1, 'start() starts the injected watcher');

  const sessionId = h.manager.getSession()!.id;
  const bumps = 60;
  for (let i = 0; i < bumps; i++) {
    await h.tick(5000); // 5s of chat between observations
    h.manager.onActivityEvent('opencode', undefined, Date.now());
  }
  const s = h.manager.getSession()!;
  assert.equal(s.id, sessionId, 'no stale cut-off while the chat is live');
  assert.equal(s.events.opencode, bumps, 'one opencode event per poll that saw a bump');
  assert.equal(s.events.edits, 0, 'and nothing else was counted');
  assert.equal(s.activityTs.length, bumps, 'activity timestamps accrue');
  assert.ok(s.activeMinutes >= (bumps - 1) * 5000, `active time accrued (${s.activeMinutes}ms)`);
  assert.equal(mockVscode.promptCalls().length, 0, 'no "still working?" prompt during a chat');
  assert.equal(h.activeSnapshot()!.events.opencode, bumps, 'the counter is persisted');
});

test('US-7.2 · control: the same window without bumps prompts and force-closes', async (t) => {
  const h = setupHarness(t, { config: chatConfig() });
  await h.start();
  const sessionId = h.manager.getSession()!.id;
  await h.tick(300_000); // 5 minutes of pure silence
  assert.notEqual(h.manager.getSession()!.id, sessionId, 'the stale cutoff fired without chat');
  assert.equal(h.manager.getSession()!.events.opencode, 0, 'nothing was invented');
});

test('US-7.2 · control: without a stale cutoff the same silence still asks "still working?"', async (t) => {
  const h = setupHarness(t, { config: { ...chatConfig(), staleSessionAfterMinutes: 100_000 } });
  await h.start();
  await h.tick(300_000);
  assert.ok(mockVscode.promptCalls().length >= 1, 'the idle prompt is reachable in this window');
});

/** Timing that makes an idle chat detectable inside a mock-timer test. */
function chatConfig(): Partial<{
  idleGapMinutes: number;
  idleConfirmAfterMinutes: number;
  staleSessionAfterMinutes: number;
}> {
  return {
    idleGapMinutes: 10, // 10s at debugTimeScale 60
    idleConfirmAfterMinutes: 120, // 120s
    staleSessionAfterMinutes: 180, // 180s
    // Describe/wrap checkpoints are out of scope here: only the idle prompt,
    // the stale cutoff and accrual are under test.
    describeAfterMinutes: 100_000,
    wrapAfterMinutes: 100_000,
  };
}

test('US-7.2 · a chat that stops still lets the session go idle', async (t) => {
  const h = setupHarness(t, { config: { idleConfirmAfterMinutes: 2, staleSessionAfterMinutes: 100_000 } });
  await h.start();
  h.manager.onActivityEvent('opencode', undefined, Date.now());
  assert.equal(h.manager.getSession()!.events.opencode, 1);
  await h.tick(10 * 60_000); // idleConfirm is 2s at debugTimeScale 60
  assert.equal(mockVscode.promptCalls().length, 1, 'silence after the chat is still idle');
});

test('US-7.2 · the manager starts and disposes the injected watcher', async (t) => {
  const h = setupHarness(t);
  const stub = {
    started: 0,
    disposed: 0,
    start(): void {
      this.started += 1;
    },
    dispose(): void {
      this.disposed += 1;
    },
  };
  h.manager.setServeWatcher(stub);
  await h.start();
  assert.equal(stub.started, 1);
  h.manager.dispose();
  assert.equal(stub.disposed, 1, 'dispose() tears the watcher down');
});

test('US-7.2 · disabled by default: no watcher is constructed and no fetch happens', async (t) => {
  const realFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = ((url: string) => {
    calls.push(String(url));
    return Promise.resolve({ ok: true, status: 200, json: async () => [] });
  }) as unknown as typeof fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  await setupExtension(t);
  t.mock.timers.tick(10_000);
  await flush();
  assert.deepEqual(calls, [], 'no network call whatsoever while disabled');
  assert.equal(readOpencodeActivityConfig().enabled, false, 'off is the default');
});

test('US-7.2 · enabled: the composition root polls the configured URL and records the bump', async (t) => {
  const realFetch = globalThis.fetch;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lalog-serve-'));
  const wsPath = path.join(dir, 'workspace');
  const calls: string[] = [];
  let bumped = false;
  globalThis.fetch = ((url: string) => {
    const target = String(url);
    calls.push(target);
    // Same shape the real server answers with: the list for `/session`, the one
    // session for `/session/{id}`. The session bumps once, then stands still.
    const perSession = singleSessionId(target) !== null;
    if (perSession && !bumped) bumped = true;
    const updated = perSession ? (bumped ? BUMPED : RECENT) : RECENT;
    const one = entry('serve-1', wsPath, updated);
    return Promise.resolve({
      ok: true,
      status: 200,
      json: async () => (perSession ? one : [one]),
    });
  }) as unknown as typeof fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  // manageServe off: this test is about the configured-url path, and a managed
  // serve would (rightly) go looking for a real opencode server — which no test
  // may touch. Lifecycle management itself is covered with injected fakes below.
  const ext = await setupExtension(t, {
    dir,
    activity: { enabled: true, manageServe: false } as Partial<OpencodeActivityConfig>,
  });
  for (let i = 0; i < 4; i++) {
    t.mock.timers.tick(1000); // pollMs is ~333ms at debugTimeScale 60
    await flush();
  }
  assert.equal(calls[0], 'http://127.0.0.1:4096/session', 'the configured URL is polled');
  assert.ok(calls.length >= 2, `kept polling (${calls.length} polls)`);

  await mockVscode.commands.executeCommand('lalog.endSession');
  await flush();
  const closed = await new SessionStore({ paths: ext.paths, th: ext.th }).loadAll();
  assert.equal(closed.length, 1);
  assert.equal(closed[0].events.opencode, 1, 'the observed bump reached the recorded session');
  assert.equal(closed[0].events.edits, 0);
});
// ---------------------------------------------------------------------------
// US-7.2 · ADR-033: nothing runs unless a session is tracked, and the cadence
// adapts instead of hammering the endpoint
// ---------------------------------------------------------------------------

test('US-7.2 · no LaLog session open ⇒ zero fetches, no timer, and it resumes on wake()', async (t) => {
  enableTimers(t);
  let tracking = false;
  const { w, events, calls } = makeWatcher(() => ({ body: [entry('s1', ROOT, RECENT)] }), {
    shouldObserve: () => tracking,
  });
  w.start();
  await step(t, 0);
  assert.equal(calls(), 0, 'not one request while nothing is being tracked');
  assert.equal(w.armed, false, 'no timer is kept either');
  await step(t, 600_000); // five minutes of clock: still nothing
  assert.equal(calls(), 0, 'a parked watcher stays parked');
  assert.deepEqual(events, []);

  tracking = true;
  w.wake();
  await step(t, 0);
  assert.equal(calls(), 1, 'tracking resumed, so the poll resumed');
  assert.equal(w.armed, true);
  w.dispose();
});

test('US-7.2 · a serve LaLog started is stopped when nothing is being tracked', async (t) => {
  enableTimers(t);
  const life = fakeLifecycle();
  let tracking = true;
  // A session that is already seen keeps the cadence fast, so the next poll
  // lands exactly one interval later.
  const { w } = makeWatcher(() => ({ body: [entry('s1', ROOT, RECENT)] }), {
    manageServe: true,
    lifecycle: life.impl,
    shouldObserve: () => tracking,
  });
  w.start();
  await step(t, 0);
  assert.equal(life.spawns.length, 1, 'a serve was started for the tracked session');
  assert.equal(life.stops.length, 0);
  tracking = false;
  await step(t, POLL_MS);
  assert.equal(life.stops.length, 1, 'the serve we own is released when idle');
  w.dispose();
});

test('US-7.2 · a discovered serve is observed and nothing is ever spawned for it', async (t) => {
  enableTimers(t);
  const discovered: DiscoveredServe = { pid: 4242, url: 'http://127.0.0.1:4321', owned: false };
  const life = fakeLifecycle({ discovered });
  const fake = fakeFetch(() => ({ body: [] }));
  const urls: string[] = [];
  void fake;
  const w = new ServeWatcher({
    url: 'http://127.0.0.1:4096',
    pollMs: POLL_MS,
    roots: [ROOT],
    manageServe: true,
    lifecycle: life.impl,
    onActivity: () => {},
    log: () => {},
    fetchImpl: ((url: string) => {
      urls.push(String(url));
      return Promise.resolve({ ok: true, status: 200, json: async () => [] });
    }) as unknown as typeof fetch,
  });
  w.start();
  await step(t, 0);
  assert.deepEqual(life.discoverCalls, [[ROOT]], 'asked for a serve serving this workspace');
  assert.equal(life.spawns.length, 0, 'reuse first: nothing spawned');
  assert.equal(life.stops.length, 0);
  assert.deepEqual(urls, ['http://127.0.0.1:4321/session'], 'the discovered server is the one polled');
  await step(t, POLL_MS);
  assert.equal(life.discoverCalls.length, 1, 'the endpoint is reused, not rediscovered every poll');
  w.dispose();
  assert.equal(life.stops.length, 0, 'dispose() never stops a server LaLog did not start');
});

test('US-7.2 · when discovery finds nothing, LaLog starts its own serve', async (t) => {
  enableTimers(t);
  const life = fakeLifecycle({ url: 'http://127.0.0.1:5566', authPassword: 'random-secret' });
  const urls: string[] = [];
  const w = new ServeWatcher({
    url: 'http://127.0.0.1:4096',
    pollMs: POLL_MS,
    roots: [ROOT, OTHER_ROOT],
    manageServe: true,
    opencodePath: '/opt/opencode',
    spawnPort: 0,
    authUser: 'opencode',
    // Unset (not ''): the default must let spawnServe generate a password.
    lifecycle: life.impl,
    onActivity: () => {},
    log: () => {},
    fetchImpl: ((url: string, init: RequestInit) => {
      urls.push(String(url));
      const headers = (init.headers ?? {}) as Record<string, string>;
      return Promise.resolve({ ok: true, status: 200, json: async () => [] });
    }) as unknown as typeof fetch,
  });
  w.start();
  await step(t, 0);
  assert.equal(life.discoverCalls.length, 1);
  assert.equal(life.spawns.length, 1, 'spawn only when there is nothing to reuse');
  const spawn = life.spawns[0];
  assert.equal(spawn.root, ROOT, 'cwd = the workspace root (/session filters on it)');
  assert.equal(spawn.binary, '/opt/opencode');
  assert.equal(spawn.port, 0, '0 = let opencode choose, so there is no port collision');
  assert.equal(spawn.authPassword, undefined, 'unset ⇒ spawnServe generates a password');
  assert.deepEqual(urls, ['http://127.0.0.1:5566/session'], 'the serve we started is the one polled');
  assert.equal(life.stops.length, 0);
  w.dispose();
  assert.equal(life.stops.length, 1, 'dispose() stops exactly the serve we started');
});

test('US-7.2 · an explicitly empty password is the unsecured opt-out, not "generate one"', async (t) => {
  enableTimers(t);
  // '' is a deliberate choice ("run the serve unsecured"), so it must reach
  // spawnServe verbatim. Collapsing it to undefined would silently do the
  // opposite of what the user asked for.
  const life = fakeLifecycle({ url: 'http://127.0.0.1:5567', authPassword: '' });
  const w = new ServeWatcher({
    url: 'http://127.0.0.1:4096',
    pollMs: POLL_MS,
    roots: [ROOT],
    manageServe: true,
    authUser: 'opencode',
    authPassword: '',
    lifecycle: life.impl,
    onActivity: () => {},
    log: () => {},
    fetchImpl: (() =>
      Promise.resolve({ ok: true, status: 200, json: async () => [] })) as unknown as typeof fetch,
  });
  w.start();
  await step(t, 0);
  assert.equal(life.spawns.length, 1);
  assert.equal(life.spawns[0].authPassword, '', 'the opt-out is forwarded, not replaced');
  w.dispose();
});

test('US-7.2 · a serve LaLog started that exits is re-ensured on the next tick', async (t) => {
  enableTimers(t);
  const life = fakeLifecycle();
  const { w } = makeWatcher(() => ({ body: [entry('s1', ROOT, RECENT)] }), {
    manageServe: true,
    lifecycle: life.impl,
  });
  w.start();
  await step(t, 0);
  assert.equal(life.spawns.length, 1);
  assert.deepEqual(w.retainedSessionIds(), ['s1'], 'baseline recorded');

  life.exitChild(1); // it died on its own: ownership is released, nothing is stopped
  assert.equal(life.stops.length, 0, 'a child that already exited is not signalled');
  await step(t, POLL_MS);
  assert.equal(life.discoverCalls.length, 2, 'the next tick looks again');
  assert.equal(life.spawns.length, 2, 'and starts a fresh one when there is still nothing to reuse');
  w.dispose();
});

test('US-7.2 · an ensure failure is silent, backs off, and invents no activity', async (t) => {
  enableTimers(t);
  const life = fakeLifecycle({ spawnError: new Error('opencode CLI not found') });
  const { w, events, warnings, calls } = makeWatcher(() => ({ body: [entry('s1', ROOT, RECENT)] }), {
    manageServe: true,
    lifecycle: life.impl,
  });
  w.start();
  await step(t, 0);
  await step(t, POLL_MS);
  await step(t, POLL_MS);
  assert.equal(life.spawns.length, 1, 'the failure is not retried in a tight loop');
  assert.equal(calls(), 0, 'no request goes anywhere while there is no server');
  assert.deepEqual(w.retainedSessionIds(), [], 'an observation gap drops the baseline');
  assert.deepEqual(events, []);
  assert.ok(warnings.length <= 2, `quietly reported (${warnings.length} warnings)`);
  assert.match(warnings[0], /no opencode serve available/);
  // After the backoff window the attempt is made again — the feature is not
  // simply broken forever by one failure.
  await step(t, 5000);
  assert.equal(life.spawns.length, 2);
  w.dispose();
});

test('US-7.2 · manageServe off: the configured url is polled and no process is touched', async (t) => {
  enableTimers(t);
  const life = fakeLifecycle();
  const { w, calls } = makeWatcher(() => ({ body: [] }), { lifecycle: life.impl });
  w.start();
  await step(t, 0);
  assert.equal(calls(), 1, 'observe-only mode still works');
  assert.equal(life.discoverCalls.length, 0, 'no discovery');
  assert.equal(life.spawns.length, 0, 'no spawn');
  w.dispose();
  assert.equal(life.stops.length, 0, 'and nothing to stop');
});

test('US-7.2 · the cadence doubles while quiet, is capped, and resets on a bump', async (t) => {
  enableTimers(t);
  // quiet for polls 1-4, a bump on poll 5. One tracked session, so one request
  // per tick: the discovery list first, `GET /session/s1` after that.
  const { w, events, calls } = makeWatcher(
    (call) => ({ body: [entry('s1', ROOT, call < 4 ? RECENT : BUMPED)] }),
    { pollMs: 1000, slowMs: 4000 }
  );
  w.start();
  await step(t, 0); // poll 1 (new session) → fast
  assert.equal(calls(), 1);
  await step(t, 1000); // poll 2, quiet → next delay 2s
  assert.equal(calls(), 2);
  await step(t, 1000); // t=2000, inside the stepped-down window
  assert.equal(calls(), 2, 'stepped down to 2× the fast interval');
  await step(t, 1000); // poll 3 at t=3000, quiet → next delay 4s
  assert.equal(calls(), 3);
  await step(t, 3999); // t=6999
  assert.equal(calls(), 3, 'stepped down again');
  await step(t, 1); // poll 4 at t=7000, quiet → capped at slowMs
  assert.equal(calls(), 4);
  await step(t, 3999); // t=10999: the ceiling holds, it is not 8×
  assert.equal(calls(), 4, 'the backoff never exceeds slowMs');
  await step(t, 1); // poll 5 at t=11000: a bump
  assert.equal(calls(), 5);
  assert.deepEqual(events.length, 1);
  await step(t, 1000); // back to the fast cadence
  assert.equal(calls(), 6, 'a bump returns the cadence to fast');
  w.dispose();
});

test('US-7.2 · a newly seen session returns the cadence to fast, but emits nothing', async (t) => {
  enableTimers(t);
  // A new id can only appear in the discovery list, so discoveryMs is 8s here:
  // the list request is call 3, made by the poll at t=8000.
  const live = BASE_TIME + 5000; // inside the freshness window for this test
  const { w, events, calls } = makeWatcher(
    (call) => ({
      body: [entry('s1', ROOT, live), ...(call >= 3 ? [entry('s2', ROOT, live)] : [])],
    }),
    { pollMs: POLL_MS, slowMs: 8000, discoveryMs: 8000 }
  );
  w.start();
  await step(t, 0);
  await step(t, 1000); // poll 2, quiet → 2s
  await step(t, 1000);
  assert.equal(calls(), 2);
  await step(t, 2000); // poll 3 at t=4000, quiet → 4s
  assert.equal(calls(), 3);
  await step(t, 3999);
  assert.equal(calls(), 3);
  await step(t, 1); // poll 4 at t=8000: s2 appears
  assert.equal(calls(), 4);
  assert.deepEqual(events, [], 'a first sight is still a baseline, never an event');
  await step(t, 1000); // 1s later, not 8s: the new session reset the cadence
  assert.equal(calls(), 6, 'a poll landed 1s later, and sampled both tracked sessions');
  w.dispose();
});

test('US-7.2 · only workspace sessions are retained', async (t) => {
  enableTimers(t);
  const body = (call: number) => ({
    body: [
      entry('in-root', ROOT, call === 0 ? RECENT : BUMPED),
      entry('in-sub', `${ROOT}/api`, call === 0 ? RECENT : BUMPED),
      entry('elsewhere', '/somewhere/else', 9999),
      entry('lookalike', `${ROOT}-sandbox`, 8888),
      entry('bridge', ROOT, call === 0 ? RECENT : BUMPED + 5000, 'LaLog report'),
      { id: 'no-dir', time: { updated: 7000 } },
      null,
    ],
  });
  const { w, events } = makeWatcher(body, {});
  w.start();
  await step(t, 0);
  assert.deepEqual(
    w.retainedSessionIds().sort(),
    ['in-root', 'in-sub'],
    'two fields per workspace session; nothing else is kept'
  );
  await step(t, POLL_MS);
  assert.deepEqual(w.retainedSessionIds().sort(), ['in-root', 'in-sub']);
  assert.equal(events.length, 1, 'the two workspace sessions bumped once; LaLog’s own run never counts');
  w.dispose();
});

test('US-7.2 · wake() does not resurrect a watcher that stopped with a warning', async (t) => {
  enableTimers(t);
  let healthy = false;
  const { w, warnings, calls } = makeWatcher(() => (healthy ? { body: [] } : { status: 404 }));
  w.start();
  await step(t, 0);
  await step(t, POLL_MS);
  assert.equal(warnings.length, 1, 'one warning, then silence');
  assert.equal(calls(), 1, 'no retry storm');
  healthy = true;
  w.wake();
  await step(t, POLL_MS);
  await step(t, POLL_MS);
  assert.equal(calls(), 1, 'a stopped watcher waits for its configuration to change');
  w.start(); // the configuration change
  await step(t, 0);
  assert.equal(calls(), 2, 'start() still recovers it');
  w.dispose();
});

test('US-7.2 · the activity namespace gains the lifecycle keys with conservative defaults', () => {
  try {
    mockVscode.reset();
    const defaults = readOpencodeActivityConfig();
    assert.equal(defaults.manageServe, true, 'reuse-or-spawn is the default behavior');
    assert.equal(defaults.spawnPort, 0, 'opencode picks the port');
    assert.equal(defaults.opencodePath, 'opencode');

    mockVscode.setConfig('lalog.opencode.activity', { manageServe: false, spawnPort: 4096, opencodePath: '/bin/oc' });
    const cfg = readOpencodeActivityConfig();
    assert.equal(cfg.manageServe, false);
    assert.equal(cfg.spawnPort, 4096);
    assert.equal(cfg.opencodePath, '/bin/oc');
    assert.equal(cfg.enabled, false, 'the opt-in is still separate from the lifecycle defaults');
  } finally {
    mockVscode.reset();
  }
});

test('US-7.2 · the adaptive ceiling is a scaled time gate like every other', () => {
  assert.equal(opencodeSlowPollMs(defaultConfig({ debugTimeScale: 1 })), 300_000);
  assert.equal(opencodeSlowPollMs(defaultConfig({ debugTimeScale: 60 })), 5000);
  assert.equal(opencodeSlowPollMs(defaultConfig({ debugTimeScale: 100_000 })), 3);
  // The idleConfirm/3 clamp belongs to the fast end only, so a scaled config
  // still gets a real backoff instead of a constant interval.
  const scaled = defaultConfig({ debugTimeScale: 60 });
  const th = thresholdsMs(scaled);
  assert.ok(opencodeSlowPollMs(scaled) > opencodePollMs(20, scaled, th));
});

// ---------------------------------------------------------------------------
// US-7.2 · the load contract: a full list only to discover, per-session polls
// for everything else — measured, not assumed (a list is ~68 KB and
// ~164-283 ms of server CPU; one session is ~540 B and ~48 ms)
// ---------------------------------------------------------------------------

test('US-7.2 · the request mix: per-session every tick, the full list only every discoverySec', async (t) => {
  enableTimers(t);
  const { w, urls } = makeWatcher(
    () => ({ body: [entry('s1', ROOT, RECENT), entry('s2', `${ROOT}/api`, RECENT)] }),
    { pollMs: POLL_MS, slowMs: POLL_MS, discoveryMs: 5000 }
  );
  w.start();
  for (let i = 0; i < 6; i++) await step(t, i === 0 ? 0 : POLL_MS); // t = 0 … 5000
  const lists = urls.filter((u) => u === 'http://127.0.0.1:4096/session');
  const perSession = urls.filter((u) => /\/session\/s\d$/.test(u));
  assert.deepEqual(
    lists,
    ['http://127.0.0.1:4096/session', 'http://127.0.0.1:4096/session'],
    'the expensive list request happens at start and once per discoverySec — nothing in between'
  );
  assert.equal(perSession.length, 8, 'the four ticks in between ask for the two tracked sessions');
  assert.equal(urls.length, lists.length + perSession.length, 'nothing else was ever requested');
  w.dispose();
});

test('US-7.2 · a tracked session is read through GET /session/{id}: one bump, one event', async (t) => {
  enableTimers(t);
  const { w, events, urls } = makeWatcher(
    (call) => ({ body: [entry('s1', ROOT, call === 0 ? RECENT : BUMPED)] }),
    { pollMs: POLL_MS, slowMs: POLL_MS }
  );
  w.start();
  await step(t, 0); // discovery → baseline
  await step(t); // /session/s1 → a bump
  assert.deepEqual(
    urls,
    ['http://127.0.0.1:4096/session', 'http://127.0.0.1:4096/session/s1'],
    'the bump came from the cheap per-session endpoint'
  );
  assert.equal(events.length, 1);
  await step(t); // unchanged
  assert.equal(events.length, 1, 'one bump, one event');
  assert.equal(urls.length, 3, 'the session is still sampled every tick — it was just quiet');
  w.dispose();
});

test('US-7.2 · a brand-new session is adopted at the next discovery poll without emitting', async (t) => {
  enableTimers(t);
  // A new id can only ever appear in the list, so `discoveryMs` — not the fast
  // cadence — is what decides how quickly a brand-new chat is noticed.
  const ADOPT_AT = BASE_TIME + 4000; // the second discovery poll
  const BUMP_AT = BASE_TIME + 5000; // the new session's first movement
  const { w, events } = makeWatcher(
    () => {
      const now = Date.now();
      const body = [entry('s1', ROOT, RECENT)];
      if (now >= ADOPT_AT) {
        // Steady at BUMP_AT afterwards, so the bump is observed exactly once.
        body.push(entry('new-chat', ROOT, now >= BUMP_AT ? BUMP_AT : now));
      }
      return { body };
    },
    { pollMs: POLL_MS, slowMs: POLL_MS, discoveryMs: 4000 }
  );
  w.start();
  await step(t, 0); // discovery at t=0
  for (let i = 0; i < 4; i++) await step(t); // per-session polls, then the list at t=4s
  assert.deepEqual(w.retainedSessionIds().sort(), ['new-chat', 's1'], 'adopted by the t=4s list');
  assert.deepEqual(events, [], 'adoption is a baseline, never an event');
  await step(t); // the new session's first bump
  assert.equal(events.length, 1);
  await step(t);
  assert.equal(events.length, 1, 'and only once');
  w.dispose();
});

test('US-7.2 · a tracked session older than the freshness window is not re-fetched', async (t) => {
  enableTimers(t);
  const stale = RECENT - 10 * 60_000; // untouched for ten minutes
  const { w, events, urls } = makeWatcher(
    (call) => ({
      body: [
        entry('live', ROOT, call === 0 ? RECENT : BUMPED),
        entry('quiet', ROOT, stale),
      ],
    }),
    { pollMs: POLL_MS, slowMs: POLL_MS, discoveryMs: 60_000 }
  );
  w.start();
  await step(t, 0); // discovery → both tracked
  for (let i = 0; i < 4; i++) await step(t); // four activity polls
  assert.deepEqual(
    urls.filter((u) => u.includes('/session/quiet')),
    [],
    'a session untouched for longer than one discovery window is never re-fetched'
  );
  assert.equal(urls.filter((u) => u.includes('/session/live')).length, 4, 'the live one still is');
  assert.equal(events.length, 1, 'the stale session could not have moved, so nothing was invented');
  w.dispose();
});

test('US-7.2 · a tick issues its requests one at a time, never a parallel fan-out', async (t) => {
  enableTimers(t);
  const urls: string[] = [];
  let open = 0;
  let maxOpen = 0;
  // Three workspace sessions: one discovery list plus three per-session polls.
  const list = [entry('a', ROOT, RECENT), entry('b', ROOT, RECENT), entry('c', ROOT, RECENT)];
  const impl = (async (url: string) => {
    const target = String(url);
    open += 1;
    maxOpen = Math.max(maxOpen, open);
    urls.push(target);
    await flush(); // any sibling request would start inside this window
    open -= 1;
    const id = singleSessionId(target);
    const one = list.find((e) => (e as { id: string }).id === id);
    return { ok: true, status: 200, json: async () => (id ? one : list) };
  }) as unknown as typeof fetch;
  const w = new ServeWatcher({
    url: 'http://127.0.0.1:4096',
    pollMs: POLL_MS,
    roots: [ROOT],
    onActivity: () => {},
    log: () => {},
    fetchImpl: impl,
  });
  w.start();
  await step(t, 0);
  await step(t, POLL_MS); // the activity tick: three sessions, three requests
  await waitFor(() => urls.length === 4);
  assert.equal(maxOpen, 1, 'never two requests in flight at once on an already-busy server');
  assert.deepEqual(urls, [
    'http://127.0.0.1:4096/session',
    'http://127.0.0.1:4096/session/a',
    'http://127.0.0.1:4096/session/b',
    'http://127.0.0.1:4096/session/c',
  ]);
  w.dispose();
});

test('US-7.2 · discovery is a scaled time gate, clamped to floor(idleConfirm/2)', () => {
  const real = defaultConfig({ debugTimeScale: 1, idleConfirmAfterMinutes: 15 });
  assert.equal(opencodeDiscoveryMs(180, real, thresholdsMs(real)), 180_000, 'the 3-minute default');
  assert.equal(
    opencodeDiscoveryMs(600, real, thresholdsMs(real)),
    450_000,
    'clamped at half of idleConfirm (15 min): a new chat is always seen well inside it'
  );
  const capped = defaultConfig({ debugTimeScale: 1, idleConfirmAfterMinutes: 1 });
  assert.equal(opencodeDiscoveryMs(180, capped, thresholdsMs(capped)), 30_000, 'idleConfirm/2 = 30s');
  const scaled = defaultConfig({ debugTimeScale: 60, idleConfirmAfterMinutes: 15 });
  assert.equal(opencodeDiscoveryMs(180, scaled, thresholdsMs(scaled)), 3000, 'scaled like any gate');
  const tiny = defaultConfig({ debugTimeScale: 1_000_000 });
  assert.equal(opencodeDiscoveryMs(180, tiny, thresholdsMs(tiny)), 1, 'never below 1ms');
});
