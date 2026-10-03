// test/userStories/serveProcess.test.ts
//
// The opencode serve lifecycle (US-7.2 / ADR-033). Every process, filesystem
// and network touchpoint is injected: this file never spawns opencode, never
// reads the user's /proc, and never opens a socket.
import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import {
  discoverServe,
  parseListeningUrl,
  parseServeCmdline,
  spawnServe,
  stopServe,
  type ChildHandle,
  type DiscoveredServe,
  type OwnedServe,
  type ProcessInfo,
} from '../../src/opencode/serveProcess';

const ROOT = '/ws/app';
const OTHER = '/ws/other';

/** Minimal fake child process: records signals, replays stdout/exit on demand. */
class FakeChild implements ChildHandle {
  readonly signals: string[] = [];
  readonly pid = 4242;
  private stdoutCbs: Array<(t: string) => void> = [];
  private stderrCbs: Array<(t: string) => void> = [];
  private exitCbs: Array<(code: number | null, signal: string | null) => void> = [];
  private errorCbs: Array<(e: Error) => void> = [];
  private exitedFlag = false;

  /** Which signal (if any) makes this child die. */
  constructor(private diesOn: 'SIGTERM' | 'SIGKILL' | null = 'SIGTERM') {}

  onStdout(cb: (t: string) => void): void {
    this.stdoutCbs.push(cb);
  }
  onStderr(cb: (t: string) => void): void {
    this.stderrCbs.push(cb);
  }
  onExit(cb: (code: number | null, signal: string | null) => void): void {
    this.exitCbs.push(cb);
  }
  onError(cb: (e: Error) => void): void {
    this.errorCbs.push(cb);
  }
  kill(signal: 'SIGTERM' | 'SIGKILL'): boolean {
    this.signals.push(signal);
    if (!this.exitedFlag && signal === this.diesOn) this.emitExit(0, signal);
    return true;
  }

  emitStdout(text: string): void {
    for (const cb of this.stdoutCbs) cb(text);
  }
  emitStderr(text: string): void {
    for (const cb of this.stderrCbs) cb(text);
  }
  emitError(err: Error): void {
    for (const cb of this.errorCbs) cb(err);
  }
  emitExit(code: number | null, signal: string | null): void {
    if (this.exitedFlag) return;
    this.exitedFlag = true;
    for (const cb of this.exitCbs) cb(code, signal);
  }
  get exited(): boolean {
    return this.exitedFlag;
  }
}

function enableTimers(t: TestContext): void {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'] });
  t.after(() => t.mock.timers.reset());
}

/** A fetch that never touches the network and never reads a body. */
function fakeFetch(reply: (url: string, headers?: Record<string, string>) => { status?: number }): {
  fetchImpl: typeof fetch;
  urls: string[];
  auth: string[];
} {
  const urls: string[] = [];
  const auth: string[] = [];
  const impl = (async (url: string, init?: RequestInit) => {
    urls.push(String(url));
    const headers = (init?.headers ?? {}) as Record<string, string>;
    auth.push(headers.authorization ?? '');
    const r = reply(String(url), headers);
    const status = r.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => [],
      body: { cancel: async () => undefined },
    };
  }) as unknown as typeof fetch;
  return { fetchImpl: impl, urls, auth };
}

const DOWN = () => {
  throw new Error('connect ECONNREFUSED 127.0.0.1:41234');
};

// ---------------------------------------------------------------------------
// command lines
// ---------------------------------------------------------------------------

test('US-7.2 · an opencode server command line is recognized and its port extracted', () => {
  assert.deepEqual(parseServeCmdline('opencode serve --hostname 127.0.0.1 --port 41234'), {
    port: 41234,
    hostname: '127.0.0.1',
  });
  // The shape `ps` actually shows for a running serve.
  assert.deepEqual(parseServeCmdline('opencode --port 43064'), { port: 43064, hostname: null });
  assert.equal(parseServeCmdline('opencode serve --port=5151 --port 5151')?.port, 5151);
  assert.equal(parseServeCmdline('/usr/local/bin/opencode serve --port 8080 --hostname 127.0.0.1')?.port, 8080);
});

