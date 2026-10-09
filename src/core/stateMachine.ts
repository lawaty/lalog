import { SessionState } from './types';
import { ThresholdsMs } from './config';

export interface Machine {
  state: SessionState;
  lastActivityAt: number | null;
  startedAt: number | null;
  activeMinutes: number;
  graceExtensions: number;
  describeDefers: number;
  describedThisSession: boolean;
  lastPromptAt: number | null;
  /**
   * Active-time the describe / wrap checkpoints are measured *from* (ms, same
   * unit as `activeMinutes`). A checkpoint is due once
   * `activeMinutes - anchor >= threshold`, and answering re-arms the anchor to
   * the active total of that moment — so the interval counts from the response,
   * never from the session start. Without the anchor the cumulative total stays
   * above the threshold forever and every subsequent activity event re-arms the
   * pending prompt.
   */
  describeAnchor: number;
  wrapAnchor: number;
}

export function newMachine(): Machine {
  return {
    state: 'idle',
    lastActivityAt: null,
    startedAt: null,
    activeMinutes: 0,
    graceExtensions: 0,
    describeDefers: 0,
    describedThisSession: false,
    lastPromptAt: null,
    describeAnchor: 0,
    wrapAnchor: 0,
  };
}

/**
 * Re-arm the describe checkpoint at the current active total: the next describe
 * prompt is a full `describeAt` away from *now*, not from the last crossing.
 * Called on every describe outcome — described, background, deferred, skipped.
 */
export function rearmDescribe(m: Machine): void {
  m.describeAnchor = m.activeMinutes;
}

/**
 * Wrap counterpart of `rearmDescribe` — see its doc comment. It also re-arms the
 * describe anchor: `wrapAt` is always later than `describeAt`, so by the time the
 * wrap checkpoint is reached the describe one is behind us, and answering wrap
 * must not drop back into `active` with describe instantly due again.
 */
export function rearmWrap(m: Machine): void {
  m.wrapAnchor = m.activeMinutes;
  m.describeAnchor = m.activeMinutes;
}

/** Returns the new state after processing an activity event. */
export function onActivity(m: Machine, now: number, th: ThresholdsMs): SessionState {
  if (m.state === 'idle') {
    m.state = 'active';
    m.lastActivityAt = now;
    m.startedAt = now;
    return m.state;
  }
  // Accrue active minutes: only count the gap since last activity if < idleGap.
  if (m.lastActivityAt !== null) {
    const gap = now - m.lastActivityAt;
    if (gap < th.idleGap) {
      m.activeMinutes += gap;
    }
  }
  m.lastActivityAt = now;

  // Wrap is checked before describe: `wrapAt` is always later than `describeAt`,
  // so a due wrap interval subsumes the describe one. Without this ordering,
  // answering "skip" on the wrap prompt drops back into `active` with describe
  // instantly due again and the next event re-arms the describe checkpoint.
  if (
    (m.state === 'active' || m.state === 'describePending' || m.state === 'grace') &&
    m.activeMinutes - m.wrapAnchor >= th.wrapAt
  ) {
    m.state = 'wrapPending';
    return m.state;
  }

  if (m.state === 'active' && m.activeMinutes - m.describeAnchor >= th.describeAt) {
    m.state = 'describePending';
    return m.state;
  }

  if (m.state === 'wrapPending' && m.activeMinutes >= th.hardSplit) {
    m.state = 'wrapPending';
    return m.state; // coordinator handles auto-split
  }

  return m.state;
}

/** Called when a session is explicitly started. */
export function startSession(m: Machine, now: number): SessionState {
  m.state = 'active';
  m.startedAt = now;
  m.lastActivityAt = now;
  m.activeMinutes = 0;
  m.graceExtensions = 0;
  m.describeDefers = 0;
  m.describedThisSession = false;
  m.describeAnchor = 0;
  m.wrapAnchor = 0;
  return m.state;
}

/** Called when approaching an idle auto-close. */
export function autoClose(m: Machine, now: number): { activeMinutes: number; endedAt: number } {
  const endedAt = m.lastActivityAt ?? now;
  return { activeMinutes: m.activeMinutes, endedAt };
}

/** True when the session has been inactive for at least staleAfter ms (ADR-022). */
export function isStale(lastActivityAt: number | null, now: number, staleAfter: number): boolean {
  if (lastActivityAt === null) return false;
  return now - lastActivityAt >= staleAfter;
}
