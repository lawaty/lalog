import type { ServeActivityWatcher } from '../core/types';
import {
  discoverServe,
  normalizeFsPath,
  spawnServe,
  stopServe,
  type DiscoveredServe,
  type OwnedServe,
  type SpawnOptions,
} from './serveProcess';

/**
 * Observes an opencode server as a LaLog activity source (US-7.2, ADR-032 →
 * ADR-033). Pure Node on purpose: it imports neither `vscode` nor any Node http
 * module — it uses the global `fetch` with an injectable implementation, so the
 * whole thing is testable without the VS Code host.
 *
 * Contract, in one paragraph: LaLog only *reads* session metadata (id,
 * directory, title, `time.updated`) and mutates nothing. A session seen for the
 * first time is a baseline, never an event; a previously observed session whose
 * directory is this workspace and whose `time.updated` grew is ONE activity
 * event, however many sessions bumped at the same poll. A failed poll drops the
 * baseline so the next success re-baselines — LaLog never fabricates time for a
 * gap it did not observe.
 *
 * Three lightness rules (ADR-033), and they are the point of the design:
 *
 *  - **Nothing runs unless something is being tracked.** With no open LaLog
 *    session (`shouldObserve() === false`) the watcher parks itself: the timer
 *    is cancelled, no request is made, and a serve LaLog started is stopped.
 *    `wake()` re-arms it when tracking resumes.
 *  - **Two tiers, because the cost is per session, not per tick.** Listing
 *    every session costs ~164-283 ms of the server's CPU and ~68 KB (it
 *    serializes every session's summary, cost and tokens, and there is no ETag
 *    to make it a 304). Asking for one session costs ~48 ms and ~540 B. So the
 *    frequent **activity poll** (`GET /session/{id}`, once per tracked session)
 *    runs at `pollMs`, and the **discovery poll** (`GET /session`, the full
 *    list) runs only every `discoveryMs` — the one thing a list is needed for:
 *    noticing an id LaLog has never seen. A tracked session whose `time.updated`
 *    is already older than `now - discoveryMs` is skipped outright (an old
 *    session cannot meaningfully bump), which normally leaves the fast path
 *    issuing one or two requests. Requests within a tick are strictly sequential.
 *  - **Reuse before spawn, then stop adapting.** `ensureServer()` first looks
 *    for a serve that is already running for this workspace (best-effort,
 *    silent) and only spawns its own when there is none. Cadence is `fastMs`
 *    while work is being seen and doubles per quiet poll up to `slowMs`, so a
 *    quiet workspace costs a request or two every five minutes instead of three
 *    list fetches a minute. Retention is deliberately tiny: only `{directory,
 *    updated}` for workspace sessions — never the parsed response, never a
 *    non-matching session.
 *
 * LaLog never sends prompts, never signals a serve it did not start, and never
 * binds beyond loopback (ADR-033).
 */

/** LaLog's own bridge runs `opencode run --title 'LaLog …'`. Never count it. */
const SELF_TITLE_PREFIX = 'LaLog ';

/** Consecutive connect failures before the poll interval backs off. */
const BACKOFF_AFTER_FAILURES = 3;
/** Multiplier applied once the watcher is in backoff. */
const BACKOFF_FACTOR = 5;
/** Hard ceiling on a backed-off delay, so a restored server is picked up promptly. */
const MAX_BACKOFF_MS = 60_000;
/** Per-request timeout. A hung server must not hold the poll chain. */
const REQUEST_TIMEOUT_MS = 5000;
/**
 * Ceiling for the adaptive (quiet) cadence. The `idleConfirm / 3` clamp in
 * `opencodePollMs` bounds the **fast** end only — re-applying it here would
 * collapse the backoff to a constant under `debugTimeScale` and buy nothing,
 * because the slowest cadence at default thresholds is exactly `idleConfirm / 3`
 * (15 min / 3 = 5 min): three polls always cross idle confirmation.
 */
const DEFAULT_SLOW_MS = 5 * 60_000;
/**
 * Cadence of the full-list discovery poll when the caller does not scale one
 * (mirrors `DEFAULT_SLOW_MS`; `extension.ts` always passes `opencodeDiscoveryMs`).
 * Also the freshness window: a tracked session untouched for this long is not
 * worth a request.
 */