test('US-7.2 · anything that is not an opencode server is not a candidate', () => {
  assert.equal(parseServeCmdline('opencode run --model opencode/x --format json'), null, 'no --port');
  assert.equal(parseServeCmdline('opencode --model opencode/big-pickle'), null, 'the TUI itself');
  assert.equal(parseServeCmdline('/usr/bin/vim notes.txt'), null, 'unrelated process');
  assert.equal(parseServeCmdline('opencode serve --port abc'), null, 'malformed port');
  assert.equal(parseServeCmdline('opencode serve --port 99999'), null, 'out of range');
  assert.equal(parseServeCmdline(''), null);
  assert.equal(parseServeCmdline('node /x/opencode-serve.js --port 1'), null, 'not the opencode binary');
});

test('US-7.2 · the announced listening url is parsed, and only on loopback', () => {
  assert.equal(
    parseListeningUrl('opencode server listening on http://127.0.0.1:41234\n'),
    'http://127.0.0.1:41234'
  );
  assert.equal(parseListeningUrl('noise\nopencode server listening on http://localhost:4096\n'), 'http://127.0.0.1:4096');
  assert.equal(parseListeningUrl('opencode server listening on http://10.0.0.5:4096'), null, 'routable bind refused');
  assert.equal(parseListeningUrl('opencode server listening on some-other-line'), null);
  assert.equal(parseListeningUrl(''), null);
});

// ---------------------------------------------------------------------------
// 1. discovery — reuse what is already running
// ---------------------------------------------------------------------------

test('US-7.2 · discovery finds a running serve for this workspace and verifies it', async () => {
  const procs: ProcessInfo[] = [
    { pid: 10, cmdline: '/sbin/init' },
    { pid: 99, cmdline: 'opencode --port 41234' },
    { pid: 100, cmdline: 'opencode --port 50000' },
  ];
  const fake = fakeFetch((url) => ({ status: url.includes('41234') ? 200 : 404 }));
  const found = await discoverServe([ROOT], {
    listPids: async () => procs,
    readCwd: async (pid) => (pid === 99 ? `${ROOT}/` : OTHER),
    fetchImpl: fake.fetchImpl,
  });
  assert.deepEqual(found, { pid: 99, url: 'http://127.0.0.1:41234', owned: false });
  assert.deepEqual(fake.urls, ['http://127.0.0.1:41234/session'], 'exactly one verification request');
  assert.equal(fake.auth[0], '', 'discovery never invents credentials for your server');
});

test('US-7.2 · a serve whose cwd is another workspace is never adopted', async () => {
  const procs: ProcessInfo[] = [
    { pid: 99, cmdline: 'opencode --port 41234' },
    { pid: 98, cmdline: 'opencode --port 41235' },
  ];
  const fake = fakeFetch(() => ({ status: 200 }));
  const found = await discoverServe([ROOT], {
    listPids: async () => procs,
    readCwd: async (pid) => (pid === 99 ? '/elsewhere' : `${ROOT}-sandbox`), // shares a prefix, is not under it
    fetchImpl: fake.fetchImpl,
  });
  assert.equal(found, null);
  assert.deepEqual(fake.urls, [], 'not even verified: the cwd never matched');
});

test('US-7.2 · a serve bound to a routable interface is left alone', async () => {
  const fake = fakeFetch(() => ({ status: 200 }));
  const found = await discoverServe([ROOT], {
    listPids: async () => [{ pid: 99, cmdline: 'opencode serve --hostname 0.0.0.0 --port 41234' }],
    readCwd: async () => ROOT,
    fetchImpl: fake.fetchImpl,
  });
  assert.equal(found, null);
  assert.deepEqual(fake.urls, []);
});

