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