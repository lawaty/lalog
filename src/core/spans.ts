import { ActiveSpan } from './types';

export interface SpanUpdate {
  openSpanStart: number | null;
  closed: ActiveSpan | null;
}

/**
 * Pure span-builder: given the previous activity time and the current one,
 * update the open active span (contiguous gap fewer than idleGapMs) or close it.
 * Spans carry NO source tag — in-vs-outside classification happens at filter time.
 */
export function updateActiveSpan(
  prev: number | null,
  now: number,
  idleGapMs: number,
  openSpanStart: number | null
): SpanUpdate {
  if (prev === null) {
    return { openSpanStart: now, closed: null };
  }
  if (now - prev < idleGapMs) {
    return { openSpanStart: openSpanStart ?? prev, closed: null };
  }
  const closed =
    openSpanStart !== null && prev > openSpanStart
      ? { start: openSpanStart, end: prev }
      : null;
  return { openSpanStart: now, closed };
}

/**
 * Pure trim: given accrued session state and a cut-off moment `until`, cap
 * closed spans at `until`, close the open span at min(lastActivityAt, until),
 * recompute activeMinutes from the trimmed totals, and filter activityTs.
 * Used when an idle-prompt 'end' response should retroactively cut the
 * session at the moment the question was asked.
 */
export function trimToCutoff(
  closedSpans: ActiveSpan[],
  openSpanStart: number | null,
  lastActivityAt: number,
  activeMinutes: number,
  activityTs: number[],
  until: number,
): {
  closedSpans: ActiveSpan[];
  openSpanStart: number | null;
  activeMinutes: number;
  activityTs: number[];
} {
  // 1. Trim closed spans: cap end at `until`, drop fully-after spans.
  const trimmed: ActiveSpan[] = [];
  for (const span of closedSpans) {
    if (span.start >= until) continue;          // fully after → drop
    trimmed.push(
      span.end > until ? { start: span.start, end: until } : span,
    );
  }

  // 2. Close the open span at min(lastActivityAt, until) if it started before `until`.
  if (openSpanStart !== null && openSpanStart < until) {
    const end = Math.min(lastActivityAt, until);
    if (end > openSpanStart) {
      trimmed.push({ start: openSpanStart, end });
    }
  }

  // 3. Recompute activeMinutes from the trimmed span totals.
  let total = 0;
  for (const span of trimmed) total += span.end - span.start;

  // 4. Filter activity timestamps.
  const trimmedTs = activityTs.filter((t) => t <= until);

  return {
    closedSpans: trimmed,
    openSpanStart: null,
    activeMinutes: total,
    activityTs: trimmedTs,
  };
}