test('US-7.2 · discovery fails silently and yields nothing in every failure mode', async () => {
  const ok = fakeFetch(() => ({ status: 200 }));
  const serve = [{ pid: 99, cmdline: 'opencode --port 41234' }];
  const cases: Array<[string, Parameters<typeof discoverServe>[1]]> = [
    ['no process table at all', { listPids: async () => { throw new Error('ENOENT /proc'); } }],
    ['ps produced nothing usable', { listPids: async () => 'not an array' as unknown as ProcessInfo[] }],
    ['no roots to match against', { listPids: async () => serve, readCwd: async () => ROOT }],
    ['permission denied on cwd', { listPids: async () => serve, readCwd: async () => { throw new Error('EACCES'); } }],
    ['cwd unreadable', { listPids: async () => serve, readCwd: async () => null }],
    ['nothing looks like a serve', { listPids: async () => [{ pid: 1, cmdline: 'vim' }] }],
  ];
  for (const [label, deps] of cases) {
    assert.equal(await discoverServe(label === 'no roots to match against' ? [] : [ROOT], deps), null, label);
  }

  // The candidate matches but the server does not answer /session: not verified,
  // so not adopted — and no exception escapes.
  const bad = fakeFetch(() => ({ status: 404 }));
  assert.equal(
    await discoverServe([ROOT], { listPids: async () => serve, readCwd: async () => ROOT, fetchImpl: bad.fetchImpl }),
    null,
    'verification 404'
  );
  const refused = fakeFetch(() => {
    throw new Error('ECONNREFUSED');
  });
  assert.equal(
    await discoverServe([ROOT], { listPids: async () => serve, readCwd: async () => ROOT, fetchImpl: refused.fetchImpl }),
    null,
    'verification timeout/refused'
  );
  const unauthorized = fakeFetch(() => ({ status: 401 }));
  assert.equal(
    await discoverServe([ROOT], { listPids: async () => serve, readCwd: async () => ROOT, fetchImpl: unauthorized.fetchImpl }),
    null,
    'verification needs auth LaLog does not have'
  );
  assert.equal(ok.urls.length, 0);
});

// ---------------------------------------------------------------------------
// 2. spawn — loopback, cwd = the workspace root, random password
// ---------------------------------------------------------------------------

test('US-7.2 · spawn starts a loopback serve in the workspace root with a random password', async (t) => {
  enableTimers(t);
  const child = new FakeChild();
  const calls: Array<{ cmd: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }> = [];
  const fake = fakeFetch(() => ({ status: 200 }));
  const pending = spawnServe(
    { root: ROOT },
    {
      spawnChild: (cmd, args, opts) => {
        calls.push({ cmd, args, cwd: opts.cwd, env: opts.env });
        return child;
      },
      fetchImpl: fake.fetchImpl,
      randomPassword: () => 'generated-secret',
    }
  );
  const settled = pending.then(
    (v) => v as OwnedServe,
    (e) => e as Error
  );
  await flushMicrotasks();

  assert.deepEqual(calls[0].args, ['serve', '--hostname', '127.0.0.1'], 'loopback only, no shell');
  assert.equal(calls[0].cmd, 'opencode');
  assert.equal(calls[0].cwd, ROOT, 'the child cwd is the workspace root: /session filters on it');
  assert.equal(calls[0].env.OPENCODE_SERVER_PASSWORD, 'generated-secret', 'never left unsecured');
  assert.deepEqual(child.signals, [], 'a starting child is not signalled');
  assert.deepEqual(fake.urls, [], 'nothing is asked before the port is known');

  // The real port comes from opencode's own startup line — no fixed port, no collision.
  child.emitStdout('opencode server listening on http://127.0.0.1:41234\n');
  t.mock.timers.tick(250);
  await flushMicrotasks();
  const owned = await settled;
  assert.ok(owned instanceof Object && 'url' in owned, 'resolved');
  assert.equal((owned as OwnedServe).url, 'http://127.0.0.1:41234');
  assert.equal((owned as OwnedServe).authPassword, 'generated-secret');
  assert.equal((owned as OwnedServe).pid, 4242);
  assert.deepEqual(fake.urls, ['http://127.0.0.1:41234/session'], 'readiness = one verified GET /session');
  assert.equal(
    fake.auth[0],
    `Basic ${Buffer.from('opencode:generated-secret').toString('base64')}`,
    'the spawned instance is polled with the password it was started with'
  );
});

