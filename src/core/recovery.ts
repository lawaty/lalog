import { ThresholdsMs } from '../core/config';
import { Session } from '../core/types';
import { Machine, onActivity, autoClose } from './stateMachine';

/**
 * Recomputes an in-memory Machine from a persisted Session + event gaps.
 * Prevents "zombie" active sessions: only a real activity event resets the
 * idle clock, never a periodic reopen or timer.
 */
export function recoverMachine(s: Session | null, now: number, th: ThresholdsMs): Machine {
  if (!s) return freshIdle();
  const m: Machine = {
    state: 'active',
    lastActivityAt: s.lastActivityAt,
    startedAt: s.startedAt,
    activeMinutes: s.activeMinutes,
    graceExtensions: 0,
    describeDefers: 0,
    describedThisSession: !!s.description,
    untrackedNudges: 1,
    lastPromptAt: null,
  };
  // If the persisted session went idle beyond autoEnd, it should be closed
  // by the caller (recovery manager), not kept alive here.
  return m;
}

function freshIdle(): Machine {
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

/** Feed a batch of stored event gaps to accrue active minutes after sleep/reopen. */
export function accrueGaps(m: Machine, gaps: number[], th: ThresholdsMs): void {
  for (const gap of gaps) {
    if (gap < th.idleGap) m.activeMinutes += gap;
  }
}

export { onActivity, autoClose };
