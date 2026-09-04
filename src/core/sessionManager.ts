import * as vscode from 'vscode';
import { ThresholdsMs } from '../core/config';
import { Session, TrackedEvent, ClosedReason, SessionType } from '../core/types';
import {
  Machine,
  newMachine,
  startSession,
  autoClose,
  onActivity,
} from '../core/stateMachine';
import { SessionStore } from '../storage/sessionStore';
import { ActivityTracker } from '../core/activityTracker';
import { BreakpointDetector, BreakpointKind } from '../core/breakpoints';
import { PromptCoordinator } from '../prompts/promptCoordinator';
import { DescribeResult } from '../prompts/describeFlow';
import { updateActiveSpan } from '../core/spans';
import { LaLogPaths, workspaceKey } from '../storage/store';

export class SessionManager implements vscode.Disposable {
  private machine: Machine = newMachine();
  private session: Session | null = null;
  private activity: ActivityTracker;
  private breakpoints: BreakpointDetector;
  private prompts: PromptCoordinator;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private forceTimers: Map<string, NodeJS.Timeout> = new Map();
  private disposables: vscode.Disposable[] = [];
  private onStateChanged: () => void = () => {};

  constructor(
    private store: SessionStore,
    private th: ThresholdsMs,
    private paths: LaLogPaths
  ) {
    this.prompts = new PromptCoordinator(this.th);
    this.activity = new ActivityTracker(
      (ev, file, now) => this.onActivityEvent(ev, file, now),
      this.th,
      true
    );
    this.breakpoints = new BreakpointDetector(
      (kind) => this.onBreakpoint(kind),
      () => this.machine,
      this.th
    );
  }

  setOnStateChanged(cb: () => void): void {
    this.onStateChanged = cb;
  }

  getSession(): Session | null {
    return this.session;
  }

  getMachine(): Machine {
    return this.machine;
  }