const DEFAULT_DISCOVERY_MS = 180 * 1000;
/** Backoff between attempts to obtain a serve after ensure failed. */
const ENSURE_BACKOFF_BASE_MS = 5000;
const ENSURE_BACKOFF_MAX_MS = 5 * 60_000;

/** The three serve-lifecycle calls the watcher needs; injectable for tests. */
export interface ServeLifecycle {
  /** Best-effort: an already-running serve for these roots, or null. */
  discover(roots: string[]): Promise<DiscoveredServe | null>;
  /** Start a serve we own. Rejects when it never became ready. */
  spawn(opts: SpawnOptions): Promise<OwnedServe>;
  /** Stop a serve we spawned. Never accepts a discovered pid. */
  stop(handle: OwnedServe): Promise<void>;
}

function defaultLifecycle(): ServeLifecycle {
  return {
    discover: (roots) => discoverServe(roots),
    spawn: (opts) => spawnServe(opts),
    stop: (handle) => stopServe(handle),
  };
}

export interface ServeWatcherOptions {
  /**
   * Base URL of the serve instance, e.g. `http://127.0.0.1:4096`. Used only
   * when lifecycle management is off (or there is no workspace root).
   */
  url: string;
  /** Fast poll interval in ms (already scaled/clamped by `opencodePollMs`). */
  pollMs: number;
  /** Workspace roots (fs paths) whose sessions count as activity. */
  roots: string[];
  /** HTTP Basic username; only sent when `authPassword` is set. */
  authUser?: string;
  /** HTTP Basic password (opencode's `OPENCODE_SERVER_PASSWORD`). */
  authPassword?: string;
  /**
   * Reuse-or-spawn the serve (ADR-033). Default `false` — observe-only, which
   * polls `url` and manages nothing. `extension.ts` opts in from
   * `lalog.opencode.activity.manageServe` (setting default `true`).
   */
  manageServe?: boolean;
  /** Binary to spawn; ignored unless `manageServe`. Mirrors `lalog.ai.opencodePath`. */
  opencodePath?: string;
  /** Fixed `--port` for a spawned serve; `0` = let opencode choose. */
  spawnPort?: number;
  /**
   * Cadence ceiling for quiet polls, in ms (already scaled by
   * `opencodeSlowPollMs`). Defaults to 5 minutes.
   */
  slowMs?: number;
  /**
   * How often the full session list is re-read, in ms (already scaled/clamped by
   * `opencodeDiscoveryMs`). Defaults to 3 minutes. This is the detection latency
   * for a brand-new chat, and the freshness window for the activity polls.
   */
  discoveryMs?: number;
  /**
   * Is LaLog tracking anything right now? While this is `false` the watcher
   * makes **zero** requests and keeps no timer — the single biggest lightness
   * win (ADR-033). Defaults to always observing.
   */
  shouldObserve?: () => boolean;
  /** Called at most once per poll, with the observation time. */
  onActivity: (now: number) => void;
  /** Warning sink; defaults to a `console.warn` prefixed with `[lalog]`. */
  log?: (message: string) => void;
  /** Injected for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Injected for tests; defaults to the real `serveProcess` functions. */
  lifecycle?: ServeLifecycle;
}

/** The only fields of a serve session LaLog ever looks at. */
interface ServeSession {
  id: string;
  directory: string;
  updated: number;
  title?: string;
}

/** Per-session observation state, kept across polls — the whole footprint. */
interface Observation {
  directory: string;
  updated: number;
}

/** The outcome of one `GET /session/{id}`, which can fail three ways. */
type SingleSession =
  | { kind: 'ok'; session: ServeSession }
  /** The server has no such session (404): it was deleted or moved away. */
  | { kind: 'gone' }
  /** An entry without a usable id/directory/`time.updated` — skipped, not guessed. */
  | { kind: 'skipped' };

/** Where the next poll goes, and with which credentials. */
interface Endpoint {
  url: string;
  authUser: string;
  authPassword: string;
}

/** Response we cannot recover from by retrying: stop and warn once. */
class ServeStop extends Error {}

