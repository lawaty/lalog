import { spawn, execFile } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';

/**
 * The opencode serve **process lifecycle** (US-7.2, ADR-033), reuse first.
 *
 * Three responsibilities, and nothing else:
 *
 *  1. `discoverServe(roots)` — best-effort: find a serve that is *already*
 *     running for this workspace and verify it with one cheap `GET /session`.
 *     Every failure mode (no /proc, no `ps`, permission denied, malformed
 *     cmdline, nothing matching, a verification timeout) is silent and yields
 *     `null`, which tells the caller to spawn instead. Discovery never throws.
 *  2. `spawnServe(opts)` — start `opencode serve --hostname 127.0.0.1` with
 *     cwd = the workspace root (required: `/session` is filtered by the
 *     server's launch directory), parse the *real* port out of the child's
 *     stdout line `opencode server listening on http://127.0.0.1:<port>`, then
 *     wait for readiness by probing `GET /session`. Any failure kills the
 *     child, so LaLog never leaves an orphan behind.
 *  3. `stopServe(handle)` — SIGTERM, then SIGKILL after a grace period. It takes
 *     **no pid**: the only argument is an `OwnedServe`, a value this module
 *     produces and nobody else can forge (see `OWNED`). A discovered pid is
 *     therefore structurally unsignalable from here.
 *
 * Pure Node on purpose — no `vscode` and no Node http client (ADR-011's one-way
 * rule keeps `core/` free of `opencode/`): global `fetch`, and every
 * child-process / filesystem touchpoint sits behind `ServeProcessDeps`, so the
 * test suite never really spawns opencode, never reads the user's /proc, and
 * never touches the network.
 */

/** Loopback only, always. A serve LaLog starts is never reachable off-host. */
export const LOOPBACK_HOST = '127.0.0.1';

/** How long a single discovery/readiness probe may take. */
const PROBE_TIMEOUT_MS = 2000;
/** Readiness ceiling: the plan measured 3–15 s of startup, so 30 s is generous. */
const READY_TIMEOUT_MS = 30_000;
/** SIGTERM → SIGKILL grace, and how long we wait for the exit before giving up. */
const STOP_GRACE_MS = 5000;
/** Backoff between readiness probes (capped, so the ceiling stays honest). */
const READY_STEP_MS = 250;
const READY_STEP_MAX_MS = 2000;
/** Rolling stdout/stderr buffers: enough for one line, never unbounded. */
const TAIL_CHARS = 4096;

export interface ExitInfo {
  code: number | null;
  signal: string | null;
}

/** One row of the process table, as discovery sees it. */
export interface ProcessInfo {
  pid: number;
  cmdline: string;
}

/** The spawn seam: the minimum a test has to fake to own a "child process". */
export interface ChildHandle {
  pid?: number;
  onStdout(cb: (text: string) => void): void;
  onStderr(cb: (text: string) => void): void;
  onExit(cb: (code: number | null, signal: string | null) => void): void;
  onError(cb: (err: Error) => void): void;
  kill(signal: 'SIGTERM' | 'SIGKILL'): boolean;
}

/**
 * Injectable touchpoints. Anything omitted falls back to the real
 * child_process / fs / global fetch implementation.
 */
export interface ServeProcessDeps {
  fetchImpl?: typeof fetch;
  /** Enumerate running processes. Throwing ⇒ discovery finds nothing. */
  listPids?: () => Promise<ProcessInfo[]>;
  /** A pid's working directory; `null`/throw ⇒ that pid is skipped. */
  readCwd?: (pid: number) => Promise<string | null>;
  spawnChild?: (cmd: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) => ChildHandle;
  /** `ps`/`lsof` runner, resolving stdout. Rejecting ⇒ best-effort gives up. */
  execCmd?: (cmd: string, args: string[]) => Promise<string>;
  /** Password for a spawned instance when none is configured. */
  randomPassword?: () => string;
  /** Per-probe fetch timeout. */
  probeTimeoutMs?: number;
  /** SIGTERM → SIGKILL grace used by `stopServe`. */
  stopGraceMs?: number;
}

/**
 * A serve this module spawned. The brand symbol is deliberately **not
 * exported**: only `spawnServe` can mint one, so `stopServe` cannot be handed a
 * discovered pid no matter how a caller casts it.
 */
const OWNED = Symbol('lalog.ownedServe');

interface OwnedInternals {
  kill: (signal: 'SIGTERM' | 'SIGKILL') => boolean;
  exited: () => boolean;
  /** Resolve once the child is gone. */
  once: (cb: () => void) => void;
}

