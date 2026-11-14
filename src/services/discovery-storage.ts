import { get as idbGet, set as idbSet, createStore as createIdbStore, type UseStore } from 'idb-keyval';
import type {
  PersistentTasteMapData,
  TasteMapEntry,
  PersistentCandidatePoolData,
} from '../core/cinetrack-core.ts';
import {
  getTasteMapStorageKey,
  createDefaultTasteMapData,
  createDefaultPoolCursors,
  createDefaultPoolData,
  canonicalizeMediaKey,
  canonicalizeMediaKeyList,
  inferLifecycleRing,
  sanitizeTasteMapEntryImpressions,
  pruneArchivedTasteEntries,
  syncPoolCandidatesWithTasteMap,
  MAX_IMPRESSION_HISTORY_PER_ENTRY,
  POOL_TARGET_CAPACITY,
} from '../core/cinetrack-core.ts';
import { migratePersistentTasteMapData } from '../core/keys.ts';
import { registerCandidatePoolStorePort } from '../core/candidate-pool-store-port.ts';

let discoveryHistoryIdbStore: UseStore | undefined;
let candidatePoolIdbStore: UseStore | undefined;
const idbHydratedTasteMaps = new Map<string, PersistentTasteMapData>();
const idbHydratedPools = new Map<string, PersistentCandidatePoolData>();
const inMemoryTasteMapFallback = new Map<string, { storageRef: Storage | null; raw: string }>();
const inMemoryPoolFallback = new Map<string, { storageRef: unknown; raw: string }>();
const pendingCoreIdbWrites = new Set<Promise<void>>();

export function getDiscoveryHistoryIdbStore(): UseStore | undefined {
  if (typeof indexedDB === 'undefined') return undefined;
  if (!discoveryHistoryIdbStore) {
    discoveryHistoryIdbStore = createIdbStore('cinetrack-discovery-history-db', 'ct_discovery_history');
  }
  return discoveryHistoryIdbStore;
}

export function getCandidatePoolIdbStore(): UseStore | undefined {
  if (typeof indexedDB === 'undefined') return undefined;
  if (!candidatePoolIdbStore) {
    candidatePoolIdbStore = createIdbStore('cinetrack-candidate-pool-db', 'ct_candidate_pool');
  }
  return candidatePoolIdbStore;
}

export function trackCoreIdbWrite(promise: Promise<void>): void {
  pendingCoreIdbWrites.add(promise);
  void promise.finally(() => {
    pendingCoreIdbWrites.delete(promise);
  });
}

export async function flushCoreIdbWrites(): Promise<void> {
  await Promise.allSettled(Array.from(pendingCoreIdbWrites));
}

export function resetCoreIdbMirrorsForTests(): void {
  idbHydratedTasteMaps.clear();
  idbHydratedPools.clear();
  inMemoryTasteMapFallback.clear();
  inMemoryPoolFallback.clear();
  discoveryHistoryIdbStore = undefined;
  candidatePoolIdbStore = undefined;
}

function compactTasteMapForQuota(data: PersistentTasteMapData): PersistentTasteMapData {
  const lastKeysSet = new Set(canonicalizeMediaKeyList(data.lastRecommendedKeys || []));
  const compactEntries: Record<string, TasteMapEntry> = {};
  for (const [k, v] of Object.entries(data.entries || {})) {
    if (!v) continue;
    compactEntries[k] = {
      ...v,
      overview: lastKeysSet.has(k)
        ? (v.overview || '').slice(0, 320)
        : (v.overview || '').slice(0, 120),
      impressionHistory: Array.isArray(v.impressionHistory) ? v.impressionHistory.slice(-10) : [],
    };
  }

  const prunedArchived = pruneArchivedTasteEntries(data.archivedEntries || {}, 100);
  const compactArchived: Record<string, TasteMapEntry> = {};
  for (const [k, v] of Object.entries(prunedArchived)) {
    if (!v) continue;
    if (v.status === 'active' && (v.shownCount || 0) === 0 && (v.skippedCount || 0) === 0) {
      continue;
    }
    compactArchived[k] = {
      ...v,
      overview: '',
      impressionHistory: Array.isArray(v.impressionHistory) ? v.impressionHistory.slice(-5) : [],
    };
  }

  return {
    ...data,
    entries: compactEntries,
    archivedEntries: compactArchived,
  };
}