/** `GET /session/{id}` answered 404: that one session is gone, not the endpoint. */
class ServeGone extends Error {}

export class ServeWatcher implements ServeActivityWatcher {
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;
  private disposed = false;
  private stopped = false;
  private failures = 0;
  /** Consecutive quiet polls; drives the adaptive cadence. */
  private quietStreak = 0;
  private seen = new Map<string, Observation>();
  /**
   * When the next full-list discovery poll is due (0 = now, which is why the
   * first poll always lists). Cleared to 0 by any failed poll, so an outage
   * re-discovers — and re-baselines — instead of waiting out the window.
   */
  private discoveryDueAt = 0;
  private roots: string[];
  private warn: (message: string) => void;
  private log: (message: string) => void;
  private lifecycle: ServeLifecycle;
  private manageServe: boolean;
  /** The resolved serve: discovered, or the one we spawned. */
  private target: Endpoint | null = null;
  /** Non-null only while LaLog owns the process it may stop. */
  private owned: OwnedServe | null = null;
  private ensureBusy = false;
  private ensureFailures = 0;
  private ensureNotBefore = 0;

  constructor(private opts: ServeWatcherOptions) {
    this.roots = opts.roots.map(normalizeFsPath).filter((r) => r.length > 0);
    this.warn = opts.log ?? ((m: string) => console.warn(`[lalog] ${m}`));
    this.log = this.warn;
    this.lifecycle = opts.lifecycle ?? defaultLifecycle();
    // Opt in explicitly: the observe-only default is what ADR-032 shipped, and
    // a watcher nobody asked to manage a process must never manage one.
    this.manageServe = opts.manageServe === true && this.roots.length > 0;
  }

  /** Begin polling. The first poll is immediate; a stopped watcher resumes. */
  start(): void {
    if (this.disposed || this.timer || this.inFlight) return;
    this.stopped = false;
    this.failures = 0;
    this.quietStreak = 0;
    this.timer = this.arm(0);
  }

  /**
   * Re-arm after the watcher parked itself because nothing was being tracked
   * (`shouldObserve() === false`). A no-op while a poll is armed, after
   * `dispose()`, and after a stop-with-warning — a parked watcher wakes up, a
   * stopped one stays stopped until its configuration changes.
   */
  wake(): void {
    if (this.disposed || this.stopped || this.timer || this.inFlight) return;
    this.start();
  }

  /** True while a poll timer is armed (diagnostics + tests). */
  get armed(): boolean {
    return this.timer !== null;
  }

  /** The retained footprint: workspace sessions only, two fields each. */
  retainedSessionIds(): string[] {
    return [...this.seen.keys()];
  }

  /** Stop polling for good: clear the timer, forget observations, release the serve. */
  dispose(): void {
    this.disposed = true;
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.seen.clear();
    this.failures = 0;
    this.releaseOwned();
  }

  /** Chain the next poll — never `setInterval`, so backoff can vary. */
  private arm(ms: number): NodeJS.Timeout {
    const timer = setTimeout(() => {
      this.timer = null;
      void this.poll();
    }, Math.max(0, ms));
    timer.unref?.();
    return timer;
  }

  /**
   * Delay until the next poll.
   *
   * Two layers. An outage (v1) backs off ×5 after three consecutive failures,
   * capped at a minute. On top of that the cadence is adaptive: `fastMs` while
   * work is being seen, ×2 per consecutive quiet poll, capped at `slowMs`, and
   * immediately back to `fastMs` on a bump or a newly seen session. The
   * `idleConfirm / 3` clamp lives on the fast end only (see `DEFAULT_SLOW_MS`).
   */
  private nextDelayMs(): number {
    const fast = Math.max(1, this.opts.pollMs);
    if (this.failures >= BACKOFF_AFTER_FAILURES) return Math.min(fast * BACKOFF_FACTOR, MAX_BACKOFF_MS);
    const slow = Math.max(fast, this.opts.slowMs ?? DEFAULT_SLOW_MS);
    return Math.min(fast * 2 ** this.quietStreak, slow);
  }

