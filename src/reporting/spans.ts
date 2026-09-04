import { Session } from '../core/types';

export interface ActiveBreakdown {
  totalMs: number;
  vscodeMs: number;
  outsideMs: number;
}

/**
 * Filter-time classification of active spans into in-VS-Code vs outside-VS-Code
 * work. Spans are stored WITHOUT a source tag:
 *  - a span built from real VS Code events always ends at an activity timestamp
 *  - a span built from a 'still working' confirmation ends at a confirm time,
 *    which is NOT in activityTs (no VS Code activity happened during it)
 * Legacy sessions without spans are reconstructed from the activity timestamp
 * stream using the same gap rule the tracker used.
 */
export function splitActiveMinutes(s: Session, idleGapMs = 15 * 60 * 1000): ActiveBreakdown {
  const spans = s.activeSpans ?? [];
  const ts = s.activityTs ?? [];
  let vscodeMs = 0;
  let outsideMs = 0;

  if (spans.length) {
    const tsSet = new Set<number>(ts);
    for (const sp of spans) {
      const ms = Math.max(0, sp.end - sp.start);
      if (tsSet.has(sp.end) && ms > 0) vscodeMs += ms;
      else outsideMs += ms;
    }
  } else {
    // Legacy session without spans: rebuild vscode time from consecutive
    // activity gaps, the same way the tracker accrued it.
    const sortedTs = [...ts].sort((a, b) => a - b);
    for (let i = 1; i < sortedTs.length; i++) {
      const gap = sortedTs[i] - sortedTs[i - 1];
      if (gap >= 0 && gap < idleGapMs) vscodeMs += gap;
    }
    outsideMs = Math.max(0, s.activeMinutes - vscodeMs);
  }

  const totalMs = Math.max(vscodeMs + outsideMs, s.activeMinutes);
  return { totalMs, vscodeMs, outsideMs };
}