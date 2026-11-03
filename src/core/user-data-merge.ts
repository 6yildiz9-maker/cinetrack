import {
  CURRENT_SCHEMA_VERSION,
  ENGINE_VERSION,
  canonicalizeMediaKeyList,
  dedupeItems,
  makeMediaKey,
  normalizeDeletedKeys,
  normalizeFavoriteActors,
  normalizePreferences,
  type DataDocument,
  type FavoriteActorInfo,
  type Preferences,
  type Profile,
  type SavedItem,
} from './cinetrack-core.ts';
import type { UserDataConflictItem } from './sync-display.ts';

function sortKeysDeepPure(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeepPure);
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      const v = record[key];
      if (v !== undefined) {
        sorted[key] = sortKeysDeepPure(v);
      }
    }
    return sorted;
  }
  return value;
}

export function stringifyUserDataDeterministic(value: unknown): string {
  return JSON.stringify(sortKeysDeepPure(value));
}

function statusProgressionRank(status?: string): number {
  if (status === 'completed') return 3;
  if (status === 'watching') return 2;
  return 1;
}

function pickEarliestIso(candidates: Array<string | undefined>): string | undefined {
  const valid = candidates.filter((v): v is string => typeof v === 'string' && v.length > 0);
  if (valid.length === 0) return undefined;
  return [...valid].sort()[0];
}

function pickLatestIso(candidates: Array<string | undefined>): string | undefined {
  const valid = candidates.filter((v): v is string => typeof v === 'string' && v.length > 0);
  if (valid.length === 0) return undefined;
  return [...valid].sort().slice(-1)[0];
}

export function getSavedItemEffectiveTimestampMs(item: SavedItem): number {
  const candidates = [
    item.updatedAt,
    item.ratedAt,
    item.completedAt,
    item.addedAt,
    item.firstAddedAt,
  ].filter((v): v is string => typeof v === 'string' && v.length > 0);
  if (candidates.length === 0) return NaN;
  let maxMs = NaN;
  for (const iso of candidates) {
    const ms = Date.parse(iso);
    if (Number.isFinite(ms) && (!Number.isFinite(maxMs) || ms > maxMs)) {
      maxMs = ms;
    }
  }
  return maxMs;
}

