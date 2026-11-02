// ===========================================================================
// CineTrack V1.5 (Feedback Intelligence) — useItemActions Hook
// Puanlama (rateItem -> ratedAt) ve durum tamamlama (status === 'completed' -> completedAt)
// işlemlerinde gerçek zamanlı ISO-8601 zaman damgalarını yönetir.
// Eski kayıtlarda bu alanlar yoksa undefined korunur (Faz 0 / TP-029).
// ===========================================================================

import { findSavedItem, normalizeSavedItem, type SavedItem } from '../core/cinetrack-core';

export type ItemWatchStatus = 'watching' | 'watchlist' | 'completed';

export interface ResolvedItemTimestamps {
  effectiveStatus: ItemWatchStatus;
  ratedAt?: string;
  completedAt?: string;
  addedAt: string;
  updatedAt: string;
  personalRatingCleared: boolean;
}

export interface ResolveTimestampOptions {
  /** rateItem doğrudan çağrıldığında mevcut puan aynı olsa bile ratedAt yenilenir */
  forceRatedAt?: boolean;
  /** Test edilebilirlik için opsiyonel ISO zaman damgası (varsayılan: new Date().toISOString()) */
  nowIso?: string;
}

/**
 * Puanlama ve durum geçişleri için V1.5 zaman damgalarını belirler.
 * - Yeni bir puan verildiğinde veya puan değiştiğinde `ratedAt` güncellenir.
 * - `status` 'completed' durumuna geçtiğinde `completedAt` güncellenir.
 * - Eski (imported) kayıtlarda ilgili alan değişmediyse `undefined` korunur.
 */
export function resolveItemActionTimestamps(
  existing: SavedItem | undefined,
  requestedStatus: ItemWatchStatus,
  personalRating: number | '',
  options: ResolveTimestampOptions = {}
): ResolvedItemTimestamps {
  const nowIso = options.nowIso ?? new Date().toISOString();
  const hasValidRating =
    typeof personalRating === 'number' &&
    Number.isFinite(personalRating) &&
    personalRating >= 1 &&
    personalRating <= 10;

  const effectiveStatus: ItemWatchStatus =
    hasValidRating && (requestedStatus === 'watchlist' || !requestedStatus)
      ? 'completed'
      : requestedStatus;

  const existingHasValidRating = Boolean(
    existing &&
      existing.personal_rating !== '' &&
      Number.isFinite(Number(existing.personal_rating)) &&
      Number(existing.personal_rating) >= 1 &&
      Number(existing.personal_rating) <= 10
  );

  const personalRatingCleared = Boolean(existingHasValidRating && !hasValidRating);

  let ratedAt: string | undefined;
  if (hasValidRating) {
    const ratingChanged =
      !existingHasValidRating || Number(existing?.personal_rating) !== personalRating;
    ratedAt = options.forceRatedAt || ratingChanged ? nowIso : existing?.ratedAt;
  } else {
    ratedAt = undefined;
  }

  let completedAt: string | undefined;
  if (effectiveStatus === 'completed') {
    const transitionedToCompleted = !existing || existing.status !== 'completed';
    completedAt = transitionedToCompleted ? nowIso : existing.completedAt;
  } else {
    completedAt = undefined;
  }

  return {
    effectiveStatus,
    ratedAt,
    completedAt,
    addedAt: existing?.addedAt || nowIso,
    updatedAt: nowIso,
    personalRatingCleared,
  };
}

export interface UseItemActionsHandlers {
  getSavedItems: () => SavedItem[];
  onCommitSavedItem: (
    normalized: SavedItem,
    rawItem: any,
    effectiveStatus: ItemWatchStatus
  ) => void;
}

export interface UseItemActionsResult {
  saveItem: (
    item: any,
    status: ItemWatchStatus,
    personalRating: number | '',
    tracking?: Record<string, any>
  ) => SavedItem | null;
  rateItem: (
    item: any,
    rating: number | '',
    tracking?: Record<string, any>
  ) => SavedItem | null;
  setItemStatus: (
    item: any,
    status: ItemWatchStatus,
    tracking?: Record<string, any>
  ) => SavedItem | null;
  markCompleted: (
    item: any,
    tracking?: Record<string, any>
  ) => SavedItem | null;
}

/**
 * İçerik kaydetme, puanlama (`rateItem`) ve durum değiştirme (`completed`) eylemlerini
 * V1.5 zaman damgalarıyla (`ratedAt`, `completedAt`) yürüten hook.
 */
