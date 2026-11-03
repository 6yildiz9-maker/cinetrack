import type { TmdbItem } from '../types/tmdb.ts';

export interface StockCandidateExclusionSets {
  listedKeys: ReadonlySet<string>;
  dislikedKeys: ReadonlySet<string>;
  hiddenKeys: ReadonlySet<string>;
  existingStockKeys?: ReadonlySet<string>;
}

export function normalizeRawStockId(raw: number | string | null | undefined): string {
  if (raw == null) return '';
  return String(raw).trim().replace(/^(movie|tv)[:-]/, '');
}

export function resolveItemMediaType(item: {
  media_type?: string;
  name?: string;
  title?: string;
  id?: number | string;
}): 'movie' | 'tv' {
  if (item.media_type === 'tv') return 'tv';
  if (item.media_type === 'movie') return 'movie';
  const rawStr = item.id != null ? String(item.id).trim() : '';
  if (/^tv[:-]/.test(rawStr)) return 'tv';
  if (/^movie[:-]/.test(rawStr)) return 'movie';
  return Boolean(item.name) && !item.title ? 'tv' : 'movie';
}

export function extractTopThreeCastIds(item: TmdbItem): number[] | undefined {
  if (Array.isArray(item.topCastIds) && item.topCastIds.length > 0) {
    const clean = item.topCastIds
      .map((id) => Number(id))
      .filter((id) => Number.isInteger(id) && id > 0)
      .slice(0, 3);
    if (clean.length > 0) return clean;
  }
  const rawCast = Array.isArray(item.credits?.cast)
    ? item.credits.cast
    : Array.isArray(item.cast)
      ? item.cast
      : [];
  if (rawCast.length === 0) return undefined;
  const sorted = [...rawCast]
    .filter((c) => c && Number.isInteger(Number(c.id)) && Number(c.id) > 0)
    .sort((a, b) => (a.order ?? 999) - (b.order ?? 999));
  const ids = sorted.slice(0, 3).map((c) => Number(c.id));
  return ids.length > 0 ? ids : undefined;
}

function addPreferenceKeyVariants(targetSet: Set<string>, rawEntry: string): void {
  const trimmed = String(rawEntry).trim();
  if (!trimmed) return;
  const rawId = normalizeRawStockId(trimmed);
  if (!rawId) return;
  targetSet.add(trimmed);
  if (/^movie[:-]/.test(trimmed)) {
    targetSet.add(`movie:${rawId}`);
    targetSet.add(`movie-${rawId}`);
  } else if (/^tv[:-]/.test(trimmed)) {
    targetSet.add(`tv:${rawId}`);
    targetSet.add(`tv-${rawId}`);
  } else {
    targetSet.add(rawId);
    targetSet.add(`movie:${rawId}`);
    targetSet.add(`tv:${rawId}`);
  }
}

export function buildStockExclusionSets(
  userItems: ReadonlyArray<{
    id?: number | string;
    media_type?: string;
    name?: string;
    title?: string;
  }> = [],
  preferences?: { disliked?: ReadonlyArray<string>; hidden?: ReadonlyArray<string> } | null,
  existingStockKeys?: ReadonlySet<string>
): StockCandidateExclusionSets {
  const listedKeys = new Set<string>();
  for (const it of userItems) {
    if (!it || it.id == null) continue;
    const rawStr = String(it.id).trim();
    const rawId = normalizeRawStockId(rawStr);
    if (!rawId) continue;
    const hasExplicitType =
      it.media_type === 'movie' ||
      it.media_type === 'tv' ||
      /^(movie|tv)[:-]/.test(rawStr) ||
      Boolean(it.title) !== Boolean(it.name);
    const mType = resolveItemMediaType(it);
    listedKeys.add(`${mType}:${rawId}`);
    listedKeys.add(`${mType}-${rawId}`);
    listedKeys.add(rawStr);
    if (!hasExplicitType) {
      listedKeys.add(rawId);
    }
  }

  const dislikedKeys = new Set<string>();
  for (const d of preferences?.disliked || []) {
    if (d) addPreferenceKeyVariants(dislikedKeys, d);
  }

  const hiddenKeys = new Set<string>();
  for (const h of preferences?.hidden || []) {
    if (h) addPreferenceKeyVariants(hiddenKeys, h);
  }

  return {
    listedKeys,
    dislikedKeys,
    hiddenKeys,
    existingStockKeys,
  };
}

