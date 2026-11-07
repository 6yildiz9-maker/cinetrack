import type { SavedItem } from '../../core/cinetrack-core.ts';
import type { ColumnChartPoint } from './ColumnChart.tsx';

const RATING_BUCKETS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const DECADE_MIN_SPAN = 3;

function releaseYear(item: SavedItem): number | null {
  const raw = item.release_date || item.first_air_date || '';
  const year = Number.parseInt(String(raw).slice(0, 4), 10);
  return Number.isFinite(year) ? year : null;
}

/** Kişisel puanların 1-10 histogramı; yalnızca puan verilmiş yapımlar sayılır. */
export function buildRatingHistogramColumns(items: SavedItem[]): ColumnChartPoint[] {
  const counts = new Map<number, number>(RATING_BUCKETS.map((bucket) => [bucket, 0]));
  for (const item of items) {
    const raw = Number(item.personal_rating);
    if (item.personal_rating === '' || !Number.isFinite(raw) || raw < 1) continue;
    const bucket = Math.min(10, Math.max(1, Math.round(raw)));
    counts.set(bucket, (counts.get(bucket) || 0) + 1);
  }
  const total = Array.from(counts.values()).reduce((sum, value) => sum + value, 0);
  return RATING_BUCKETS.map((bucket) => {
    const value = counts.get(bucket) || 0;
    const share = total > 0 ? Math.round((value / total) * 100) : 0;
    return {
      label: String(bucket),
      value,
      hint: `${bucket} puan: ${value} yapım (%${share})`,
    };
  });
}

/** Kütüphanenin yayın onyıllarına göre dağılımı (1970, 1980, ...). */
export function buildReleaseDecadeColumns(items: SavedItem[]): ColumnChartPoint[] {
  const counts = new Map<number, number>();
  for (const item of items) {
    const year = releaseYear(item);
    if (year === null) continue;
    const decade = Math.floor(year / 10) * 10;
    counts.set(decade, (counts.get(decade) || 0) + 1);
  }
  const decades = Array.from(counts.keys()).sort((a, b) => a - b);
  if (decades.length === 0) return [];

  const min = decades[0];
  const max = decades[decades.length - 1];
  const filled: number[] = [];
  for (let decade = min; decade <= max; decade += 10) {
    filled.push(decade);
  }
  if (filled.length < DECADE_MIN_SPAN) return [];

  const total = Array.from(counts.values()).reduce((sum, value) => sum + value, 0);
  return filled.map((decade) => {
    const value = counts.get(decade) || 0;
    const share = total > 0 ? Math.round((value / total) * 100) : 0;
    return {
      label: String(decade),
      value,
      hint: `${decade}-${decade + 9}: ${value} yapım (%${share})`,
    };
  });
}