  private observing(): boolean {
    return this.opts.shouldObserve ? this.opts.shouldObserve() : true;
  }

  private get discoveryMs(): number {
    return Math.max(1, this.opts.discoveryMs ?? DEFAULT_DISCOVERY_MS);
  }

  private async poll(): Promise<void> {
    if (this.disposed || this.stopped || this.inFlight) return;
    if (!this.observing()) {
      // Nothing is being tracked: cancel the timer (there is none to re-arm),
      // make no request, and let go of a serve we started. `wake()` resumes.
      this.releaseOwned();
      return;
    }
    this.inFlight = true;
    try {
      if (this.manageServe) {
        const ready = await this.ensureServer();
        if (this.disposed || this.stopped) return;
        if (!ready) {
          // No serve to observe: an observation gap, handled like a failed poll
          // (baseline dropped, silent, retried with backoff) — never guessed at.
          this.seen.clear();
          this.discoveryDueAt = 0;
          this.failures += 1;
          return;
        }
      }
      await this.tick();
      this.failures = 0;
    } catch (e) {
      if (this.disposed) return;
      // Any failed poll breaks observation continuity: drop the baseline so the
      // next success re-baselines instead of reporting the outage as work, and
      // re-run discovery next tick — a re-baseline needs the list.
      this.seen.clear();
      this.discoveryDueAt = 0;
      this.failures += 1;
      if (e instanceof ServeStop) {
        this.stopped = true;
        this.warn(`${e.message}. LaLog stopped polling; change lalog.opencode.activity.* to restart.`);
        // An endpoint we cannot read is no use to us — including the child we
        // started, which would otherwise keep a large process alive all session.
        this.releaseOwned();
      }
      // Connect failures, timeouts and 5xx are expected: retry silently.
    } finally {
      this.inFlight = false;
      if (!this.disposed && !this.stopped && this.observing()) this.timer = this.arm(this.nextDelayMs());
    }
  }

  /**
   * One poll, in two tiers and strictly one request at a time.
   *
   * 1. **Discovery** (`GET /session`), when due: the only way to learn an id we
   *    have never seen. Its answer is authoritative — the tracked set is exactly
   *    the workspace sessions in the list, so one that vanished is forgotten.
   * 2. **Activity** (`GET /session/{id}`), for each tracked session that could
   *    still bump (`time.updated` newer than `now - discoveryMs`). Skipped
   *    entirely on a discovery tick, which has just answered for every session.
   *
   * Requests are sequential on purpose: a fan-out would pile instantaneous load
   * onto a process that is already saturated.
   */
  private async tick(): Promise<void> {
    const now = Date.now();
    const discovering = now >= this.discoveryDueAt;
    // Untouched entries are carried over: a tick that samples one session says
    // nothing about the others, and only a full list may forget one.
    const seen = new Map(this.seen);
    let bumped = false;
    let opened = false;

    if (discovering) {
      const sessions = await this.fetchSessionList();
      if (this.disposed) return;
      this.discoveryDueAt = now + this.discoveryMs;
      seen.clear();
      for (const s of sessions) {
        if (s.title?.startsWith(SELF_TITLE_PREFIX)) continue;
        if (!this.matchesRoot(s.directory)) continue;
        const prev = this.seen.get(s.id);
        if (!prev) opened = true;
        else if (s.updated > prev.updated) bumped = true;
        seen.set(s.id, { directory: s.directory, updated: s.updated });
      }
    }

    if (!discovering) {
      const cutoff = now - this.discoveryMs;
      for (const [id, obs] of seen) {
        if (this.disposed || this.stopped) return;
        // An old session cannot meaningfully bump inside the next window.
        if (obs.updated < cutoff) continue;
        const one = await this.fetchSession(id);
        if (one.kind === 'gone') {
          seen.delete(id);
          continue;
        }
        if (one.kind !== 'ok') continue;
        const s = one.session;
        // A session renamed into LaLog's own prefix stops counting at once; the
        // next discovery poll drops it entirely.
        if (s.title?.startsWith(SELF_TITLE_PREFIX)) continue;
        if (s.updated > this.seen.get(id)!.updated) bumped = true;
        seen.set(id, { directory: s.directory, updated: s.updated });
      }
    }

    this.seen = seen;
    // Either signal means "there is life here": back to the fast cadence. A new
    // session still emits nothing — first sight is a baseline, never an event.
    this.quietStreak = bumped || opened ? 0 : this.quietStreak + 1;
    if (bumped) this.opts.onActivity(now);
  }