export function mergeTwoSavedItemsLossless(
  profileId: string,
  localItem: SavedItem,
  remoteItem: SavedItem
): {
  merged: SavedItem;
  conflict?: UserDataConflictItem;
  changedLocal: boolean;
  changedRemote: boolean;
} {
  const key = makeMediaKey(localItem);
  const localTime =
    localItem.updatedAt ||
    localItem.ratedAt ||
    localItem.completedAt ||
    localItem.addedAt ||
    '';
  const remoteTime =
    remoteItem.updatedAt ||
    remoteItem.ratedAt ||
    remoteItem.completedAt ||
    remoteItem.addedAt ||
    '';

  const statusDiffers = localItem.status !== remoteItem.status;
  const localRatingStr =
    localItem.personal_rating !== '' && localItem.personal_rating != null
      ? String(localItem.personal_rating)
      : '';
  const remoteRatingStr =
    remoteItem.personal_rating !== '' && remoteItem.personal_rating != null
      ? String(remoteItem.personal_rating)
      : '';
  const bothHaveDifferentRatings =
    Boolean(localRatingStr) && Boolean(remoteRatingStr) && localRatingStr !== remoteRatingStr;

  let chosenStatus: SavedItem['status'] = localItem.status;
  let resolutionNote = '';

  if (statusDiffers) {
    if (remoteTime && localTime && remoteTime !== localTime) {
      if (remoteTime > localTime) {
        chosenStatus = remoteItem.status;
        resolutionNote = `Daha güncel zaman damgalı uzak durum (${remoteItem.status}) seçildi`;
      } else {
        chosenStatus = localItem.status;
        resolutionNote = `Daha güncel zaman damgalı yerel durum (${localItem.status}) korundu`;
      }
    } else {
      chosenStatus =
        statusProgressionRank(remoteItem.status) > statusProgressionRank(localItem.status)
          ? remoteItem.status
          : localItem.status;
      resolutionNote = `İzleme ilerlemesi daha ileri olan durum (${chosenStatus}) seçildi`;
    }
  }

  let chosenRating: number | '' = localItem.personal_rating;
  let chosenRatingCleared = Boolean(localItem.personal_rating_cleared);

  if (localRatingStr !== remoteRatingStr) {
    if (localRatingStr && !remoteRatingStr) {
      if (remoteItem.personal_rating_cleared && remoteTime > localTime) {
        chosenRating = '';
        chosenRatingCleared = true;
      } else {
        chosenRating = localItem.personal_rating;
        chosenRatingCleared = false;
      }
    } else if (remoteRatingStr && !localRatingStr) {
      if (localItem.personal_rating_cleared && localTime > remoteTime) {
        chosenRating = '';
        chosenRatingCleared = true;
      } else {
        chosenRating = remoteItem.personal_rating;
        chosenRatingCleared = false;
      }
    } else if (bothHaveDifferentRatings) {
      if (remoteTime > localTime) {
        chosenRating = remoteItem.personal_rating;
      } else {
        chosenRating = localItem.personal_rating;
      }
      chosenRatingCleared = false;
      resolutionNote = resolutionNote
        ? `${resolutionNote}; puan olarak güncel kayıt (${chosenRating}) seçildi`
        : `Farklı kişisel puanlar arasından güncel olan (${chosenRating}) seçildi`;
    }
  }

  // Sezon ilerlemelerini kayıpsız birleştir (her sezon için daha yüksek izlenen bölüm sayısını koru)
  const mergedSeasonProgress: Record<number, number> = { ...(localItem.season_progress || {}) };
  for (const [seasonKey, epCount] of Object.entries(remoteItem.season_progress || {})) {
    const sNum = Number(seasonKey);
    const prev = mergedSeasonProgress[sNum] || 0;
    mergedSeasonProgress[sNum] = Math.max(prev, Number(epCount) || 0);
  }
  const mergedSeasonTotals: Record<number, number> = {
    ...(localItem.season_episode_counts || {}),
    ...(remoteItem.season_episode_counts || {}),
  };

  const genreSet = new Set<number>([
    ...(localItem.genre_ids || []),
    ...(remoteItem.genre_ids || []),
  ]);
  const richerOverview =
    (remoteItem.overview || '').trim().length > (localItem.overview || '').trim().length
      ? remoteItem.overview
      : localItem.overview || remoteItem.overview;

  const earliestAdded = pickEarliestIso([localItem.addedAt, remoteItem.addedAt]);
  const earliestFirstAdded = pickEarliestIso([
    localItem.firstAddedAt,
    remoteItem.firstAddedAt,
    localItem.addedAt,
    remoteItem.addedAt,
  ]);
  const latestUpdated = pickLatestIso([localTime, remoteTime]);

  const resolvedRatedAt =
    chosenRating !== '' && chosenRating != null
      ? pickLatestIso([localItem.ratedAt, remoteItem.ratedAt])
      : undefined;
  const resolvedCompletedAt =
    chosenStatus === 'completed'
      ? pickEarliestIso([localItem.completedAt, remoteItem.completedAt])
      : undefined;

  const hasWatchMinutes =
    typeof localItem.totalWatchTimeMinutes === 'number' ||
    typeof remoteItem.totalWatchTimeMinutes === 'number';
  const mergedWatchMinutes = hasWatchMinutes
    ? Math.max(localItem.totalWatchTimeMinutes || 0, remoteItem.totalWatchTimeMinutes || 0)
    : undefined;

  const baseWinner = remoteTime > localTime ? remoteItem : localItem;
  const fallbackOther = baseWinner === remoteItem ? localItem : remoteItem;

  const merged: SavedItem = {
    ...fallbackOther,
    ...baseWinner,
    id: localItem.id,
    media_type: localItem.media_type,
    title: baseWinner.title || fallbackOther.title,
    overview: richerOverview,
    poster_path: baseWinner.poster_path || fallbackOther.poster_path,
    poster_url: baseWinner.poster_url || fallbackOther.poster_url,
    backdrop_path: baseWinner.backdrop_path || fallbackOther.backdrop_path,
    genre_ids: Array.from(genreSet).sort((a, b) => a - b),
    status: chosenStatus,
    personal_rating: chosenRating,
    personal_rating_cleared: chosenRatingCleared,
    ...(Object.keys(mergedSeasonProgress).length > 0
      ? { season_progress: mergedSeasonProgress }
      : {}),
    ...(Object.keys(mergedSeasonTotals).length > 0
      ? { season_episode_counts: mergedSeasonTotals }
      : {}),
    ...(earliestFirstAdded ? { firstAddedAt: earliestFirstAdded } : {}),
    ...(mergedWatchMinutes !== undefined ? { totalWatchTimeMinutes: mergedWatchMinutes } : {}),
    ratedAt: resolvedRatedAt,
    completedAt: resolvedCompletedAt,
    addedAt: earliestAdded || localItem.addedAt || remoteItem.addedAt,
    updatedAt: latestUpdated || localItem.updatedAt || remoteItem.updatedAt,
    isDemo: Boolean(localItem.isDemo && remoteItem.isDemo),
  };

  if (!resolvedRatedAt) {
    delete merged.ratedAt;
  }
  if (!resolvedCompletedAt) {
    delete merged.completedAt;
  }

  const itemSem = (it: SavedItem) =>
    stringifyUserDataDeterministic({
      status: it.status,
      rating: it.personal_rating === '' ? '' : Number(it.personal_rating),
      cleared: Boolean(it.personal_rating_cleared),
      ratedAt: it.ratedAt || '',
      completedAt: it.completedAt || '',
      progress: it.season_progress || {},
      overview: it.overview || '',
      poster: it.poster_path || '',
      genres: [...(it.genre_ids || [])].sort((a, b) => a - b),
    });

  const mergedSem = itemSem(merged);
  const changedLocal = itemSem(localItem) !== mergedSem;
  const changedRemote = itemSem(remoteItem) !== mergedSem;

  const conflict: UserDataConflictItem | undefined =
    statusDiffers || bothHaveDifferentRatings
      ? {
          profileId,
          mediaKey: key,
          title: merged.title,
          localStatus: localItem.status,
          remoteStatus: remoteItem.status,
          localRating: localItem.personal_rating,
          remoteRating: remoteItem.personal_rating,
          resolution: resolutionNote || 'Alan düzeyinde kayıpsız birleştirildi',
        }
      : undefined;

  return { merged, conflict, changedLocal, changedRemote };
}