export function sanitizeLoadedTasteMapObject(
  profileId: string,
  rawParsed: any
): { loadedData: PersistentTasteMapData; needsMigrationWrite: boolean } | null {
  if (!rawParsed || typeof rawParsed.entries !== 'object') return null;
  const migration = migratePersistentTasteMapData(rawParsed, MAX_IMPRESSION_HISTORY_PER_ENTRY);
  const parsed = migration.data;
  const lastRecommendedKeys: string[] = canonicalizeMediaKeyList(parsed.lastRecommendedKeys || []);
  let needsMigrationWrite = migration.changed;

  const sanitizedEntries: Record<string, TasteMapEntry> = {};
  for (const [k, v] of Object.entries(parsed.entries || {})) {
    const sanitized = sanitizeTasteMapEntryImpressions(v as TasteMapEntry);
    const mediaKey = canonicalizeMediaKey(sanitized.mediaKey || k);
    const inferredRing = inferLifecycleRing(mediaKey, sanitized, lastRecommendedKeys);
    if (sanitized.ring !== inferredRing || sanitized.initialRing !== 'ring0' || k !== mediaKey) {
      needsMigrationWrite = true;
    }
    sanitizedEntries[mediaKey] = {
      ...sanitized,
      mediaKey,
      ring: inferredRing,
      initialRing: 'ring0',
    };
  }

  const sanitizedArchived: Record<string, TasteMapEntry> = {};
  if (parsed.archivedEntries && typeof parsed.archivedEntries === 'object') {
    for (const [k, v] of Object.entries(parsed.archivedEntries)) {
      const sanitized = sanitizeTasteMapEntryImpressions(v as TasteMapEntry);
      const mediaKey = canonicalizeMediaKey(sanitized.mediaKey || k);
      if (sanitizedEntries[mediaKey]) {
        needsMigrationWrite = true;
        continue;
      }
      const inferredRing = inferLifecycleRing(mediaKey, sanitized, lastRecommendedKeys);
      if (sanitized.ring !== inferredRing || sanitized.initialRing !== 'ring0' || k !== mediaKey) {
        needsMigrationWrite = true;
      }
      sanitizedArchived[mediaKey] = {
        ...sanitized,
        mediaKey,
        ring: inferredRing,
        initialRing: 'ring0',
      };
    }
  }

  const loadedData: PersistentTasteMapData = {
    profileId,
    profileSignature: parsed.profileSignature || '',
    profileSnapshot: parsed.profileSnapshot || undefined,
    algorithmVersion: parsed.algorithmVersion || undefined,
    weightsSignature: parsed.weightsSignature || undefined,
    updatedAt: parsed.updatedAt || new Date().toISOString(),
    entries: sanitizedEntries,
    archivedEntries: sanitizedArchived,
    lastRecommendedKeys,
    lastBatchTimestamp: parsed.lastBatchTimestamp || null,
    cachedBalancedItems: Array.isArray(parsed.cachedBalancedItems) ? parsed.cachedBalancedItems : undefined,
    lastTargetType: parsed.lastTargetType || undefined,
    lastExplanation: parsed.lastExplanation || undefined,
    summary: parsed.summary || undefined,
  };
  return { loadedData, needsMigrationWrite };
}

export async function hydrateDiscoveryHistoryIdb(profileId: string): Promise<PersistentTasteMapData> {
  const key = getTasteMapStorageKey(profileId);
  const store = getDiscoveryHistoryIdbStore();
  if (store) {
    try {
      const idbVal = await idbGet<PersistentTasteMapData>(key, store);
      if (idbVal && typeof idbVal.entries === 'object') {
        const sanitized = sanitizeLoadedTasteMapObject(profileId, idbVal);
        if (sanitized) {
          idbHydratedTasteMaps.set(key, sanitized.loadedData);
          try {
            if (typeof localStorage !== 'undefined') localStorage.removeItem(key);
          } catch { /* opsiyonel adım: hata ana akışı etkilemez */ }
          if (sanitized.needsMigrationWrite) {
            savePersistentTasteMap(profileId, sanitized.loadedData);
          }
          return sanitized.loadedData;
        }
      }
    } catch { /* opsiyonel adım: hata ana akışı etkilemez */ }
  }
  return loadPersistentTasteMap(profileId);
}