export function useItemActions(handlers: UseItemActionsHandlers): UseItemActionsResult {
  const { getSavedItems, onCommitSavedItem } = handlers;

  const commitWithTimestamps = (
    item: any,
    status: ItemWatchStatus,
    personalRating: number | '',
    tracking: Record<string, any> = {},
    forceRatedAt: boolean = false
  ): SavedItem | null => {
    if (!item || item.id == null) return null;
    const mediaType = item.media_type || (item.title ? 'movie' : 'tv');
    const targetId = String(item.id);
    const existing = findSavedItem(getSavedItems(), {
      id: targetId,
      media_type: mediaType,
      title: item.title,
      name: item.name,
    });

    const nowIso = new Date().toISOString();
    const timestamps = resolveItemActionTimestamps(existing, status, personalRating, {
      forceRatedAt,
      nowIso,
    });

    const normalized = normalizeSavedItem({
      ...existing,
      ...item,
      media_type: mediaType,
      ...tracking,
      status: timestamps.effectiveStatus,
      personal_rating: personalRating || '',
      personal_rating_cleared: timestamps.personalRatingCleared,
      ratedAt: timestamps.ratedAt,
      completedAt: timestamps.completedAt,
      addedAt: timestamps.addedAt,
      updatedAt: timestamps.updatedAt,
      isDemo: false,
    });
    if (!normalized) return null;

    onCommitSavedItem(normalized, item, timestamps.effectiveStatus);
    return normalized;
  };

  const saveItem = (
    item: any,
    status: ItemWatchStatus,
    personalRating: number | '',
    tracking: Record<string, any> = {}
  ): SavedItem | null => {
    return commitWithTimestamps(item, status, personalRating, tracking, false);
  };

  const rateItem = (
    item: any,
    rating: number | '',
    tracking: Record<string, any> = {}
  ): SavedItem | null => {
    if (!item || item.id == null) return null;
    const mediaType = item.media_type || (item.title ? 'movie' : 'tv');
    const existing = findSavedItem(getSavedItems(), {
      id: String(item.id),
      media_type: mediaType,
      title: item.title,
      name: item.name,
    });
    const hasValidRating =
      typeof rating === 'number' && Number.isFinite(rating) && rating >= 1 && rating <= 10;
    const currentStatus: ItemWatchStatus = existing?.status ?? item.status ?? 'watchlist';
    const nextStatus: ItemWatchStatus =
      hasValidRating && currentStatus === 'watchlist' ? 'completed' : currentStatus;

    // rateItem çalıştığında ratedAt alanı new Date().toISOString() ile güncellenir
    const ratedNowIso = new Date().toISOString();
    const timestamps = resolveItemActionTimestamps(existing, nextStatus, rating, {
      forceRatedAt: hasValidRating,
      nowIso: ratedNowIso,
    });

    const normalized = normalizeSavedItem({
      ...existing,
      ...item,
      media_type: mediaType,
      ...tracking,
      status: timestamps.effectiveStatus,
      personal_rating: hasValidRating ? rating : '',
      personal_rating_cleared: timestamps.personalRatingCleared,
      ratedAt: hasValidRating ? ratedNowIso : undefined,
      completedAt:
        timestamps.effectiveStatus === 'completed'
          ? !existing || existing.status !== 'completed'
            ? ratedNowIso
            : existing.completedAt
          : undefined,
      addedAt: timestamps.addedAt,
      updatedAt: ratedNowIso,
      isDemo: false,
    });
    if (!normalized) return null;

    onCommitSavedItem(normalized, item, timestamps.effectiveStatus);
    return normalized;
  };

  const setItemStatus = (
    item: any,
    status: ItemWatchStatus,
    tracking: Record<string, any> = {}
  ): SavedItem | null => {
    if (!item || item.id == null) return null;
    const mediaType = item.media_type || (item.title ? 'movie' : 'tv');
    const existing = findSavedItem(getSavedItems(), {
      id: String(item.id),
      media_type: mediaType,
      title: item.title,
      name: item.name,
    });
    const preservedRating: number | '' =
      existing && existing.personal_rating !== '' && Number(existing.personal_rating) >= 1
        ? Number(existing.personal_rating)
        : '';

    // status 'completed' olarak değiştiğinde completedAt alanı new Date().toISOString() ile güncellenir
    return commitWithTimestamps(item, status, preservedRating, tracking, false);
  };

  const markCompleted = (
    item: any,
    tracking: Record<string, any> = {}
  ): SavedItem | null => {
    return setItemStatus(item, 'completed', tracking);
  };

  return {
    saveItem,
    rateItem,
    setItemStatus,
    markCompleted,
  };
}