test('US-7.2 · spawn honors a configured port and a configured password', async (t) => {
  enableTimers(t);
  const child = new FakeChild();
  const args: string[] = [];
  const fake = fakeFetch(() => ({ status: 200 }));
  const settled = spawnServe(
    { root: ROOT, port: 4096, authPassword: 'hunter2', binary: '/opt/opencode' },
    {
      spawnChild: (_cmd, a, _opts) => {
        args.push(...a);
        return child;
      },
      fetchImpl: fake.fetchImpl,
    }
  ).then(
    (v) => v as OwnedServe,
    (e) => e as Error
  );
  await flushMicrotasks();
  // A fixed port is known before startup finishes, so no waiting for the line.
  assert.deepEqual(args, ['serve', '--hostname', '127.0.0.1', '--port', '4096']);
  const owned = await settled;
  assert.equal((owned as OwnedServe).url, 'http://127.0.0.1:4096');
  assert.equal((owned as OwnedServe).authPassword, 'hunter2');
  assert.deepEqual(child.signals, []);
});

test('US-7.2 · an explicit empty password is the only way to start an unsecured serve', async (t) => {
  enableTimers(t);
  const child = new FakeChild();
  const envs: NodeJS.ProcessEnv[] = [];
  const fake = fakeFetch(() => ({ status: 200 }));
  const settled = spawnServe(
    { root: ROOT, port: 4096, authPassword: '' },
    {
      spawnChild: (_cmd, _args, opts) => {
        envs.push(opts.env);
        return child;
      },
      fetchImpl: fake.fetchImpl,
    }
  ).then(
    (v) => v as OwnedServe,
    (e) => e as Error
  );
  await flushMicrotasks();
  assert.equal(envs[0].OPENCODE_SERVER_PASSWORD, undefined, 'no password requested');
  assert.equal((await settled).authPassword, '');
});

test('US-7.2 · the unsecured opt-out also drops an inherited OPENCODE_SERVER_PASSWORD', async (t) => {
  enableTimers(t);
  // A password exported in the user's shell would otherwise be inherited by the
  // serve we start, which LaLog then never sends — so the readiness probe would
  // be rejected forever and the opt-out would silently not work.
  const previous = process.env.OPENCODE_SERVER_PASSWORD;
  process.env.OPENCODE_SERVER_PASSWORD = 'from-the-users-shell';
  t.after(() => {
    if (previous === undefined) delete process.env.OPENCODE_SERVER_PASSWORD;
    else process.env.OPENCODE_SERVER_PASSWORD = previous;
  });
  const child = new FakeChild();
  const envs: NodeJS.ProcessEnv[] = [];
  const fake = fakeFetch(() => ({ status: 200 }));
  const settled = spawnServe(
    { root: ROOT, port: 4096, authPassword: '' },
    {
      spawnChild: (_cmd, _args, opts) => {
        envs.push(opts.env);
        return child;
      },
      fetchImpl: fake.fetchImpl,
    }
  ).then(
    (v) => v as OwnedServe,
    (e) => e as Error
  );
  await flushMicrotasks();
  assert.equal(
    envs[0].OPENCODE_SERVER_PASSWORD,
    undefined,
    'the inherited password is removed, so the serve really starts unsecured'
  );
  assert.equal((await settled).authPassword, '');
});