/** A serve LaLog owns: it started it, it may stop it, and it is on loopback. */
export interface OwnedServe {
  readonly pid: number;
  readonly url: string;
  readonly authUser: string;
  /** The password this instance was started with; `''` when unsecured. */
  readonly authPassword: string;
  /** Fires once when the process ends — our own stop, a crash, or a kill. */
  onExit(cb: (info: ExitInfo) => void): void;
  /** @internal Not exported: the only signalling path, bound to our child. */
  readonly [OWNED]: OwnedInternals;
}

/** A serve somebody else started. There is deliberately no way to stop it. */
export interface DiscoveredServe {
  readonly pid: number;
  readonly url: string;
  readonly owned: false;
}

/** Startup/spawn failures the watcher reports once and then retries. */
export class ServeProcessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ServeProcessError';
  }
}

// ---------------------------------------------------------------------------
// 1. discovery
// ---------------------------------------------------------------------------

export interface ServeCmdline {
  port: number;
  /** `--hostname` as given, or `null` when opencode was not told one. */
  hostname: string | null;
}

/**
 * Recognize an opencode **server** command line. A `--port` flag is the marker
 * (that is how `ps` shows one), the binary must be opencode, and the port must
 * be a real one. Anything else — a TUI process, `opencode run`, garbage — is
 * `null`.
 */
export function parseServeCmdline(cmdline: string): ServeCmdline | null {
  // The binary itself must be opencode — `node /x/opencode-serve.js` is not it.
  if (!/(^|[\s/\\])opencode(\s|$)/i.test(cmdline ?? '')) return null;
  const tokens = cmdline.split(/\s+/);
  let port: number | null = null;
  let hostname: string | null = null;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === '--port') {
      port = validPort(tokens[i + 1]);
      i += 1;
    } else if (token.startsWith('--port=')) {
      port = validPort(token.slice('--port='.length));
    } else if (token === '--hostname') {
      hostname = tokens[i + 1] ?? null;
      i += 1;
    } else if (token.startsWith('--hostname=')) {
      hostname = token.slice('--hostname='.length);
    }
  }
  if (port === null) return null;
  return { port, hostname };
}

/**
 * Best-effort reuse: the first already-running opencode server whose cwd is at
 * or under a workspace root **and** which answers `GET /session`. Never throws;
 * `null` simply means "spawn one instead".
 */
export async function discoverServe(
  roots: string[],
  deps: ServeProcessDeps = {}
): Promise<DiscoveredServe | null> {
  const normalized = roots.map(normalizeFsPath).filter((r) => r.length > 0);
  if (normalized.length === 0) return null;
  const list = deps.listPids ?? defaultListPids;
  const cwd = deps.readCwd ?? defaultReadCwd;

  let processes: ProcessInfo[];
  try {
    processes = await list();
  } catch {
    return null; // no /proc, no ps, permission denied: all the same to us
  }
  if (!Array.isArray(processes)) return null;

  for (const proc of processes) {
    const parsed = parseServeCmdline(proc?.cmdline ?? '');
    if (!parsed) continue;
    // A serve bound to a routable interface is not LaLog's business.
    if (parsed.hostname && !isLoopback(parsed.hostname)) continue;
    let dir: string | null = null;
    try {
      dir = await cwd(proc.pid);
    } catch {
      dir = null;
    }
    if (!dir || !underAnyRoot(dir, normalized)) continue;
    const url = `http://${LOOPBACK_HOST}:${parsed.port}`;
    if (await verifyEndpoint(url, deps)) return { pid: proc.pid, url, owned: false };
  }
  return null;
}

// ---------------------------------------------------------------------------
// 2. spawn
// ---------------------------------------------------------------------------

export interface SpawnOptions {
  /**
   * Workspace root — and the child's cwd. Required, not optional: `/session`
   * only reports sessions under the server's launch directory, so a serve
   * started anywhere else would observe nothing (verified, plan §0).
   */
  root: string;
  /** Binary to run; defaults to `opencode` (lalog.opencode.activity.opencodePath). */
  binary?: string;
  /** Fixed `--port`; `0` (default) lets opencode pick and we parse its stdout. */
  port?: number;
  /** HTTP Basic username; opencode's own default is `opencode`. */
  authUser?: string;
  /**
   * `undefined` (the default) ⇒ generate a random password, so LaLog never
   * leaves an unauthenticated local server behind. A non-empty string is used
   * as-is. An explicit `''` is the opt-out: no password, matching opencode's
   * own unsecured default.
   */
  authPassword?: string;
  /** Readiness ceiling; defaults to 30 s. */
  readyTimeoutMs?: number;
  /** Surfaced to the watcher's log sink (startup chatter, failures). */
  onLog?: (message: string) => void;
}

