import type { PersistentTasteMapData, TasteMapEntry } from './cinetrack-core.ts';
import { canonicalizeMediaKey } from './keys.ts';

export type LifecycleRing = 'ring0' | 'ring1' | 'ring2';
export type TasteRing = LifecycleRing | 'core' | 'inner' | 'outer' | 'orbit';

export function inferLifecycleRing(
  mediaKey: string,
  entry:
    | {
        shownCount?: number;
        skippedCount?: number;
        lastShownAt?: string | null;
      }
    | undefined
    | null,
  lastRecommendedKeys: string[] = []
): LifecycleRing {
  const canonicalTarget = canonicalizeMediaKey(mediaKey);
  if (
    canonicalTarget &&
    Array.isArray(lastRecommendedKeys) &&
    lastRecommendedKeys.some((k) => canonicalizeMediaKey(k) === canonicalTarget)
  ) {
    return 'ring1';
  }

  const hasBeenShown =
    (entry?.shownCount ?? 0) > 0 ||
    (entry?.skippedCount ?? 0) > 0 ||
    Boolean(entry?.lastShownAt);

  return hasBeenShown ? 'ring2' : 'ring0';
}

export function normalizeTasteRing(
  ring?: TasteRing | null,
  entry?: { shownCount?: number; skippedCount?: number; lastShownAt?: string | null } | null,
  inLastBatch?: boolean
): LifecycleRing {
  if (inLastBatch) return 'ring1';
  if (entry != null) {
    const hasBeenShown =
      (entry.shownCount ?? 0) > 0 ||
      (entry.skippedCount ?? 0) > 0 ||
      Boolean(entry.lastShownAt);
    return hasBeenShown ? 'ring2' : 'ring0';
  }
  if (ring === 'ring1') return 'ring1';
  if (ring === 'ring2') return 'ring2';
  return 'ring0';
}

export function normalizeTasteMapEntries(
  entries: Record<string, TasteMapEntry>,
  lastRecommendedKeys: string[] = []
): Record<string, TasteMapEntry> {
  if (!entries) return {};
  const normalized: Record<string, TasteMapEntry> = {};
  for (const [key, entry] of Object.entries(entries)) {
    if (!entry) continue;
    const mediaKey = entry.mediaKey || key;
    normalized[key] = {
      ...entry,
      ring: inferLifecycleRing(mediaKey, entry, lastRecommendedKeys),
      initialRing: 'ring0',
    };
  }
  return normalized;
}

export function normalizeTasteMapRings(tasteMap: PersistentTasteMapData): PersistentTasteMapData {
  if (!tasteMap) return tasteMap;
  const lastKeys = Array.isArray(tasteMap.lastRecommendedKeys) ? tasteMap.lastRecommendedKeys : [];
  return {
    ...tasteMap,
    entries: tasteMap.entries ? normalizeTasteMapEntries(tasteMap.entries, lastKeys) : {},
    archivedEntries: tasteMap.archivedEntries ? normalizeTasteMapEntries(tasteMap.archivedEntries, lastKeys) : {},
  };
}

export function assignTasteRing(
  _score?: number,
  context?: { inLastBatch?: boolean; shownCount?: number; skippedCount?: number; lastShownAt?: string | null }
): LifecycleRing {
  if (context?.inLastBatch) return 'ring1';
  if (
    (context?.skippedCount || 0) > 0 ||
    (context?.shownCount || 0) > 0 ||
    Boolean(context?.lastShownAt)
  ) {
    return 'ring2';
  }
  return 'ring0';
}

export function demoteTasteRing(currentRing: TasteRing, steps: number = 1): LifecycleRing {
  if (steps <= 0) {
    if (currentRing === 'ring1') return 'ring1';
    if (currentRing === 'ring2' || currentRing === 'outer' || currentRing === 'orbit') return 'ring2';
    return 'ring0';
  }
  if (currentRing === 'ring0' || currentRing === 'core') {
    return steps >= 2 ? 'ring2' : 'ring1';
  }
  return 'ring2';
}

export function getTasteRingLabel(ring?: TasteRing | null): string {
  switch (ring) {
    case 'ring0':
      return 'Halka 0 — Yeni Eşleşme';
    case 'ring1':
      return 'Halka 1 — Yakın Zamanda Gösterildi';
    case 'ring2':
      return 'Halka 2 — Daha Önce Atlandı';
    case 'core':
      return 'Çekirdek Halka (1. Halka)';
    case 'inner':
      return 'Yakın Halka (2. Halka)';
    case 'outer':
      return 'Dış Halka (3. Halka)';
    case 'orbit':
      return 'Yörünge (4. Halka)';
    default:
      return 'Halka 0 — Yeni Eşleşme';
  }
}