export function loadPersistentTasteMap(profileId: string): PersistentTasteMapData {
  const key = getTasteMapStorageKey(profileId);
  const store = getDiscoveryHistoryIdbStore();
  if (store && idbHydratedTasteMaps.has(key)) {
    return idbHydratedTasteMaps.get(key) as PersistentTasteMapData;
  }

  try {
    if (typeof localStorage !== 'undefined') {
      const fallback = inMemoryTasteMapFallback.get(key);
      let raw = localStorage.getItem(key);
      if (fallback && fallback.storageRef === localStorage) {
        raw = fallback.raw;
      } else if (fallback && fallback.storageRef !== localStorage) {
        inMemoryTasteMapFallback.delete(key);
      }
      if (raw) {
        const rawParsed = JSON.parse(raw);
        const sanitized = sanitizeLoadedTasteMapObject(profileId, rawParsed);
        if (sanitized) {
          if (store || sanitized.needsMigrationWrite) {
            savePersistentTasteMap(profileId, sanitized.loadedData);
          }
          return sanitized.loadedData;
        }
      }
    }
  } catch { /* opsiyonel adım: hata ana akışı etkilemez */ }
  return createDefaultTasteMapData(profileId);
}

export function savePersistentTasteMap(profileId: string, data: PersistentTasteMapData): void {
  const key = getTasteMapStorageKey(profileId);
  const normalizedData: PersistentTasteMapData = {
    ...data,
    lastRecommendedKeys: canonicalizeMediaKeyList(data.lastRecommendedKeys || []),
    archivedEntries: pruneArchivedTasteEntries(data.archivedEntries || {}),
  };

  const store = getDiscoveryHistoryIdbStore();
  if (store) {
    idbHydratedTasteMaps.set(key, normalizedData);
    inMemoryTasteMapFallback.delete(key);
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.removeItem(key);
      }
    } catch { /* opsiyonel adım: hata ana akışı etkilemez */ }
    trackCoreIdbWrite(
      idbSet(key, normalizedData, store).catch((err) => {
        console.warn('[Cinethos] Discovery history IDB write failed:', err);
      })
    );
    return;
  }

  if (typeof localStorage === 'undefined') return;

  const serialized = JSON.stringify(normalizedData);
  try {
    localStorage.setItem(key, serialized);
    inMemoryTasteMapFallback.delete(key);
    return;
  } catch {
    const compacted = compactTasteMapForQuota(normalizedData);
    const compactSerialized = JSON.stringify(compacted);
    try {
      localStorage.setItem(key, compactSerialized);
      inMemoryTasteMapFallback.delete(key);
    } catch {
      inMemoryTasteMapFallback.set(key, {
        storageRef: localStorage,
        raw: compactSerialized,
      });
    }
  }
}

export async function hydrateCandidatePoolsIdb(
  profileId: string
): Promise<{ movie: PersistentCandidatePoolData; tv: PersistentCandidatePoolData }> {
  const store = getCandidatePoolIdbStore();
  if (store) {
    for (const mediaType of ['movie', 'tv'] as const) {
      const key = `cinetrack_pool_${mediaType}_${profileId}`;
      try {
        const idbVal = await idbGet<PersistentCandidatePoolData>(key, store);
        if (idbVal && idbVal.mediaType === mediaType && Array.isArray(idbVal.items)) {
          idbHydratedPools.set(key, {
            mediaType,
            updatedAt: idbVal.updatedAt || new Date().toISOString(),
            items: idbVal.items,
            cursors: {
              ...createDefaultPoolCursors(),
              ...(idbVal.cursors || {}),
            },
          });
          try {
            if (typeof localStorage !== 'undefined') localStorage.removeItem(key);
          } catch { /* opsiyonel adım: hata ana akışı etkilemez */ }
        }
      } catch { /* opsiyonel adım: hata ana akışı etkilemez */ }
    }
  }
  return {
    movie: loadPersistentPoolData(profileId, 'movie'),
    tv: loadPersistentPoolData(profileId, 'tv'),
  };
}

