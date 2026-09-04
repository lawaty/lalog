import { Session } from '../core/types';

/** Sum active time (ms) of sessions started within today's local calendar day. */
export function todayActiveMs(sessions: Session[], now = Date.now()): number {
  const d = new Date(now);
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  return sessions
    .filter((s) => s.startedAt >= start && s.endedAt)
    .reduce((sum, s) => sum + s.activeMinutes, 0);
}

/** Sum "untracked" active time today (sessions lacking a description). */
export function todayUntrackedMs(sessions: Session[], now = Date.now()): number {
  const d = new Date(now);
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  return sessions
    .filter((s) => s.startedAt >= start && s.endedAt && (s.needsDescription || !s.description))
    .reduce((sum, s) => sum + s.activeMinutes, 0);
}