test('US-7.2 · readiness keeps probing until the server answers', async (t) => {
  enableTimers(t);
  const child = new FakeChild();
  let attempts = 0;
  const fake = fakeFetch(() => {
    attempts += 1;
    return attempts < 3 ? { status: 503 } : { status: 200 };
  });
  const settled = spawnServe(
    { root: ROOT, port: 4096 },
    { spawnChild: () => child, fetchImpl: fake.fetchImpl }
  ).then(
    (v) => v as OwnedServe,
    (e) => e as Error
  );
  await flushMicrotasks();
  assert.equal(attempts, 1, 'first attempt is immediate');
  t.mock.timers.tick(250);
  await flushMicrotasks();
  t.mock.timers.tick(500);
  await flushMicrotasks();
  assert.equal(attempts, 3);
  assert.equal((await settled).url, 'http://127.0.0.1:4096');
  assert.deepEqual(child.signals, []);
});

test('US-7.2 · a readiness timeout kills the child instead of orphaning it', async (t) => {
  enableTimers(t);
  const child = new FakeChild();
  const fake = fakeFetch(DOWN);
  const settled = spawnServe(
    { root: ROOT, readyTimeoutMs: 1000 },
    { spawnChild: () => child, fetchImpl: fake.fetchImpl, stopGraceMs: 100 }
  ).then(
    () => null,
    (e) => e as Error
  );
  await flushMicrotasks();
  for (let i = 0; i < 8; i++) {
    t.mock.timers.tick(500);
    await flushMicrotasks();
  }
  const err = await settled;
  assert.ok(err instanceof Error, 'rejected');
  assert.match(err.message, /did not answer \/session within 1s/);
  assert.deepEqual(child.signals, ['SIGTERM'], 'the child we started was stopped');
  assert.equal(child.exited, true);
});

test('US-7.2 · a child that ignores SIGTERM is escalated to SIGKILL', async (t) => {
  enableTimers(t);
  const child = new FakeChild(null); // ignores both signals unless told
  const fake = fakeFetch(DOWN);
  const settled = spawnServe(
    { root: ROOT, readyTimeoutMs: 500 },
    { spawnChild: () => child, fetchImpl: fake.fetchImpl, stopGraceMs: 200 }
  ).then(
    () => null,
    () => 'rejected'
  );
  await flushMicrotasks();
  for (let i = 0; i < 6; i++) {
    t.mock.timers.tick(250);
    await flushMicrotasks();
  }
  t.mock.timers.tick(200); // the SIGTERM grace expires
  await flushMicrotasks();
  assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']);
  child.emitExit(null, 'SIGKILL');
  await flushMicrotasks();
  assert.equal(await settled, 'rejected');
  assert.equal(child.exited, true);
});

test('US-7.2 · a serve that exits during startup fails fast and leaves nothing behind', async (t) => {
  enableTimers(t);
  const child = new FakeChild();
  const fake = fakeFetch(DOWN);
  const settled = spawnServe(
    { root: ROOT },
    { spawnChild: () => child, fetchImpl: fake.fetchImpl }
  ).then(
    () => null,
    (e) => e as Error
  );
  await flushMicrotasks();
  child.emitExit(1, null);
  t.mock.timers.tick(250); // the next readiness tick observes the exit
  await flushMicrotasks();
  const err = await settled;
  assert.match(err.message, /exited before it was ready \(code 1\)/);
  assert.deepEqual(child.signals, [], 'it was already gone; nothing to signal');
});

test('US-7.2 · a missing opencode binary is reported, not swallowed', async (t) => {
  enableTimers(t);
  const child = new FakeChild();
  const settled = spawnServe(
    { root: ROOT },
    {
      spawnChild: () => {
        throw Object.assign(new Error('spawn opencode ENOENT'), { code: 'ENOENT' });
      },
      fetchImpl: fakeFetch(() => ({ status: 200 })).fetchImpl,
    }
  ).then(
    () => null,
    (e) => e as Error
  );
  await flushMicrotasks();
  const err = await settled;
  assert.match(err.message, /could not start 'opencode'/);
  assert.match(err.message, /on PATH/);
  assert.deepEqual(child.signals, []);
});