/**
 * Start a serve we own and wait until it answers. Resolves only on a verified
 * `GET /session`; every other exit path kills the child first, so a failed
 * attempt leaves nothing behind.
 */
export async function spawnServe(opts: SpawnOptions, deps: ServeProcessDeps = {}): Promise<OwnedServe> {
  const root = (opts.root ?? '').trim();
  if (!root) throw new ServeProcessError('spawning an opencode serve needs a workspace root as its cwd');
  const binary = opts.binary?.trim() || 'opencode';
  const requestedPort = Number.isFinite(opts.port) && (opts.port as number) > 0 ? Math.floor(opts.port as number) : 0;
  const authUser = opts.authUser?.trim() || 'opencode';
  const password = resolvePassword(opts.authPassword, deps);
  const log = opts.onLog ?? (() => {});

  const env: NodeJS.ProcessEnv = { ...process.env };
  if (password) env.OPENCODE_SERVER_PASSWORD = password;
  // The insecure opt-out must be honoured even when the surrounding shell
  // exports one: an inherited password the watcher never sends would make the
  // serve reject our own readiness probe forever.
  else delete env.OPENCODE_SERVER_PASSWORD;
  const args = ['serve', '--hostname', LOOPBACK_HOST];
  if (requestedPort) args.push('--port', String(requestedPort));

  const spawnChild = deps.spawnChild ?? defaultSpawnChild;
  let child: ChildHandle;
  try {
    child = spawnChild(binary, args, { cwd: root, env });
  } catch (e) {
    throw new ServeProcessError(`could not start '${binary}': ${describe(e)}`);
  }

  // One state object: the callbacks below mutate it, so reads inside the
  // readiness loop must not be narrowed by the initial values.
  const state: {
    exit: ExitInfo | null;
    spawnError: Error | null;
    listeningUrl: string | null;
  } = {
    exit: null,
    spawnError: null,
    listeningUrl: requestedPort ? `http://${LOOPBACK_HOST}:${requestedPort}` : null,
  };
  let stdoutTail = '';
  let stderrTail = '';
  const exitListeners: Array<(info: ExitInfo) => void> = [];
  const onceExit: Array<() => void> = [];

  const settle = () => {
    const waiters = onceExit.splice(0, onceExit.length);
    for (const waiter of waiters) waiter();
  };

  child.onStdout((text) => {
    stdoutTail = tail(stdoutTail + text);
    const url = parseListeningUrl(stdoutTail);
    if (url) state.listeningUrl = url;
  });
  child.onStderr((text) => {
    stderrTail = tail(stderrTail + text);
  });
  child.onExit((code, signal) => {
    state.exit = { code, signal };
    settle();
    for (const cb of exitListeners.slice()) cb({ code, signal });
  });
  child.onError((err) => {
    state.spawnError = err;
  });

  const handle: OwnedServe = {
    pid: child.pid ?? -1,
    url: '', // filled in below, once the port is known
    authUser,
    authPassword: password,
    onExit(cb) {
      if (state.exit) cb(state.exit);
      else exitListeners.push(cb);
    },
    [OWNED]: {
      kill: (signal) => {
        if (state.exit) return false;
        return child.kill(signal);
      },
      exited: () => state.exit !== null,
      once: (cb) => {
        if (state.exit) cb();
        else onceExit.push(cb);
      },
    },
  };

  try {
    const readyTimeoutMs = opts.readyTimeoutMs ?? READY_TIMEOUT_MS;
    let waited = 0;
    let step = READY_STEP_MS;
    for (;;) {
      if (state.exit) {
        throw new ServeProcessError(
          `opencode serve exited before it was ready (code ${state.exit.code ?? '?'}${describeTail(stderrTail)})`
        );
      }
      if (state.spawnError) {
        throw new ServeProcessError(`opencode serve failed to start: ${describe(state.spawnError)}`);
      }
      const url = state.listeningUrl;
      if (url) {
        const probe = await probeSessions(url, authUser, password, deps);
        if (probe === 'ok') {
          log(`using opencode serve at ${url}`);
          return { ...handle, url };
        }
        if (probe === 'unauthorized') {
          // We started it with the very password we are sending: something else
          // is wrong (an instance on this port we did not start, most likely).
          throw new ServeProcessError(`opencode serve at ${url} rejected LaLog's credentials; not using it`);
        }
      }
      if (waited >= readyTimeoutMs) {
        throw new ServeProcessError(
          `opencode serve did not answer /session within ${Math.round(readyTimeoutMs / 1000)}s` +
            `${url ? ` (${url})` : ' and never announced a port'}${describeTail(stderrTail)}`
        );
      }
      const wait = Math.min(step, readyTimeoutMs - waited);
      await delay(wait);
      waited += wait;
      step = Math.min(step * 2, READY_STEP_MAX_MS);
    }
  } catch (e) {
    // Never leave an orphan: whatever went wrong, our child goes with it.
    await stopHandle(handle, deps);
    throw e;
  }
}