  /** A session counts when its directory is, or is under, a workspace root. */
  private matchesRoot(directory: string): boolean {
    const target = normalizeFsPath(directory);
    if (!target) return false;
    return this.roots.some((root) => target === root || target.startsWith(`${root}/`));
  }

  /**
   * Reuse first, spawn only when there is nothing to reuse (ADR-033). Retried
   * with backoff after a failure; the resolved endpoint is reused until the
   * serve exits or the watcher releases it.
   */
  private async ensureServer(): Promise<boolean> {
    if (this.target || this.ensureBusy) return this.target !== null;
    const root = this.roots[0];
    if (!root) return false;
    if (this.ensureFailures > 0 && Date.now() < this.ensureNotBefore) return false;

    this.ensureBusy = true;
    try {
      const found = await this.lifecycle.discover(this.roots);
      if (this.disposed || this.stopped) return false;
      if (found) {
        // The user's own server: observe it, own nothing, stop nothing.
        this.target = { url: found.url, authUser: this.authUser, authPassword: this.authPassword ?? '' };
        this.ensureFailures = 0;
        this.log(`observing the opencode serve already running at ${found.url}`);
        return true;
      }
      const owned = await this.lifecycle.spawn({
        root,
        binary: this.opts.opencodePath,
        port: this.opts.spawnPort,
        authUser: this.authUser,
        // Pass the tri-state straight through: `undefined` (unset) makes
        // spawnServe generate a random password, an explicit `''` is the
        // documented opt-out to run it unsecured. Collapsing `''` to undefined
        // here would silently do the opposite of what the user asked for.
        authPassword: this.opts.authPassword,
        onLog: (m) => this.log(m),
      });
      if (this.disposed || this.stopped) {
        // Disposed mid-startup: hand the child straight back. `stop` only ever
        // accepts a handle this module produced, so this can never signal a
        // foreign process.
        await this.lifecycle.stop(owned);
        return false;
      }
      owned.onExit(() => this.onOwnedExit());
      this.owned = owned;
      this.target = { url: owned.url, authUser: owned.authUser, authPassword: owned.authPassword };
      this.ensureFailures = 0;
      return true;
    } catch (e) {
      this.ensureFailures += 1;
      const wait = Math.min(
        ENSURE_BACKOFF_BASE_MS * 2 ** (this.ensureFailures - 1),
        ENSURE_BACKOFF_MAX_MS
      );
      this.ensureNotBefore = Date.now() + wait;
      this.log(
        `no opencode serve available (${message(e)}); retrying in ${Math.round(wait / 1000)}s`
      );
      return false;
    } finally {
      this.ensureBusy = false;
    }
  }

  /** Our own serve exited (crash, or the user killed it): re-ensure next tick. */
  private onOwnedExit(): void {
    if (!this.owned) return;
    this.owned = null;
    this.target = null;
    this.ensureFailures = 0;
    this.ensureNotBefore = 0;
    this.log('the opencode serve LaLog started has exited; looking again on the next poll');
  }

  /** Drop the serve we own — and only that one. A discovered server is untouchable. */
  private releaseOwned(): void {
    const owned = this.owned;
    this.owned = null;
    this.target = null;
    this.ensureFailures = 0;
    this.ensureNotBefore = 0;
    if (!owned) return;
    void this.lifecycle.stop(owned).catch(() => {});
  }

  private get authUser(): string {
    return this.opts.authUser ?? 'opencode';
  }

  private get authPassword(): string {
    return this.opts.authPassword ?? '';
  }

  /** The endpoint in force: the managed serve if any, else the configured url. */
  private endpoint(): Endpoint {
    return (
      this.target ?? {
        url: this.opts.url.replace(/\/+$/, ''),
        authUser: this.authUser,
        authPassword: this.authPassword,
      }
    );
  }

