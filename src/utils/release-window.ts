/**
 * Dynamic Release Window Filter (FEAT-01 #2 & FEAT-02 Stock/Discover)
 *
 * Computes the allowed release window dynamically via `new Date().getFullYear()`
 * with zero hardcoded calendar years.
 * - Unreleased / future items are eligible ONLY within `[currentYear, currentYear + 1]`.
 * - Future items with `year > currentYear + 1` and dateless items (`""`) are excluded.
 * - Already-released past items (`year <= currentYear`) with a valid date remain eligible
 *   for franchise universes and catalog stock.
 */

export interface ReleaseWindowBounds {
  currentYear: number;
  maxYear: number;
  todayIso: string;
}

function padTwoDigits(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

export function getDynamicReleaseWindowBounds(now: Date = new Date()): ReleaseWindowBounds {
  const currentYear = now.getFullYear();
  const month = padTwoDigits(now.getMonth() + 1);
  const day = padTwoDigits(now.getDate());
  return {
    currentYear,
    maxYear: currentYear + 1,
    todayIso: `${currentYear}-${month}-${day}`,
  };
}

export function parseMediaReleaseYear(date?: string | null): number | null {
  if (typeof date !== 'string') return null;
  const trimmed = date.trim();
  if (!trimmed) return null;
  const match = /^(\d{4})(?:-(\d{2})-(\d{2}))?/.exec(trimmed);
  if (!match) return null;
  const year = Number(match[1]);
  if (!Number.isInteger(year) || year <= 0) return null;
  return year;
}

/**
 * Reusable dynamic release window predicate required by FEAT-01:
 * - Drops empty / unparseable dates (`""` -> `false`).
 * - Drops future items beyond `[currentYear, currentYear + 1]` (`year > currentYear + 1` -> `false`).
 * - Admits valid released items (`year <= currentYear`) and near-future items in `[currentYear, currentYear + 1]`.
 */
export function isWithinReleaseWindow(
  date: string | undefined | null,
  now: Date = new Date()
): boolean {
  const year = parseMediaReleaseYear(date);
  if (year === null) return false;
  const { maxYear } = getDynamicReleaseWindowBounds(now);
  return year <= maxYear;
}

/**
 * Strictly checks whether a date belongs to an upcoming / current-window release
 * inside `[currentYear, currentYear + 1]`.
 */
export function isFutureWithinReleaseWindow(
  date: string | undefined | null,
  now: Date = new Date()
): boolean {
  const year = parseMediaReleaseYear(date);
  if (year === null) return false;
  const { currentYear, maxYear } = getDynamicReleaseWindowBounds(now);
  return year >= currentYear && year <= maxYear;
}

/**
 * Chronological ascending comparator without magic sentinel year strings.
 * Valid dates sort chronologically ascending; missing dates sort last.
 */
export function compareMediaDatesAscending(
  dateA?: string | null,
  dateB?: string | null
): number {
  const cleanA = typeof dateA === 'string' ? dateA.trim() : '';
  const cleanB = typeof dateB === 'string' ? dateB.trim() : '';
  if (!cleanA && !cleanB) return 0;
  if (!cleanA) return 1;
  if (!cleanB) return -1;
  return cleanA.localeCompare(cleanB);
}
