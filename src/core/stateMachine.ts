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
  };
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
  return m.state;
}

/** Called when approaching an idle auto-close. */
export function autoClose(m: Machine, now: number): { activeMinutes: number; endedAt: number } {
  const endedAt = m.lastActivityAt ?? now;
  return { activeMinutes: m.activeMinutes, endedAt };
}