export function loadPersistentPoolData(
  profileId: string,
  mediaType: 'movie' | 'tv'
): PersistentCandidatePoolData {
  const key = `cinetrack_pool_${mediaType}_${profileId}`;
  const store = getCandidatePoolIdbStore();
  if (store && idbHydratedPools.has(key)) {
    const cached = idbHydratedPools.get(key) as PersistentCandidatePoolData;
    const tasteMap = loadPersistentTasteMap(profileId);
    const syncedItems = syncPoolCandidatesWithTasteMap(cached.items || [], tasteMap);
    return {
      mediaType,
      updatedAt: cached.updatedAt || new Date().toISOString(),
      items: syncedItems,
      cursors: {
        ...createDefaultPoolCursors(),
        ...(cached.cursors || {}),
      },
    };
  }

  try {
    if (typeof localStorage !== 'undefined') {
      const fallback = inMemoryPoolFallback.get(key);
      let raw = localStorage.getItem(key);
      if (fallback && fallback.storageRef === localStorage) {
        raw = fallback.raw;
      } else if (fallback && fallback.storageRef !== localStorage) {
        inMemoryPoolFallback.delete(key);
      }
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && parsed.mediaType === mediaType && Array.isArray(parsed.items)) {
          const tasteMap = loadPersistentTasteMap(profileId);
          const syncedItems = syncPoolCandidatesWithTasteMap(parsed.items, tasteMap);
          const loadedPool: PersistentCandidatePoolData = {
            mediaType,
            updatedAt: parsed.updatedAt || new Date().toISOString(),
            items: syncedItems,
            cursors: {
              ...createDefaultPoolCursors(),
              ...(parsed.cursors || {}),
            },
          };
          if (store) {
            savePersistentPoolData(profileId, loadedPool);
          }
          return loadedPool;
        }
      }
    }
  } catch { /* opsiyonel adım: hata ana akışı etkilemez */ }
  return createDefaultPoolData(mediaType);
}

export function savePersistentPoolData(
  profileId: string,
  data: PersistentCandidatePoolData
): void {
  const key = `cinetrack_pool_${data.mediaType}_${profileId}`;
  const updatedAt = new Date().toISOString();
  const sliced = data.items.slice(0, POOL_TARGET_CAPACITY);
  const poolRecord: PersistentCandidatePoolData = {
    mediaType: data.mediaType,
    updatedAt,
    items: sliced,
    cursors: data.cursors,
  };

  const store = getCandidatePoolIdbStore();
  if (store) {
    idbHydratedPools.set(key, poolRecord);
    inMemoryPoolFallback.delete(key);
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.removeItem(key);
      }
    } catch { /* opsiyonel adım: hata ana akışı etkilemez */ }
    trackCoreIdbWrite(
      idbSet(key, poolRecord, store).catch((err) => {
        console.warn('[Cinethos] Candidate pool IDB write failed:', err);
      })
    );
    return;
  }

  if (typeof localStorage === 'undefined') return;
  const fullPayload = JSON.stringify(poolRecord);
  try {
    localStorage.setItem(key, fullPayload);
    inMemoryPoolFallback.delete(key);
  } catch {
    const compactPayload = JSON.stringify({
      mediaType: data.mediaType,
      updatedAt,
      items: sliced.map((it) => ({
        ...it,
        overview: (it.overview || '').slice(0, 140),
      })),
      cursors: data.cursors,
    });
    try {
      localStorage.setItem(key, compactPayload);
      inMemoryPoolFallback.delete(key);
    } catch {
      inMemoryPoolFallback.set(key, {
        storageRef: localStorage,
        raw: compactPayload,
      });
    }
  }
}

registerCandidatePoolStorePort({
  hydrateDiscoveryHistory: hydrateDiscoveryHistoryIdb,
  hydrateCandidatePools: hydrateCandidatePoolsIdb,
  loadPool: loadPersistentPoolData,
  savePool: savePersistentPoolData,
});