export interface ReconcileUserDataOptions {
  /**
   * True when `localDoc` came from an unhydrated client/server session that created
   * a placeholder `profile-default` ("Profilim") before fetching existing remote profiles.
   * Folds those newly added items/tombstones directly into remote's active profile.
   */
  foldUnhydratedDefaultProfile?: boolean;
  /**
   * Controls which side's `activeProfileId` is preferred when both exist in the merged result.
   */
  preferActiveProfileFrom?: 'local' | 'remote';
  /**
   * When `'local'`, profile scalar/set preferences (`disliked`, `hidden`, `providers`, `mood`,
   * `reminders`), `favoriteActors`, `name`, and `isDemo` follow `localDoc` authoritatively
   * (used when client saves at matching server revision so un-disliking/unchecking sticks),
   * while `items` and `deleted_keys` STILL merge non-destructively!
   * Defaults to `'union'`.
   */
  authoritativeScalarSide?: 'local' | 'remote' | 'union';
}

/**
 * Kullanıcı verisini (`cinetrack-data.json`) varsayılan silmesiz (no-deletion) ve
 * `deleted_keys` mezar taşı (tombstone) duyarlı politikayla iki yönlü kayıpsız birleştirir.
 */
export function reconcileUserDataDocumentsLossless(
  localDoc: DataDocument,
  remoteDoc: DataDocument,
  options: ReconcileUserDataOptions = {}
): {
  mergedDoc: DataDocument;
  addedToLocal: number;
  addedToRemote: number;
  updatedItems: number;
  conflicts: UserDataConflictItem[];
} {
  const remoteById = new Map<string, Profile>();
  for (const p of remoteDoc.profiles || []) {
    if (p && p.id) remoteById.set(p.id, p);
  }

  const localProfilesList = Array.isArray(localDoc.profiles) ? localDoc.profiles : [];
  const remoteProfilesList = Array.isArray(remoteDoc.profiles) ? remoteDoc.profiles : [];

  // Unhydrated placeholder 'profile-default' tespiti:
  // Yerel oturum henüz uzak profilleri görmeden otomatik 'profile-default' ("Profilim") oluşturup
  // içine 1-2 yeni içerik eklediyse ve uzakta 'profile-default' olmayıp gerçek profil varsa,
  // yeni eklenen içerikleri uzaktaki aktif profile katla; kullanıcıyı 1 içerikli sahte profilde bırakma.
  const onlyLocalDefault =
    localProfilesList.length === 1 &&
    localProfilesList[0]?.id === 'profile-default' &&
    (localProfilesList[0]?.name || 'Profilim') === 'Profilim' &&
    !remoteById.has('profile-default') &&
    remoteProfilesList.length > 0;

  const autoHeuristicFold =
    onlyLocalDefault &&
    (localProfilesList[0]?.items?.length || 0) <= 5 &&
    remoteProfilesList.some(
      (rp) => !rp.isDemo && (rp.items?.length || 0) > (localProfilesList[0]?.items?.length || 0)
    );

  const shouldFoldDefault =
    onlyLocalDefault && (Boolean(options.foldUnhydratedDefaultProfile) || autoHeuristicFold);

  const foldedTargetId = shouldFoldDefault
    ? remoteById.has(remoteDoc.activeProfileId)
      ? remoteDoc.activeProfileId
      : remoteProfilesList[0].id
    : null;

  const localById = new Map<string, Profile>();
  for (const p of localProfilesList) {
    if (!p || !p.id) continue;
    const effectiveId =
      foldedTargetId && p.id === 'profile-default' ? foldedTargetId : p.id;
    localById.set(effectiveId, effectiveId === p.id ? p : { ...p, id: effectiveId });
  }

  const allProfileIds = Array.from(
    new Set<string>([...localById.keys(), ...remoteById.keys()])
  );

  const mergedProfiles: Profile[] = [];
  const conflicts: UserDataConflictItem[] = [];
  let addedToLocal = 0;
  let addedToRemote = 0;
  let updatedItems = 0;

  const scalarMode = shouldFoldDefault ? 'union' : options.authoritativeScalarSide || 'union';

  for (const profileId of allProfileIds) {
    const lp = localById.get(profileId);
    const rp = remoteById.get(profileId);

    if (lp && !rp) {
      mergedProfiles.push(lp);
      addedToRemote += (lp.items || []).length;
      continue;
    }
    if (rp && !lp) {
      mergedProfiles.push(rp);
      addedToLocal += (rp.items || []).length;
      continue;
    }
    if (!lp || !rp) continue;

    const lpLiveItems = lp.isDemo && !rp.isDemo ? [] : lp.items || [];
    const rpLiveItems = rp.isDemo && !lp.isDemo ? [] : rp.items || [];

    const localItemsMap = new Map<string, SavedItem>();
    for (const it of dedupeItems(lpLiveItems)) {
      localItemsMap.set(makeMediaKey(it), it);
    }
    const remoteItemsMap = new Map<string, SavedItem>();
    for (const it of dedupeItems(rpLiveItems)) {
      remoteItemsMap.set(makeMediaKey(it), it);
    }

    const lpDeleted = normalizeDeletedKeys(lp.deleted_keys);
    const rpDeleted = normalizeDeletedKeys(rp.deleted_keys);
    const mergedDeletedKeys: Record<string, string> = { ...lpDeleted };
    for (const [delKey, delIso] of Object.entries(rpDeleted)) {
      const existingIso = mergedDeletedKeys[delKey];
      if (!existingIso || Date.parse(delIso) > Date.parse(existingIso)) {
        mergedDeletedKeys[delKey] = delIso;
      }
    }

    const allItemKeys = Array.from(
      new Set<string>([...localItemsMap.keys(), ...remoteItemsMap.keys()])
    );

    const combinedItems: SavedItem[] = [];
    for (const key of allItemKeys) {
      const li = localItemsMap.get(key);
      const ri = remoteItemsMap.get(key);
      if (li && !ri) {
        const remoteTombstoneIso = rpDeleted[key];
        if (remoteTombstoneIso) {
          const liMs = getSavedItemEffectiveTimestampMs(li);
          const delMs = Date.parse(remoteTombstoneIso);
          if (Number.isFinite(liMs) && Number.isFinite(delMs) && liMs > delMs) {
            combinedItems.push(li);
            delete mergedDeletedKeys[key];
            addedToRemote++;
          } else {
            mergedDeletedKeys[key] = remoteTombstoneIso;
            updatedItems++;
          }
        } else {
          combinedItems.push(li);
          delete mergedDeletedKeys[key];
          addedToRemote++;
        }
      } else if (ri && !li) {
        const localTombstoneIso = lpDeleted[key];
        if (localTombstoneIso) {
          const riMs = getSavedItemEffectiveTimestampMs(ri);
          const delMs = Date.parse(localTombstoneIso);
          if (Number.isFinite(riMs) && Number.isFinite(delMs) && riMs > delMs) {
            combinedItems.push(ri);
            delete mergedDeletedKeys[key];
            addedToLocal++;
          } else {
            mergedDeletedKeys[key] = localTombstoneIso;
            updatedItems++;
          }
        } else {
          combinedItems.push(ri);
          delete mergedDeletedKeys[key];
          addedToLocal++;
        }
      } else if (li && ri) {
        const res = mergeTwoSavedItemsLossless(profileId, li, ri);
        combinedItems.push(res.merged);
        delete mergedDeletedKeys[key];
        if (res.conflict) conflicts.push(res.conflict);
        if (res.changedLocal || res.changedRemote) updatedItems++;
      }
    }

    let mergedPrefs: Preferences;
    let mergedFavActors: FavoriteActorInfo[];
    let profileName: string;
    let mergedIsDemo: boolean;

    if (scalarMode === 'local') {
      mergedPrefs = normalizePreferences(lp.preferences || {});
      mergedFavActors = normalizeFavoriteActors(lp.favoriteActors || []);
      profileName = lp.name || rp.name || 'Profilim';
      mergedIsDemo = Boolean(lp.isDemo);
    } else if (scalarMode === 'remote') {
      mergedPrefs = normalizePreferences(rp.preferences || {});
      mergedFavActors = normalizeFavoriteActors(rp.favoriteActors || []);
      profileName = rp.name || lp.name || 'Profilim';
      mergedIsDemo = Boolean(rp.isDemo);
    } else {
      const mergedDisliked = Array.from(
        new Set<string>([
          ...canonicalizeMediaKeyList(lp.preferences?.disliked || []),
          ...canonicalizeMediaKeyList(rp.preferences?.disliked || []),
        ])
      );
      const mergedHidden = Array.from(
        new Set<string>([
          ...canonicalizeMediaKeyList(lp.preferences?.hidden || []),
          ...canonicalizeMediaKeyList(rp.preferences?.hidden || []),
        ])
      );
      const mergedProviders = Array.from(
        new Set<string>([
          ...(lp.preferences?.providers || []).map(String),
          ...(rp.preferences?.providers || []).map(String),
        ])
      ).sort();
      const mergedNotified = Array.from(
        new Set<string>([
          ...(lp.preferences?.notified || []),
          ...(rp.preferences?.notified || []),
        ])
      ).slice(-200);

      mergedPrefs = normalizePreferences({
        disliked: mergedDisliked,
        ...(mergedHidden.length > 0 ? { hidden: mergedHidden } : {}),
        providers: mergedProviders,
        mood:
          options.preferActiveProfileFrom === 'remote'
            ? rp.preferences?.mood || lp.preferences?.mood || ''
            : lp.preferences?.mood || rp.preferences?.mood || '',
        reminders: Boolean(lp.preferences?.reminders || rp.preferences?.reminders),
        notified: mergedNotified,
      });

      const actorMap = new Map<number, FavoriteActorInfo>();
      for (const actor of normalizeFavoriteActors([
        ...(lp.favoriteActors || []),
        ...(rp.favoriteActors || []),
      ])) {
        const prev = actorMap.get(actor.id);
        if (!prev) {
          actorMap.set(actor.id, actor);
        } else {
          actorMap.set(actor.id, {
            id: actor.id,
            name: prev.name || actor.name,
            profile_path: prev.profile_path || actor.profile_path || null,
            character: prev.character || actor.character,
          });
        }
      }
      mergedFavActors = Array.from(actorMap.values());

      profileName =
        lp.name && lp.name !== 'Profilim'
          ? lp.name
          : rp.name && rp.name !== 'Profilim'
          ? rp.name
          : lp.name || rp.name || 'Profilim';
      mergedIsDemo = Boolean(lp.isDemo && rp.isDemo);
    }

    const earliestCreated = pickEarliestIso([lp.createdAt, rp.createdAt]) || '';

    mergedProfiles.push({
      id: profileId,
      name: profileName,
      createdAt: earliestCreated,
      preferences: mergedPrefs,
      items: dedupeItems(combinedItems),
      favoriteActors: mergedFavActors,
      ...(Object.keys(mergedDeletedKeys).length > 0 ? { deleted_keys: mergedDeletedKeys } : {}),
      isDemo: mergedIsDemo,
    });
  }

  const effectiveLocalActiveId =
    foldedTargetId && localDoc.activeProfileId === 'profile-default'
      ? foldedTargetId
      : localDoc.activeProfileId;

  const preferredActive =
    options.preferActiveProfileFrom === 'remote' || Boolean(foldedTargetId)
      ? mergedProfiles.find((p) => p.id === remoteDoc.activeProfileId)?.id ||
        mergedProfiles.find((p) => p.id === effectiveLocalActiveId)?.id ||
        mergedProfiles[0]?.id ||
        'profile-default'
      : mergedProfiles.find((p) => p.id === effectiveLocalActiveId)?.id ||
        mergedProfiles.find((p) => p.id === remoteDoc.activeProfileId)?.id ||
        mergedProfiles[0]?.id ||
        'profile-default';

  const maxRev = Math.max(localDoc.revision ?? 0, remoteDoc.revision ?? 0);

  return {
    mergedDoc: {
      version: 3,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      engineVersion: ENGINE_VERSION,
      activeProfileId: preferredActive,
      profiles: mergedProfiles,
      revision: maxRev + 1,
      updatedAt: new Date().toISOString(),
    },
    addedToLocal,
    addedToRemote,
    updatedItems,
    conflicts,
  };
}

