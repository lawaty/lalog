export type ReportRange = 'today' | 'yesterday' | 'week' | 'month' | 'last-month' | 'custom';

export function rangeStart(r: ReportRange, now: number): number {
  const d = new Date(now);
  const startOfDay = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  switch (r) {
    case 'today':
      return startOfDay;
    case 'yesterday':
      return calendarDaysAfter(startOfDay, -1);
    case 'week': {
      const day = d.getDay() || 7; // Monday = 1
      return calendarDaysAfter(startOfDay, -(day - 1));
    }
    case 'month':
      return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
    case 'last-month':
      return new Date(d.getFullYear(), d.getMonth() - 1, 1).getTime();
    case 'custom':
      return 0;
  }
}

export function rangeEnd(r: ReportRange, now: number): number {
  const d = new Date(now);
  const startOfDay = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  switch (r) {
    case 'today':
      return calendarDaysAfter(startOfDay, 1);
    case 'yesterday':
      return startOfDay;
    case 'week': {
      const day = d.getDay() || 7;
      return calendarDaysAfter(startOfDay, -(day - 1) + 7);
    }
    case 'month':
      return new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime();
    case 'last-month':
      return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
    case 'custom':
      return Number.MAX_SAFE_INTEGER; // bounds provided explicitly by the caller
  }
}

/** Start of the calendar day n days after `ms` (DST-safe: date arithmetic, not 24h ms). */
function calendarDaysAfter(ms: number, n: number): number {
  const day = new Date(ms);
  day.setDate(day.getDate() + n);
  return new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
}

export function rangeLabel(r: ReportRange): string {
  switch (r) {
    case 'today':
      return 'Today';
    case 'yesterday':
      return 'Yesterday';
    case 'week':
      return 'This Week';
    case 'month':
      return 'This Month';
    case 'last-month':
      return 'Last Month';
    case 'custom':
      return 'Custom';
  }
}