  /** Primary workspace folder key for the current window. */
  private currentWorkspaceKey(): { key: string; name: string } | null {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) return null;
    return { key: folder.uri.fsPath, name: folder.name };
  }

  private wsKey(): string | null {
    const ws = this.currentWorkspaceKey();
    return ws ? workspaceKey(ws.key) : null;
  }

  /** Called at activation + on workspace change. */
  async openWorkspace(): Promise<void> {
    const ws = this.currentWorkspaceKey();
    if (!ws) return;
    const wsKey = workspaceKey(ws.key); // normalized to path via key()
    const wsName = ws.name;
    const now = Date.now();

    // Recover a possibly-leftover session. We never silently keep a session from
    // a previous run: deactivate() ends sessions on exit, so any remaining active
    // snapshot implies an abnormal exit. Close it rather than let it linger idle.
    const existing = this.store.loadActive(wsKey);
    if (existing) {
      const idleMs = now - existing.lastActivityAt;
      if (idleMs < this.th.resumeWindow) {
        // Very recent: same continuous session, fast re-open. Resume it.
        this.session = existing;
        this.machine = recoverActiveMachine(existing, now, this.th);
        this.activityPeek = existing.lastActivityAt;
        this.openSpanStart = null; // next activity opens a fresh span
        this.firstActivityAfterOpen = true;
        this.scheduleSave();
        this.onStateChanged();
        return;
      }
      // Stale (prior run/crash): close it, then start fresh below.
      await this.finishRecovered(existing, 'recovery-skip', existing.lastActivityAt);
    }

    this.openSpanStart = null;
    this.lastIdleArmAt = 0;

    // Collect an optional description of a previously shutdown-ended session, then
    // always start a tracked session so all work is recorded even without a
    // description (no "untracked" path on open).
    await this.describeShutdownSession(wsKey);
    const previous = await this.lastSessionFor(wsKey);
    this.session = this.store.newSession(wsKey, wsName, now);
    this.machine = newMachine();
    if (previous?.description) {
      this.session.description = previous.description;
      this.session.type = previous.type;
    }
    startSession(this.machine, now);
    this.firstActivityAfterOpen = true;
    this.scheduleSave();
    this.onStateChanged();
  }

  /** Tiny cache to distinguish "just resumed, don't accrue a gap" when the session loads. */
  private activityPeek = 0;
  private firstActivityAfterOpen = true;
  /** Earliest end of the current contiguous active run (span open end = lastActivityAt). */
  private openSpanStart: number | null = null;
  /** Cooldown: only re-arm the idle prompt after this time (ms epoch). */
  private lastIdleArmAt = 0;
  /** Guard against stacking idle prompts. */
  private idlePromptOpen = false;

  private onActivityEvent(ev: TrackedEvent, filePath?: string, now?: number): void {
    const ts = now ?? Date.now();
    if (!this.session) return;

    // Recovery: first event after open should not accrue a giant gap.
    if (this.firstActivityAfterOpen) {
      this.firstActivityAfterOpen = false;
      // set lastActivityAt to ts so the first gap is ~0
      if (this.machine.state === 'active') {
        this.machine.lastActivityAt = ts;
        this.session.lastActivityAt = ts;
      }
    }

    const prev = this.machine.lastActivityAt;
    onActivity(this.machine, ts, this.th);
    const s = this.machine.state;
    this.session.activeMinutes = this.machine.activeMinutes;

    // Continue building the active-span id. No source tag — classification happens
    // at filter time by checking which spans contain VS Code activity timestamps.
    this.accrueActivity(prev, ts);

    this.store.recordEvent(this.session, ev, filePath, ts);
    this.breakpoints.checkReturnIdle(ts);

    // schedule persistence & prompt evaluation
    this.scheduleSave();

    if (s === 'describePending') {
      this.schedulePrompt('describe');
    } else if (s === 'wrapPending') {
      this.schedulePrompt('wrap');
    }
  }

  /** Maintain the bounded activity timestamp log and the open active span. */
  private accrueActivity(prev: number | null, now: number): void {
    if (!this.session) return;
    if (this.session.activityTs.length < 20000) this.session.activityTs.push(now);
    this.lastIdleArmAt = now + this.th.idleConfirm;
    const res = updateActiveSpan(prev, now, this.th.idleGap, this.openSpanStart);
    this.openSpanStart = res.openSpanStart;
    if (res.closed) this.session.activeSpans.push(res.closed);
  }

  private closeOpenSpanAt(until: number): void {
    if (!this.session) return;
    if (this.openSpanStart !== null && until > this.openSpanStart) {
      this.session.activeSpans.push({ start: this.openSpanStart, end: until });
    }
    this.openSpanStart = null;
  }

  /** Persisted totals always equal the sum of finalized spans. */
  private syncSessionActive(): void {
    if (!this.session) return;
    this.session.activeMinutes = this.machine.activeMinutes;
  }

  /**
   * 'Are you still there?' — called from the heartbeat. If the user has been
   * idle >= idleConfirm and confirms they're still working (e.g. outside VS
   * Code), the idle period counts as active but has no VS Code activity, so
   * filter-time classification tags it 'outside'.
   */
  private checkIdle(now: number): void {
    if (!this.session || this.idlePromptOpen) return;
    const m = this.machine;
    if (m.state !== 'active' && m.state !== 'describePending' && m.state !== 'wrapPending' && m.state !== 'grace') {
      return;
    }
    if (m.lastActivityAt === null) return;
    if (now - m.lastActivityAt < this.th.idleConfirm) return;
    if (now < this.lastIdleArmAt) return;
    this.idlePromptOpen = true;
    const session = this.session;
    void this.prompts.askStillWorking(session).then((choice) => {
      this.idlePromptOpen = false;
      this.lastIdleArmAt = Date.now() + this.th.idleConfirm;
      if (choice === 'end') {
        void this.endSession('user');
      } else if (choice === 'active') {
        this.accrueOutsideConfirmed(Date.now());
      }
    });
  }

  /** A confirmed 'still working' idle period becomes an (outside) active span. */
  private accrueOutsideConfirmed(now: number): void {
    if (!this.session) return;
    const m = this.machine;
    if (m.lastActivityAt === null) return;
    this.closeOpenSpanAt(m.lastActivityAt);
    if (now > m.lastActivityAt) {
      this.session.activeSpans.push({ start: m.lastActivityAt, end: now });
      m.activeMinutes += now - m.lastActivityAt;
    }
    this.session.activeMinutes = m.activeMinutes;
    m.lastActivityAt = now;
    this.openSpanStart = now;
    this.scheduleSave();
    this.onStateChanged();
  }

  private onBreakpoint(kind: BreakpointKind): void {
    // A breakpoint arrives; if a prompt is pending, deliver now.
    const s = this.machine.state;
    if (s === 'describePending') {
      this.presentDescribe(kind);
    } else if (s === 'wrapPending') {
      this.presentWrap(kind);
    }
  }

  private schedulePrompt(kind: 'describe' | 'wrap'): void {
    // If already scheduled, don't stack.
    if (this.forceTimers.has(kind)) return;
    const forceMs =
      kind === 'describe' ? this.th.describeForce - this.th.describeAt : this.th.wrapForce - this.th.wrapAt;
    const timer = setTimeout(() => {
      this.forceTimers.delete(kind);
      if (kind === 'describe') {
        this.presentDescribe(null);
      } else {
        this.presentWrap(null);
      }
    }, Math.max(1000, forceMs));
    this.forceTimers.set(kind, timer);
  }

  private presentDescribe(breakpoint: BreakpointKind | null): void {
    if (!this.session) return;
    const s = this.machine.state;
    if (s !== 'describePending') return;
    void this.runDescribe(breakpoint);
  }

  // Exposed for manual "Describe now" command.
  presentDescribeNow(): void {
    if (!this.session) return;
    if (this.machine.state === 'idle') {
      startSession(this.machine, Date.now());
    }
    this.machine.state = 'describePending';
    this.presentDescribe(null);
  }

  private async runDescribe(breakpoint: BreakpointKind | null): Promise<void> {
    if (!this.session) return;
    const session = this.session;
    const sameAsLast = this.lastDescriptionFor ? await this.lastDescriptionFor(session.workspaceKey) : undefined;
    const result = await this.prompts.askDescribe(this.machine, session, breakpoint, sameAsLast);
    if (!result) return;
    this.applyDescribeResult(session, result);
  }

  private async applyDescribeResult(s: Session, result: DescribeResult): Promise<void> {
    const now = Date.now();
    if (result.choice === 'described') {
      const text = result.text.trim();
      s.type = result.type;
      s.description = text;
      s.needsDescription = false;
      s.notes.push({ at: now, text });
      this.machine.describedThisSession = true;
      this.machine.state = this.machine.activeMinutes >= this.th.wrapAt ? 'wrapPending' : 'active';
      if (this.machine.state === 'wrapPending') this.schedulePrompt('wrap');
    } else if (result.choice === 'later') {
      s.needsDescription = true;
      this.machine.state = 'active';
    } else {
      s.needsDescription = true;
      this.machine.state = 'active';
    }
    this.scheduleSave();
    this.onStateChanged();
  }

  private presentWrap(breakpoint: BreakpointKind | null): void {
    if (!this.session) return;
    if (this.machine.state !== 'wrapPending' && this.machine.state !== 'grace') return;
    void this.runWrap(breakpoint);
  }

  private async runWrap(breakpoint: BreakpointKind | null): Promise<void> {
    if (!this.session) return;
    const s = this.session;
    const result = await this.prompts.askWrap(this.machine, s, breakpoint);
    if (result.choice === 'skipped') return;
    await this.applyWrapResult(s, result);
  }

  private async applyWrapResult(s: Session, result: { choice: string }): Promise<void> {
    const now = Date.now();
    if (result.choice === 'wrap-new') {
      await this.endSession('user');
      await this.startFresh();
      return;
    }
    if (result.choice === 'extend' || result.choice === 'extend-described') {
      this.machine.graceExtensions += 1;
      if (this.machine.graceExtensions >= this.th.maxGraceExtensions) {
        // must describe to extend
        await this.runDescribe(null);
      }
      this.machine.state = 'grace';
      this.machine.lastActivityAt = now;
      // grace window: re-arm wrap after grace, capped later by hardSplit via activity
      const graceTimer = setTimeout(() => {
        this.machine.state = 'wrapPending';
        this.schedulePrompt('wrap');
      }, this.th.grace);
      setTimeout(() => graceTimer.unref(), 0);
      this.scheduleSave();
      this.onStateChanged();
      return;
    }
    if (result.choice === 'add-description') {
      await this.runDescribe(null);
      return;
    }
  }

  private lastDescriptionFor: ((wsKey: string) => Promise<string | undefined>) | null = null;
  private async lastSessionFor(wsKey: string): Promise<Session | undefined> {
    const all = await this.store.loadAll();
    return all.filter((x) => x.workspaceKey === wsKey).pop();
  }

  /** Offer an optional description for the most recent shutdown-ended session. */
  private async describeShutdownSession(wsKey: string): Promise<void> {
    const all = await this.store.loadAll();
    const last = all
      .filter(
        (x) =>
          x.workspaceKey === wsKey &&
          x.closedReason === 'vscode-shutdown' &&
          !x.description &&
          !x.needsDescription
      )
      .pop();
    if (!last) return;
    const text = await this.prompts.askShutdownDescription(last);
    if (text) {
      last.description = text;
      last.needsDescription = false;
      last.notes.push({ at: Date.now(), text });
      await this.store.updateSession(last.id, {
        description: last.description,
        needsDescription: false,
        notes: last.notes,
      });
    }
  }

  async setLastDescriptionProvider(fn: (wsKey: string) => Promise<string | undefined>): Promise<void> {
    this.lastDescriptionFor = fn;
  }

  /** Inject the AI draft callback into the describe prompt (optional). */
  setAiDraft(fn: (() => Promise<string>) | undefined): void {
    this.prompts.aiDraft = fn;
  }

  /** Wrap the current window's session for a reason. Async: returns the closed session. */
  async endSession(reason: Exclude<ClosedReason, 'workspace-switch'>): Promise<Session | null> {
    if (!this.session) return null;
    const s = this.session;
    const ended = autoClose(this.machine, Date.now());
    this.closeOpenSpanAt(ended.endedAt);
    s.activeMinutes = ended.activeMinutes;
    await this.store.close(s, reason, ended.endedAt);
    this.clearForceTimers();
    this.session = null;
    this.machine = newMachine();
    this.openSpanStart = null;
    this.firstActivityAfterOpen = true;
    this.onStateChanged();
    return s;
  }

  /** Suspend (workspace switch) — persist as active, don't close. */
  suspendForSwitch(): void {
    if (!this.session) return;
    this.scheduleSave();
  }

  async startFresh(): Promise<void> {
    const ws = this.currentWorkspaceKey();
    if (!ws) return;
    const now = Date.now();
    const wsKey = workspaceKey(ws.key);
    this.session = this.store.newSession(wsKey, ws.name, now);
    this.machine = newMachine();
    startSession(this.machine, now);
    this.firstActivityAfterOpen = true;
    this.scheduleSave();
    this.onStateChanged();
  }

  /** Persist active session snapshot (heartbeat + on change). */
  private scheduleSave(): void {
    if (!this.session) return;
    this.store.saveActive(this.session);
  }

  private clearForceTimers(): void {
    this.forceTimers.forEach((t) => clearTimeout(t));
    this.forceTimers.clear();
  }

  private async finishRecovered(
    s: Session,
    reason: ClosedReason,
    endedAt: number
  ): Promise<void> {
    // allow the spam-check to skip note if not needed
    s.activeMinutes = Math.max(s.activeMinutes, 0);
    const note = await this.prompts.askClosingNote(s);
    if (note !== null && note.trim()) {
      s.description = note.trim();
      s.needsDescription = false;
      s.notes.push({ at: Date.now(), text: note.trim() });
    } else {
      s.needsDescription = !s.description;
    }
    await this.store.close(s, reason, endedAt);
  }

  start(): void {
    this.activity.start();
    void this.openWorkspace();
    this.heartbeatTimer = setInterval(() => {
      this.scheduleSave();
      this.checkIdle(Date.now());
      this.checkAutoEnd(Date.now());
    }, 60 * 1000);
  }

  /**
   * Safety net for genuinely abandoned sessions (the only in-window boundary,
   * ADR-010). The idle-confirm prompt keeps lastActivityAt reset when the user
   * confirms they're still working, so this only fires for real absence: after
   * autoEndIdle of no VS Code activity AND no confirmation. endedAt is
   * lastActivityAt (active-only) so nothing idle is ever counted.
   */
  private checkAutoEnd(now: number): void {
    if (!this.session) return;
    if (this.idlePromptOpen) return;
    const m = this.machine;
    if (m.lastActivityAt === null) return;
    if (now - m.lastActivityAt < this.th.autoEndIdle) return;
    void this.endSession('auto-idle');
  }

  dispose(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.clearForceTimers();
    this.activity.dispose();
    this.breakpoints.dispose();
    this.disposables.forEach((d) => d.dispose());
    // Persist any active session on shutdown so it can recover next launch.
    this.scheduleSave();
  }

  /**
   * Called from deactivate() on VS Code shutdown. Ends any active session with
   * reason 'vscode-shutdown' so it is recorded and not left as a dangling
   * recoverable snapshot. deactivate() is synchronous/time-limited, so we cannot
   * reliably prompt here; the optional description is collected on next launch.
   */
  async shutdown(): Promise<void> {
    if (this.session) {
      await this.endSession('vscode-shutdown');
    }
    this.clearForceTimers();
    this.activity.dispose();
    this.breakpoints.dispose();
    this.disposables.forEach((d) => d.dispose());
  }
}

/** Rebuild machine state from a loaded session. */
function recoverActiveMachine(s: Session, now: number, th: ThresholdsMs): Machine {
  const m = newMachine();
  m.state = 'active';
  m.lastActivityAt = now; // avoid accruing reopened-gap; first event resets
  m.startedAt = s.startedAt;
  m.activeMinutes = s.activeMinutes;
  m.describedThisSession = !!s.description;
  return m;
}