/** `opencode server listening on http://127.0.0.1:41234` → the URL. */
export function parseListeningUrl(stdout: string): string | null {
  const match = /listening on\s+(https?:\/\/[^\s"']+)/.exec(stdout);
  if (!match) return null;
  const url = match[1];
  try {
    const parsed = new URL(url);
    // Only a loopback bind is ever accepted as "our" serve.
    if (!isLoopback(parsed.hostname)) return null;
    const port = Number(parsed.port);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
    return `http://${LOOPBACK_HOST}:${port}`;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 3. stop (owned handles only)
// ---------------------------------------------------------------------------

/**
 * SIGTERM, then SIGKILL after the grace period. There is deliberately no `pid`
 * parameter: the argument must carry this module's private brand, so a
 * discovered server cannot be signalled through this function by any cast.
 */
export async function stopServe(handle: OwnedServe, deps: ServeProcessDeps = {}): Promise<void> {
  const internals = (handle as OwnedServe | undefined)?.[OWNED];
  if (!internals || typeof internals.kill !== 'function') {
    throw new TypeError(
      'stopServe only stops a serve LaLog spawned: a discovered server is never signalled'
    );
  }
  await stopHandle(handle, deps);
}

/** The shared SIGTERM → SIGKILL → give-up sequence. */
async function stopHandle(handle: OwnedServe, deps: ServeProcessDeps): Promise<void> {
  const internals = handle[OWNED];
  if (internals.exited()) return;
  const gone = new Promise<void>((resolve) => internals.once(resolve));
  internals.kill('SIGTERM');
  const grace = deps.stopGraceMs ?? STOP_GRACE_MS;
  if (!(await raceGone(gone, grace))) {
    internals.kill('SIGKILL');
    await raceGone(gone, grace);
  }
}

/** Resolves true when the child exited in time, false when the timer fired. */
async function raceGone(gone: Promise<void>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | null = null;
  const timedOut = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), Math.max(0, ms));
    timer.unref?.();
  });
  try {
    return await Promise.race([gone.then(() => true), timedOut]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// probes
// ---------------------------------------------------------------------------

type Probe = 'ok' | 'unauthorized' | 'down';

/** One cheap `GET /session`. The body is never read: a verification only needs the status. */
async function probeSessions(
  url: string,
  authUser: string,
  authPassword: string,
  deps: ServeProcessDeps
): Promise<Probe> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.probeTimeoutMs ?? PROBE_TIMEOUT_MS);
  timer.unref?.();
  try {
    const res = await callFetch(`${url}/session`, headersFor(authUser, authPassword), controller.signal, deps);
    discardBody(res);
    if (res.status === 401 || res.status === 403) return 'unauthorized';
    return res.ok ? 'ok' : 'down';
  } catch {
    return 'down';
  } finally {
    clearTimeout(timer);
  }
}

/** Discovery verification: one request, boolean answer, no retention. */
async function verifyEndpoint(url: string, deps: ServeProcessDeps): Promise<boolean> {
  return (await probeSessions(url, 'opencode', '', deps)) === 'ok';
}

function callFetch(
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal,
  deps: ServeProcessDeps
): Promise<Response> {
  const impl = deps.fetchImpl ?? ((u: string, i?: RequestInit) => globalThis.fetch(u, i));
  return impl(url, { method: 'GET', headers, signal });
}

function headersFor(user: string, password: string): Record<string, string> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (password) headers.authorization = `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
  return headers;
}

/** A verification must not hold the ~68 KB payload open (or retain it). */
function discardBody(res: Response): void {
  try {
    const body = (res as { body?: { cancel?: () => Promise<unknown> } }).body;
    void body?.cancel?.();
  } catch {
    /* a fake without a body, or a stream already consumed */
  }
}

// ---------------------------------------------------------------------------
// defaults: /proc, ps, lsof, spawn
// ---------------------------------------------------------------------------

async function defaultListPids(): Promise<ProcessInfo[]> {
  if (process.platform === 'linux') return procProcesses();
  return psProcesses();
}

/** Linux: /proc/<pid>/cmdline (NUL-separated), one read per pid. */
function procProcesses(): ProcessInfo[] {
  let entries: string[];
  try {
    entries = fs.readdirSync('/proc');
  } catch {
    return [];
  }
  const out: ProcessInfo[] = [];
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;
    let raw: string;
    try {
      raw = fs.readFileSync(`/proc/${name}/cmdline`, 'utf8');
    } catch {
      continue; // gone, or not ours to read
    }
    const cmdline = raw.split('\0').filter(Boolean).join(' ');
    if (!cmdline) continue; // kernel thread
    out.push({ pid: Number(name), cmdline });
  }
  return out;
}

async function psProcesses(): Promise<ProcessInfo[]> {
  const stdout = await defaultExec('ps', ['-Ao', 'pid=,args=']);
  const out: ProcessInfo[] = [];
  for (const line of stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(.*\S)\s*$/.exec(line);
    if (match) out.push({ pid: Number(match[1]), cmdline: match[2] });
  }
  return out;
}

async function defaultReadCwd(pid: number): Promise<string | null> {
  if (process.platform === 'linux') {
    try {
      return fs.readlinkSync(`/proc/${pid}/cwd`);
    } catch {
      return null;
    }
  }
  if (process.platform === 'darwin') {
    try {
      const stdout = await defaultExec('lsof', ['-a', '-d', 'cwd', '-p', String(pid), '-Fn']);
      for (const line of stdout.split('\n')) {
        if (line.startsWith('n')) return line.slice(1);
      }
    } catch {
      /* lsof missing, or the pid is not ours */
    }
    return null;
  }
  // Windows has no cheap cwd lookup: discovery finds nothing, silently, and the
  // caller falls back to the configured url or to spawning.
  return null;
}

function defaultSpawnChild(
  cmd: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv }
): ChildHandle {
  // No shell: the args array keeps them inert, and stdin stays closed.
  const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], cwd: opts.cwd, env: opts.env });
  return {
    pid: child.pid,
    onStdout: (cb) => child.stdout?.on('data', (d: Buffer) => cb(d.toString())),
    onStderr: (cb) => child.stderr?.on('data', (d: Buffer) => cb(d.toString())),
    onExit: (cb) => child.on('close', (code, signal) => cb(code, signal)),
    onError: (cb) => child.on('error', (e) => cb(e as Error)),
    kill: (signal) => child.kill(signal),
  };
}

function defaultExec(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 4 * 1024 * 1024, timeout: 5000 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(String(stdout));
    });
  });
}

function defaultRandomPassword(): string {
  return crypto.randomBytes(24).toString('base64url');
}

/** `undefined` ⇒ random (the safe default); `''` ⇒ explicitly unsecured. */
function resolvePassword(configured: string | undefined, deps: ServeProcessDeps): string {
  if (configured === '') return '';
  if (typeof configured === 'string' && configured.length > 0) return configured;
  const generate = deps.randomPassword ?? defaultRandomPassword;
  return generate();
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

/** Case-insensitive filesystems only; never a blanket `toLowerCase()`. */
const CASE_INSENSITIVE_FS = process.platform === 'win32' || process.platform === 'darwin';

/** Drop trailing separators, then case-fold where the platform folds. */
export function normalizeFsPath(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, '');
  const out = trimmed.length > 0 ? trimmed : p;
  // Windows reports directories with backslashes while the session matcher joins
  // on '/', so canonicalize the separator there. Linux backslashes are legal
  // filename characters and are left alone.
  const slashed = process.platform === 'win32' ? out.replace(/\\/g, '/') : out;
  return CASE_INSENSITIVE_FS ? slashed.toLowerCase() : slashed;
}

/** Same root rule the session matcher uses: at, or one separator below. */
function underAnyRoot(directory: string, roots: string[]): boolean {
  const target = normalizeFsPath(directory);
  if (!target) return false;
  return roots.some((root) => target === root || target.startsWith(`${root}/`));
}

function isLoopback(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h === '::1' || /^127\./.test(h);
}

function validPort(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const port = Number(raw);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
}

function tail(text: string): string {
  return text.length > TAIL_CHARS ? text.slice(text.length - TAIL_CHARS) : text;
}

function describe(e: unknown): string {
  const err = e as { code?: string; message?: string } | undefined;
  if (!err) return String(e);
  return err.code === 'ENOENT' ? `${err.message ?? 'not found'} (is the opencode CLI on PATH?)` : String(err.message ?? e);
}

function describeTail(stderr: string): string {
  const last = stderr.trim().split('\n').filter(Boolean).pop();
  return last ? `: ${last.slice(0, 200)}` : '';
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}