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
  untrackedNudges: number;
  lastPromptAt: number | null;
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
    untrackedNudges: 0,
    lastPromptAt: null,
  };
}

export interface PromptReply {
  type: 'described' | 'later' | 'wrap-new' | 'extend' | 'extend-described' | 'skip-note';
}

/** Returns the new state after processing an activity event. */
export function onActivity(m: Machine, now: number, th: ThresholdsMs): SessionState {
  if (m.state === 'idle') {
    m.state = 'untracked';
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

  if (m.state === 'untracked') {
    if (m.activeMinutes >= th.untrackedNudge && m.untrackedNudges === 0) {
      m.untrackedNudges = 1;
      return m.state; // coordinator nudges once
    }
    return m.state;
  }

  if (m.state === 'active' && m.activeMinutes >= th.describeAt) {
    m.state = 'describePending';
    return m.state;
  }

  if (
    (m.state === 'describePending' || m.state === 'grace') &&
    m.activeMinutes >= th.wrapAt
  ) {
    m.state = 'wrapPending';
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
  m.untrackedNudges = 0;
  return m.state;
}

/** Called when approaching an idle auto-close. */
export function autoClose(m: Machine, now: number): { activeMinutes: number; endedAt: number } {
  const endedAt = m.lastActivityAt ?? now;
  return { activeMinutes: m.activeMinutes, endedAt };
}

export function handleDescribeReply(
  m: Machine,
  reply: PromptReply,
  now: number,
  th: ThresholdsMs
): SessionState {
  if (reply.type === 'described') {
    m.describedThisSession = true;
    m.describeDefers = 0;
    m.state = m.activeMinutes >= th.wrapAt ? 'wrapPending' : 'active';
    // re-arm wrap if we're already past it
    if (m.activeMinutes >= th.wrapAt) m.state = 'wrapPending';
    else m.state = 'active';
  } else if (reply.type === 'later') {
    m.describeDefers += 1;
    m.state = 'describePending';
  }
  m.lastPromptAt = now;
  return m.state;
}

export function handleWrapReply(
  m: Machine,
  reply: PromptReply,
  now: number,
  th: ThresholdsMs
): SessionState {
  if (reply.type === 'wrap-new') {
    m.state = 'idle'; // closed by caller, then startSession
  } else if (reply.type === 'extend') {
    m.graceExtensions += 1;
    m.state = 'grace';
    m.lastActivityAt = now;
    m.activeMinutes = 0; // grace: reset active accumulator for the extension window
  } else if (reply.type === 'extend-described') {
    m.graceExtensions += 1;
    m.describedThisSession = true;
    m.state = 'grace';
    m.lastActivityAt = now;
    m.activeMinutes = 0;
  }
  m.lastPromptAt = now;
  return m.state;
}