  /**
   * The rare tier: `GET /session`, every session the serve knows about (~68 KB,
   * ~164-283 ms of its CPU). Used only to discover ids we have not seen — and
   * retention is the same two fields per workspace session: the parsed array
   * (~68 KB of summaries, costs and tokens) dies with this frame, and the
   * `Response` went out of scope in `fetchJson`.
   */
  private async fetchSessionList(): Promise<ServeSession[]> {
    const body = await this.fetchJson('/session');
    return parseSessions(body);
  }

  /**
   * The frequent tier: `GET /session/{id}`, one session, ~540 B and ~48 ms.
   * A 404 is not a failure — it means the session is gone, and it is forgotten
   * rather than kept as a stale baseline. Auth or a dead endpoint still stops
   * the watcher, exactly as on the list.
   */
  private async fetchSession(id: string): Promise<SingleSession> {
    let body: unknown;
    try {
      body = await this.fetchJson(`/session/${encodeURIComponent(id)}`);
    } catch (e) {
      if (e instanceof ServeGone) return { kind: 'gone' };
      throw e;
    }
    const session = parseSession(body);
    return session ? { kind: 'ok', session } : { kind: 'skipped' };
  }

  /**
   * One authenticated GET with a bounded timeout, parsed as JSON. 401/403 and a
   * non-JSON body are unrecoverable (`ServeStop`); everything else — 5xx, a
   * refused connection — is an ordinary failed poll.
   */
  private async fetchJson(path: string): Promise<unknown> {
    const endpoint = this.endpoint();
    const controller = new AbortController();
    const abort = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    abort.unref?.();
    try {
      const res = await this.fetch(`${endpoint.url}${path}`, {
        method: 'GET',
        signal: controller.signal,
        headers: headersFor(endpoint.authUser, endpoint.authPassword),
      });
      if (res.status === 404 && path !== '/session') throw new ServeGone();
      if (res.status === 401 || res.status === 403 || res.status === 404) {
        throw new ServeStop(`opencode serve replied ${res.status} for ${path}`);
      }
      if (!res.ok) {
        throw new Error(`opencode serve replied ${res.status}`);
      }
      try {
        return await res.json();
      } catch {
        throw new ServeStop('opencode serve returned a body that is not JSON');
      }
    } finally {
      clearTimeout(abort);
    }
  }

  private fetch(url: string, init: RequestInit): Promise<Response> {
    const impl = this.opts.fetchImpl ?? ((u: string, i?: RequestInit) => globalThis.fetch(u, i));
    return impl(url, init);
  }
}

/** HTTP Basic only when a password is configured (opencode's own rule). */
function headersFor(user: string, password: string): Record<string, string> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (password) {
    headers.authorization = `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
  }
  return headers;
}

/**
 * Validate the payload shape. The body must be an array; entries without a
 * string id/directory or a numeric `time.updated` are skipped, never guessed.
 */
export function parseSessions(body: unknown): ServeSession[] {
  if (!Array.isArray(body)) {
    throw new ServeStop('opencode serve returned an unexpected payload for /session (not a list of sessions)');
  }
  const out: ServeSession[] = [];
  for (const raw of body) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const session = sessionFields(raw as Record<string, unknown>);
    if (session) out.push(session);
  }
  return out;
}

/**
 * The single-session endpoint, which must answer with one session: a body that
 * is not an object at all is a shape the watcher cannot use, so it stops rather
 * than quietly reporting nothing.
 */
export function parseSession(body: unknown): ServeSession | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ServeStop('opencode serve returned an unexpected payload for /session/{id} (not a session)');
  }
  return sessionFields(body as Record<string, unknown>);
}

/** The four metadata fields, and nothing else: an entry without them is skipped. */
function sessionFields(e: Record<string, unknown>): ServeSession | null {
  const time = e.time as { updated?: unknown } | undefined;
  const updated = time?.updated;
  if (typeof e.id !== 'string' || typeof e.directory !== 'string') return null;
  if (typeof updated !== 'number' || !Number.isFinite(updated)) return null;
  return {
    id: e.id,
    directory: e.directory,
    updated,
    title: typeof e.title === 'string' ? e.title : undefined,
  };
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}