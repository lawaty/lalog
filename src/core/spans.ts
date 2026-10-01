import { ActiveSpan } from './types';

export interface SpanUpdate {
  openSpanStart: number | null;
  closed: ActiveSpan | null;
}

export interface TrackedAdjust {
  spans: ActiveSpan[];
  activeMinutes: number;
  activityTs: number[];
  /** End of the last surviving span, or null when nothing is left. */
  tailEnd: number | null;
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

/** End of the last span, or null when the list is empty. */
export function tailEndOf(spans: ActiveSpan[]): number | null {
  return spans.length ? spans[spans.length - 1].end : null;
}

/**
 * Pure reduction: cut a session's tracked total down to `targetMs`. The delta is
 * removed from the tail, except that `preferredSuffix` — the window a wrong
 * 'still working' confirm closed as outside work — goes first, so rolling that
 * decision back drops the away window and spares the real work after it. A span
 * is never split at its start: time only ever leaves a span from its end.
 * `activeMinutes` is the honest sum of the surviving spans.
 */
export function truncateToTotal(
  spans: ActiveSpan[],
  activeMinutes: number,
  activityTs: number[],
  targetMs: number,
  preferredSuffix?: ActiveSpan
): TrackedAdjust {
  if (targetMs < 0 || targetMs > activeMinutes) {
    throw new RangeError(`targetMs ${targetMs} is outside 0..${activeMinutes}`);
  }
  const work = spans.map((s) => ({ start: s.start, end: s.end }));
  let toRemove = activeMinutes - targetMs;

  // 1. The confirmed-outside window goes first, before any tail truncation.
  if (toRemove > 0 && preferredSuffix) {
    const idx = work.findIndex(
      (s) => s.start === preferredSuffix.start && s.end === preferredSuffix.end
    );
    if (idx >= 0) {
      const take = Math.min(work[idx].end - work[idx].start, toRemove);
      work[idx].end -= take;
      toRemove -= take;
      if (work[idx].end <= work[idx].start) work.splice(idx, 1);
    }
  }

  // 2. Whatever is still owed comes off the tail, oldest-last span first.
  for (let i = work.length - 1; i >= 0 && toRemove > 0; i--) {
    const take = Math.min(work[i].end - work[i].start, toRemove);
    work[i].end -= take;
    toRemove -= take;
    if (work[i].end <= work[i].start) work.splice(i, 1);
  }

  const kept = work.filter((s) => s.end > s.start);
  let total = 0;
  for (const span of kept) total += span.end - span.start;
  const tailEnd = tailEndOf(kept);

  return {
    spans: kept,
    activeMinutes: total,
    activityTs: tailEnd === null ? [] : activityTs.filter((t) => t <= tailEnd),
    tailEnd,
  };
}