function buildComparableUserDataSnapshot(doc: DataDocument | null | undefined) {
  if (!doc) return null;
  const profiles = [...(doc.profiles || [])]
    .sort((a, b) => String(a.id).localeCompare(String(b.id)))
    .map((p) => {
      const items = dedupeItems(p.items || [])
        .map((it) => ({
          key: makeMediaKey(it),
          title: it.title || '',
          status: it.status,
          personal_rating: it.personal_rating === '' ? '' : Number(it.personal_rating),
          personal_rating_cleared: Boolean(it.personal_rating_cleared),
          season_progress: it.season_progress || {},
          custom: Boolean(it.custom),
          isDemo: Boolean(it.isDemo),
        }))
        .sort((a, b) => a.key.localeCompare(b.key));

      const prefs = p.preferences || {
        disliked: [],
        providers: [],
        mood: '',
        reminders: false,
        notified: [],
      };
      const normalizedTombstones = normalizeDeletedKeys(p.deleted_keys);

      return {
        id: p.id,
        name: p.name || 'Profilim',
        isDemo: Boolean(p.isDemo),
        preferences: {
          disliked: canonicalizeMediaKeyList(prefs.disliked || []).sort(),
          hidden: canonicalizeMediaKeyList(prefs.hidden || []).sort(),
          providers: [...(prefs.providers || [])].map(String).sort(),
          mood: prefs.mood || '',
          reminders: Boolean(prefs.reminders),
        },
        favoriteActors: [...(p.favoriteActors || [])]
          .map((a) => ({ id: a.id, name: a.name, profile_path: a.profile_path ?? null }))
          .sort((a, b) => a.id - b.id),
        deleted_keys: normalizedTombstones,
        items,
      };
    });

  return {
    activeProfileId: doc.activeProfileId || '',
    profiles,
  };
}

export function areUserDataDocumentsSemanticallyEqual(
  a: DataDocument | null | undefined,
  b: DataDocument | null | undefined
): boolean {
  if (!a || !b) return false;
  return (
    stringifyUserDataDeterministic(buildComparableUserDataSnapshot(a)) ===
    stringifyUserDataDeterministic(buildComparableUserDataSnapshot(b))
  );
}