test('US-7.2 · a spawn without a workspace root is refused (the cwd is not optional)', async () => {
  const settled = spawnServe({ root: '' }, { spawnChild: () => new FakeChild() }).then(
    () => null,
    (e) => e as Error
  );
  assert.match((await settled).message, /needs a workspace root/);
});

// ---------------------------------------------------------------------------
// 3. stop — the owned child only
// ---------------------------------------------------------------------------

test('US-7.2 · stop() SIGTERMs the owned child and resolves when it is gone', async (t) => {
  enableTimers(t);
  const child = new FakeChild();
  const fake = fakeFetch(() => ({ status: 200 }));
  const owned = await spawnServe(
    { root: ROOT, port: 4096 },
    { spawnChild: () => child, fetchImpl: fake.fetchImpl }
  );
  await stopServe(owned);
  assert.deepEqual(child.signals, ['SIGTERM'], 'a polite stop only');
  assert.equal(child.exited, true);
  await stopServe(owned); // idempotent: the second stop signals nothing
  assert.deepEqual(child.signals, ['SIGTERM']);
});

test('US-7.2 · stop() escalates to SIGKILL when the child ignores SIGTERM', async (t) => {
  enableTimers(t);
  const child = new FakeChild('SIGKILL');
  const owned = await spawnServe(
    { root: ROOT, port: 4096 },
    { spawnChild: () => child, fetchImpl: fakeFetch(() => ({ status: 200 })).fetchImpl }
  );
  const stopped = stopServe(owned, { stopGraceMs: 300 }).then(
    () => 'stopped',
    (e) => e as Error
  );
  await flushMicrotasks();
  assert.deepEqual(child.signals, ['SIGTERM']);
  t.mock.timers.tick(300);
  await flushMicrotasks();
  assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(await stopped, 'stopped');
  assert.equal(child.exited, true);
});

test('US-7.2 · a discovered server can never be signalled', async (t) => {
  enableTimers(t);
  const fake = fakeFetch(() => ({ status: 200 }));
  const found = await discoverServe([ROOT], {
    listPids: async () => [{ pid: 4242, cmdline: 'opencode --port 41234' }],
    readCwd: async () => ROOT,
    fetchImpl: fake.fetchImpl,
  });
  assert.ok(found);
  assert.equal(found.owned, false);
  assert.equal('kill' in found, false, 'a discovered handle carries no signalling capability at all');

  // Casting it cannot help: the handle stopServe accepts carries a private brand.
  await assert.rejects(
    () => stopServe(found as unknown as OwnedServe),
    (err: Error) => err instanceof TypeError && /only stops a serve LaLog spawned/.test(err.message)
  );
  // And there is no way to name a pid at all: the signature takes one argument.
  assert.equal(stopServe.length, 1);
});

test('US-7.2 · child exit releases ownership: onExit fires exactly once', async (t) => {
  enableTimers(t);
  const child = new FakeChild();
  const owned = await spawnServe(
    { root: ROOT, port: 4096 },
    { spawnChild: () => child, fetchImpl: fakeFetch(() => ({ status: 200 })).fetchImpl }
  );
  const seen: Array<{ code: number | null; signal: string | null }> = [];
  owned.onExit((info) => seen.push(info));
  child.emitExit(null, 'SIGKILL');
  child.emitExit(0, null);
  assert.equal(seen.length, 1, 'one exit event, even if the emitter fires twice');
  assert.deepEqual(seen[0], { code: null, signal: 'SIGKILL' });
  // An already-exited child is not signalled again.
  await stopServe(owned);
  assert.deepEqual(child.signals, []);
});

/** Let the fake child's listeners register and the first probe run. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
  await new Promise((r) => setImmediate(r));
}

/** Type-only guard so an unused import cannot slip past the compiler. */
const _typecheck: DiscoveredServe | null = null;
void _typecheck;