function matchesSetKey(
  keySet: ReadonlySet<string> | undefined,
  contentId: string,
  legacyContentId: string,
  rawId: string
): boolean {
  if (!keySet || keySet.size === 0) return false;
  return keySet.has(contentId) || keySet.has(legacyContentId) || keySet.has(rawId);
}

/**
 * Bir aday içeriğin ct:stock havuzuna girip giremeyeceğini kontrol eder (Sorun 1 & TP-018):
 * 1. Kullanıcının listelerinde (watching, watchlist, completed) varsa -> false
 * 2. İlgilenmiyorum (preferences.disliked — negatif sinyal, TP-018) listesindeyse -> false
 * 3. Gizlenenler (preferences.hidden — nötr dışlama, TP-018) listesindeyse -> false
 * 4. Zaten stoktaysa (çift kayıt önleme) -> false
 */
export function isCandidateEligibleForStock(
  candidate:
    | { id?: number | string; media_type?: string; name?: string; title?: string }
    | null
    | undefined,
  userItems: ReadonlyArray<{
    id?: number | string;
    media_type?: string;
    name?: string;
    title?: string;
  }> = [],
  preferences?: { disliked?: ReadonlyArray<string>; hidden?: ReadonlyArray<string> } | null,
  existingStockKeys?: ReadonlySet<string>,
  precomputedSets?: StockCandidateExclusionSets
): boolean {
  if (!candidate || candidate.id == null) return false;
  const mediaType = resolveItemMediaType(candidate);
  const rawId = normalizeRawStockId(candidate.id);
  if (!rawId) return false;
  const contentId = `${mediaType}:${rawId}`;
  const legacyContentId = `${mediaType}-${rawId}`;

  const sets = precomputedSets || buildStockExclusionSets(userItems, preferences, existingStockKeys);
  if (matchesSetKey(sets.listedKeys, contentId, legacyContentId, rawId)) return false;
  if (matchesSetKey(sets.dislikedKeys, contentId, legacyContentId, rawId)) return false;
  if (matchesSetKey(sets.hiddenKeys, contentId, legacyContentId, rawId)) return false;
  if (matchesSetKey(sets.existingStockKeys, contentId, legacyContentId, rawId)) return false;
  if (matchesSetKey(existingStockKeys, contentId, legacyContentId, rawId)) return false;

  return true;
}

/**
 * Stok dizisini hem kullanıcı listeleri/disliked/hidden/skip-log kayıtlarından arındırır
 * hem de kendi içinde çift (duplicate) ID oluşmasını kesin olarak engeller.
 */
export function dedupeAndPurgeStockList(
  items: ReadonlyArray<TmdbItem>,
  mediaType: 'movie' | 'tv',
  userItems: ReadonlyArray<{
    id?: number | string;
    media_type?: string;
    name?: string;
    title?: string;
  }> = [],
  preferences?: { disliked?: ReadonlyArray<string>; hidden?: ReadonlyArray<string> } | null,
  precomputedSets?: StockCandidateExclusionSets,
  activeSkipKeys?: ReadonlySet<string>
): TmdbItem[] {
  const sets = precomputedSets || buildStockExclusionSets(userItems, preferences);
  const seenInStock = new Set<string>();
  const clean: TmdbItem[] = [];

  for (const item of items) {
    if (!item || item.id == null) continue;
    const rawId = normalizeRawStockId(item.id);
    if (!rawId) continue;
    const typedKey = `${mediaType}:${rawId}`;
    if (seenInStock.has(typedKey)) continue;
    if (activeSkipKeys?.has(typedKey)) continue;

    const typedCandidate: TmdbItem = { ...item, media_type: mediaType };
    if (!isCandidateEligibleForStock(typedCandidate, userItems, preferences, seenInStock, sets)) {
      continue;
    }

    seenInStock.add(typedKey);
    clean.push(typedCandidate);
  }

  return clean;
}
