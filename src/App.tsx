import React, { useState, useEffect, useRef, useCallback, Suspense, lazy } from 'react';
import { Header } from './components/Header.tsx';
import { Hero } from './components/Hero.tsx';
import { Stats } from './components/Stats.tsx';
import { Controls } from './components/Controls.tsx';
import { MediaGrid } from './components/MediaGrid.tsx';
import { DetailModal } from './components/DetailModal.tsx';
import { QuickSaveModal } from './components/QuickSaveModal.tsx';
import { PersonDrawer } from './components/PersonDrawer.tsx';
import { AddCustomModal } from './components/AddCustomModal.tsx';
import { ProfileModal } from './components/ProfileModal.tsx';
import { ImportChoiceModal } from './components/ImportChoiceModal.tsx';
import { TvdbStockModal } from './components/TvdbStockModal.tsx';
import { Toast } from './components/Toast.tsx';
import { ErrorBoundary } from './components/ErrorBoundary.tsx';
import { OfflineIndicator } from './components/OfflineIndicator.tsx';
import { ConflictBanner } from './components/ConflictBanner.tsx';

function lazyWithRetry<T extends React.ComponentType<any>>(
  importer: () => Promise<{ default: T }>
): React.LazyExoticComponent<T> {
  return lazy(async () => {
    try {
      return await importer();
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
      return importer();
    }
  });
}

const TasteMapView = lazyWithRetry(() => import('./components/TasteMapView.tsx'));
const RelationshipExplorer = lazyWithRetry(() => import('./components/RelationshipExplorer.tsx'));
const TasteProfileDashboard = lazyWithRetry(() => import('./components/taste/TasteProfileDashboard.tsx'));

import {
  SavedItem,
  PoolCandidateItem,
  Profile,
  Preferences,
  DataDocument,
  normalizeSavedItem,
  dedupeItems,
  normalizePreferences,
  normalizeDataDocument,
  resolveAirDate,
  reminderDaysUntil,
  createRequestGate,
  parseBackupText,
  buildTasteProfileV3,
  scoreCandidatesV3,
  RECOMMENDATION_WEIGHTS_V3,
  findSavedItem,
  makeMediaKey,
  isItemSaved,
  filterHistoryByType,
  filterDislikedByType,
  TARGET_RECOMMENDATION_COUNT,
  FavoriteActorInfo,
  normalizeFavoriteActors,
  replenishCandidatePool,
  isCandidateEligibleInPool,
  selectBalancedRecommendations,
  CURRENT_SCHEMA_VERSION,
  ENGINE_VERSION,
  loadPersistentTasteMap,
  savePersistentTasteMap,
  updateTasteMapWithBatch,
  markTasteMapItemStatus,
  PersistentTasteMapData,
  TasteProfileSummary,
  computeTasteProfileSignature,
  buildTasteProfileSummary,
  isTasteMapCacheValid,
  recordDisplayedRecommendations,
  filterOutLastRecommendedCandidates,
  loadPersistentPoolData,
  savePersistentPoolData,
  hydratePoolFromCatalog,
  topUpFilteredCandidates,
  matchesSelectedGenre,
  resolveDiscoverGenreParam,
  ALGORITHM_VERSION,
  POOL_LOW_WATERMARK,
  HIDE_LISTED_CATEGORIES,
  filterHiddenUserRegisteredItems,
  normalizeDeletedKeys,
  hydrateDiscoveryHistoryIdb,
  hydrateCandidatePoolsIdb,
} from './core/cinetrack-core.ts';
import {
  fetchTmdb,
  fetchTmdbCached,
  fetchServerData,
  getLastKnownServerRevision,
  subscribeTmdbSource,
  checkServerTmdbStatus,
  fetchCatalogItems,
  fetchDerivedProfileData,
  pushCatalogItems,
  pushDerivedProfileData,
  TmdbSourceMeta,
  ServerConflictDetail,
} from './services/api.ts';
import {
  areUserDataDocumentsSemanticallyEqual,
  mergeSavedItemListsLossless,
  reconcileUserDataDocumentsLossless,
} from './core/user-data-merge.ts';
import {
  enrichSavedItemsFromCinemaKunye,
  extractCinemaKunyeFromItems,
  mergeCinemaKunyeDocumentsLossless,
} from './core/cinema-kunye.ts';
import { computeSourceCatalogSignature } from './core/derived-profile-cache.ts';
import {
  buildDerivedProfilePayloadFromTasteMap,
  enforceStrictMediaTypePool,
  enrichCatalogItemsWithTaste,
  hydrateTasteMapWithDerivedCache,
  mapRecommendationBatchToDisplayItems,
} from './core/recommendation-orchestrator.ts';
import { useOfflineSync } from './hooks/useOfflineSync.ts';
import { useStockEngine } from './hooks/useStockEngine.ts';
import { useCinemaKunye } from './hooks/useCinemaKunye.ts';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts.ts';
import { useItemActions } from './hooks/useItemActions.ts';
import { hasPendingOfflineSync } from './services/offline-queue.ts';
import {
  saveIsolatedProfileIdb,
  loadUserListsIdb,
  saveUserListsIdb,
  removeSurfacedKey,
  subscribeSeriesIndex,
  loadUiPrefsIdb,
  saveUiPrefsIdb,
  recordSkippedKeysIdb,
  removeSkippedKeyIdb,
  loadStockIdb,
} from './services/storage-idb.ts';
import {
  indexItemForSeries,
  registerLocalSavedSeriesHints,
  computeUserSeriesUniverses,
} from './services/series-service.ts';
import {
  consumeStockItem,
  enrichStockItemsTopCast,
  executeStockReplenishment,
  getStockMovies,
  getStockSeries,
  isCandidateEligibleForStock,
  manualPullStock,
  markItemsAsSurfaced,
  seedCandidatePoolFromStock,
  subscribeStockState,
  syncStockWithUserExclusions,
} from './services/stock-engine.ts';
import {
  enforcePosterCacheQuota,
  requestServiceWorkerPosterPurge,
} from './services/poster-cache-manager.ts';
import { getItemEncodingSync, maintainEncodingsDepot } from './services/encoding-service.ts';
import { runIdbSchemaMigrationsOnce } from './services/idb-schema-version.ts';
import { computeProfileCentroid, cosineSimilarity } from './core/encoding.ts';
import { advanceTvEpisodeProgress } from './core/tv-progress.ts';
import { mergeDuplicateSavedPair } from './core/duplicate-detector.ts';
import {
  checkWeeklyAutoBackup,
  recordProfileChangeAndMaybeBackup,
} from './services/auto-backup-service.ts';
import { startIdleStockEnrichment } from './services/idle-enrichment-service.ts';
import { dateYearsAgo, displayTitle, mapLimit, MOOD_GENRES } from './utils/helpers.ts';
import {
  compareMediaDatesAscending,
  compareMediaDatesDescending,
  isWithinReleaseWindow,
} from './utils/release-window.ts';

const PROFILES_STORAGE = 'cinetrack.profiles.v1';
const ACTIVE_PROFILE_STORAGE = 'cinetrack.activeProfile.v1';
const PROFILE_STORAGE = 'cinetrack.profile.v1';
const DIRTY_KEY = 'cinetrack.dirty.v2';
const HIDE_LISTED_STORAGE_KEY = 'cinetrack_hide_listed_items';
const EMPTY_REASONS_MAP = new Map<string, string>();

function listStorageKey(profileId: string) {
  return `cinetrack.profile.${profileId}.watchlist.v1`;
}
function preferencesStorageKey(profileId: string) {
  return `cinetrack.profile.${profileId}.preferences.v1`;
}

function hasPersistedProfilesInStorage(): boolean {
  try {
    const stored = JSON.parse(localStorage.getItem(PROFILES_STORAGE) || 'null');
    return Array.isArray(stored) && stored.length > 0;
  } catch {
    return false;
  }
}

function loadInitialProfiles(): Profile[] {
  try {
    const stored = JSON.parse(localStorage.getItem(PROFILES_STORAGE) || 'null');
    const profiles = Array.isArray(stored)
      ? stored
          .filter((p) => p && /^profile-[A-Za-z0-9_-]{1,60}$/.test(p.id) && typeof p.name === 'string')
          .map((p) => {
            const delKeys = loadDeletedKeys(p.id);
            return {
              id: p.id,
              name: p.name.slice(0, 40),
              createdAt: p.createdAt || '',
              isDemo: Boolean(p.isDemo),
              preferences: loadProfilePreferences(p.id),
              items: loadProfileItems(p.id),
              favoriteActors: loadFavoriteActors(p.id),
              ...(Object.keys(delKeys).length > 0 ? { deleted_keys: delKeys } : {}),
            };
          })
      : [];
    if (profiles.length) return profiles;
    const legacyName = localStorage.getItem(PROFILE_STORAGE) || '';
    const defaultProfile: Profile = {
      id: 'profile-default',
      name: legacyName || 'Profilim',
      createdAt: new Date().toISOString(),
      preferences: { disliked: [], providers: [], mood: '', reminders: false, notified: [] },
      items: [],
    };
    return [defaultProfile];
  } catch {
    return [
      {
        id: 'profile-default',
        name: 'Profilim',
        createdAt: '',
        preferences: { disliked: [], providers: [], mood: '', reminders: false, notified: [] },
        items: [],
      },
    ];
  }
}

function loadActiveProfileId(profiles: Profile[]): string {
  try {
    const active = localStorage.getItem(ACTIVE_PROFILE_STORAGE);
    return profiles.some((p) => p.id === active) ? active! : profiles[0].id;
  } catch {
    return profiles[0].id;
  }
}

function loadProfilePreferences(profileId: string): Preferences {
  try {
    return normalizePreferences(
      JSON.parse(localStorage.getItem(preferencesStorageKey(profileId)) || '{}'),
      { knownMoods: Object.keys(MOOD_GENRES) }
    );
  } catch {
    return { disliked: [], providers: [], mood: '', reminders: false, notified: [] };
  }
}

function loadProfileItems(profileId: string): SavedItem[] {
  try {
    const stored = localStorage.getItem(listStorageKey(profileId)) || '[]';
    const parsed = JSON.parse(stored);
    return Array.isArray(parsed)
      ? (parsed
          .filter((item) => item && (item.media_type === 'movie' || item.media_type === 'tv') && item.id != null)
          .map(normalizeSavedItem)
          .filter(Boolean) as SavedItem[])
      : [];
  } catch {
    return [];
  }
}

function favActorsStorageKey(profileId: string): string {
  return `cinetrack_fav_actors_${profileId}`;
}

function loadFavoriteActors(profileId: string): FavoriteActorInfo[] {
  try {
    const stored = localStorage.getItem(favActorsStorageKey(profileId));
    return stored ? normalizeFavoriteActors(JSON.parse(stored)) : [];
  } catch {
    return [];
  }
}

function deletedKeysStorageKey(profileId: string): string {
  return `cinetrack_deleted_keys_${profileId}`;
}

function loadDeletedKeys(profileId: string): Record<string, string> {
  try {
    const stored = localStorage.getItem(deletedKeysStorageKey(profileId));
    return stored ? normalizeDeletedKeys(JSON.parse(stored)) : {};
  } catch {
    return {};
  }
}

export function App() {
  // Profiles and Watchlist State
  const [profiles, setProfiles] = useState<Profile[]>(loadInitialProfiles);
  const [activeProfileId, setActiveProfileId] = useState<string>(() => loadActiveProfileId(profiles));
  const activeProfile = profiles.find((p) => p.id === activeProfileId) || profiles[0];
  const [profileName, setProfileName] = useState<string>(activeProfile.name);
  const [preferences, setPreferences] = useState<Preferences>(() => loadProfilePreferences(activeProfileId));
  const [savedItems, setSavedItems] = useState<SavedItem[]>(() => loadProfileItems(activeProfileId));
  const [favoriteActors, setFavoriteActors] = useState<FavoriteActorInfo[]>(() => loadFavoriteActors(activeProfileId));
  const [deletedKeys, setDeletedKeys] = useState<Record<string, string>>(() => loadDeletedKeys(activeProfileId));
  const [dislikedItems, setDislikedItems] = useState<any[]>(() => {
    try {
      const cache = JSON.parse(localStorage.getItem('cinetrack_disliked_cache') || '{}');
      return Object.values(cache);
    } catch {
      return [];
    }
  });
  const [syncStatus, setSyncStatus] = useState<string>('Kayıt yeri: data/cinetrack-data.json');

  // Discover & Grid State
  const [tab, setTab] = useState<'discover' | 'list' | 'taste-map' | 'relationships'>('discover');
  const [tasteMapDisplayMode, setTasteMapDisplayMode] = useState<'poster' | 'graph' | 'identity'>('identity');
  const [tasteMap, setTasteMap] = useState<PersistentTasteMapData>(() => loadPersistentTasteMap(activeProfileId));
  const [category, setCategory] = useState<string>('trending');
  const [forYouSubTab, setForYouSubTab] = useState<'recommendations' | 'series'>('recommendations');
  const [seriesIndexVersion, setSeriesIndexVersion] = useState<number>(0);
  const [listStatus, setListStatus] = useState<string>('all');
  const [query, setQuery] = useState<string>('');
  const [selectedGenre, setSelectedGenre] = useState<string>('');
  const [selectedType, setSelectedType] = useState<string>('all');
  const [selectedSort, setSelectedSort] = useState<string>('popular');
  const [selectedProvider, setSelectedProvider] = useState<string>('');
  const [hideListedItems, setHideListedItems] = useState<boolean>(() => {
    try {
      return localStorage.getItem(HIDE_LISTED_STORAGE_KEY) === '1';
    } catch {
      return false;
    }
  });
  const [genresMap, setGenresMap] = useState<Record<number, string>>({});

  const [catalogItems, setCatalogItems] = useState<any[]>([]);
  const [trendingTop, setTrendingTop] = useState<any | null>(null);
  const [catalogPage, setCatalogPage] = useState<number>(1);
  const [catalogTotalPages, setCatalogTotalPages] = useState<number>(1);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [loadingMore, setLoadingMore] = useState<boolean>(false);
  const [forYouItems, setForYouItems] = useState<any[]>([]);
  const [forYouReasons, setForYouReasons] = useState<Map<string, string>>(new Map());
  const [forYouExplanation, setForYouExplanation] = useState<string>('');
  const [forYouProgressStep, setForYouProgressStep] = useState<string>('');
  const [serverConflict, setServerConflict] = useState<ServerConflictDetail | null>(null);
  const [serverSyncReady, setServerSyncReady] = useState(false);
  const [tmdbSourceMeta, setTmdbSourceMeta] = useState<TmdbSourceMeta>({
    source: 'unknown',
    cacheStatus: 'none',
    timestamp: Date.now(),
  });

  const [detailItem, setDetailItem] = useState<any | null>(null);
  const [quickSaveItem, setQuickSaveItem] = useState<any | null>(null);
  const [personId, setPersonId] = useState<number | null>(null);
  const [personName, setPersonName] = useState<string>('');
  const [relationshipInitialSourceKey, setRelationshipInitialSourceKey] = useState<string>('');
  const [addCustomOpen, setAddCustomOpen] = useState<boolean>(false);
  const [profileOpen, setProfileOpen] = useState<boolean>(false);
  const [tvdbModalOpen, setTvdbModalOpen] = useState<boolean>(false);
  const [pendingBackup, setPendingBackup] = useState<any | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const requestGateRef = useRef(createRequestGate());
  const toastTimerRef = useRef<any>(null);
  const lastForYouQueryKeyRef = useRef<string>('');
  const confirmNextBulkSyncRef = useRef<boolean>(false);
  const selectedTypeRef = useRef<string>(selectedType);
  selectedTypeRef.current = selectedType;
  const selectedGenreRef = useRef<string>(selectedGenre);
  selectedGenreRef.current = selectedGenre;
  const selectedSortRef = useRef<string>(selectedSort);
  selectedSortRef.current = selectedSort;
  const hideListedItemsRef = useRef<boolean>(hideListedItems);
  hideListedItemsRef.current = hideListedItems;
  const profilesRef = useRef<Profile[]>(profiles);
  profilesRef.current = profiles;
  const activeProfileIdRef = useRef<string>(activeProfileId);
  activeProfileIdRef.current = activeProfileId;
  const profileNameRef = useRef<string>(profileName);
  profileNameRef.current = profileName;
  const tasteMapRef = useRef<PersistentTasteMapData>(tasteMap);
  tasteMapRef.current = tasteMap;
  const forYouItemsRef = useRef<any[]>(forYouItems);
  forYouItemsRef.current = forYouItems;
  const hasHydratedLocalEffectRef = useRef(false);
  const applyingRemoteSnapshotRef = useRef(false);
  const localEditedDuringStartupRef = useRef(false);
  const hadStoredProfilesOnBootRef = useRef<boolean | null>(null);
  if (hadStoredProfilesOnBootRef.current === null) {
    hadStoredProfilesOnBootRef.current = hasPersistedProfilesInStorage();
  }
  const localWasDirtyRef = useRef<boolean | null>(null);
  if (localWasDirtyRef.current === null) {
    try {
      localWasDirtyRef.current = localStorage.getItem(DIRTY_KEY) === '1';
    } catch {
      localWasDirtyRef.current = false;
    }
  }
  const isDirtyRef = useRef<boolean>(Boolean(localWasDirtyRef.current));
  const isPushingRef = useRef<boolean>(false);
  const inFlightPushRef = useRef<Promise<void> | null>(null);
  const savedItemsRef = useRef(savedItems);
  savedItemsRef.current = savedItems;
  const preferencesRef = useRef(preferences);
  preferencesRef.current = preferences;
  const genresMapRef = useRef(genresMap);
  genresMapRef.current = genresMap;
  const dislikedItemsRef = useRef(dislikedItems);
  dislikedItemsRef.current = dislikedItems;
  const favoriteActorsRef = useRef<FavoriteActorInfo[]>(favoriteActors);
  favoriteActorsRef.current = favoriteActors;
  const deletedKeysRef = useRef<Record<string, string>>(deletedKeys);
  deletedKeysRef.current = deletedKeys;

  const uiPrefsHydratedProfileRef = useRef<string>('');
  const [stockStats, setStockStats] = useState({ movieCount: 0, tvCount: 0 });

  const refreshStockStats = useCallback(() => {
    void loadStockIdb().then((stock) => {
      const cleanMovies = (stock.movies || []).filter((m) =>
        isCandidateEligibleForStock(
          { ...m, media_type: 'movie' },
          savedItemsRef.current,
          preferencesRef.current
        )
      );
      const cleanTv = (stock.tv || []).filter((t) =>
        isCandidateEligibleForStock(
          { ...t, media_type: 'tv' },
          savedItemsRef.current,
          preferencesRef.current
        )
      );
      setStockStats({
        movieCount: cleanMovies.length,
        tvCount: cleanTv.length,
      });
    });
  }, []);

  useEffect(() => {
    refreshStockStats();
    const unsubscribeStock = subscribeStockState(() => {
      const cleanMovies = getStockMovies(savedItemsRef.current, preferencesRef.current);
      const cleanTv = getStockSeries(savedItemsRef.current, preferencesRef.current);
      setStockStats({
        movieCount: cleanMovies.length,
        tvCount: cleanTv.length,
      });
    });
    return () => {
      unsubscribeStock();
    };
  }, [refreshStockStats]);

  // Sorun 1: Kullanıcı listeleri, disliked veya hidden güncellendiğinde ct:stock deposunu arındır ve gerçek .length değerlerini yansıt
  useEffect(() => {
    void syncStockWithUserExclusions(activeProfileId, savedItems, preferences).then((res) => {
      setStockStats({
        movieCount: res.moviesCount,
        tvCount: res.tvCount,
      });
    });
    if (serverSyncReady || savedItems.length > 0) {
      void saveUserListsIdb(activeProfileId, savedItems);
    }
  }, [activeProfileId, savedItems, preferences, serverSyncReady]);

  // Stok görünümünde listeye eklenen içerik sayaç düşmesine rağmen ekranda kalıyordu; gridi anında arındır
  useEffect(() => {
    if (tab !== 'discover' || category !== 'stock') return;
    setCatalogItems((prev) => {
      const filtered = prev.filter((it) =>
        isCandidateEligibleForStock(it, savedItems, preferences)
      );
      return filtered.length === prev.length ? prev : filtered;
    });
  }, [savedItems, preferences, tab, category]);

  // IMP-17 (IDB Schema Migration) + IMP-16 (Weekly Auto-Backup Check) + IMP-11 (Idle Stock Enrichment)
  useEffect(() => {
    void runIdbSchemaMigrationsOnce();
    void checkWeeklyAutoBackup();
    const stopIdleEnrichment = startIdleStockEnrichment();
    return () => {
      stopIdleEnrichment();
    };
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(HIDE_LISTED_STORAGE_KEY, hideListedItems ? '1' : '0');
    } catch {}
  }, [hideListedItems]);

  // Hydrate & persist UI filter/sort preferences in Depo 10 (`ct:ui-prefs`)
  useEffect(() => {
    let active = true;
    uiPrefsHydratedProfileRef.current = '';
    void loadUiPrefsIdb(activeProfileId).then((stored) => {
      if (!active) return;
      if (stored) {
        if (stored.selectedType) {
          setSelectedType(stored.selectedType);
          selectedTypeRef.current = stored.selectedType;
        }
        if (stored.selectedSort) {
          setSelectedSort(stored.selectedSort);
        }
        if (typeof stored.selectedGenre === 'string') {
          setSelectedGenre(stored.selectedGenre);
          selectedGenreRef.current = stored.selectedGenre;
        }
        if (typeof stored.hideListedItems === 'boolean') {
          setHideListedItems(stored.hideListedItems);
          hideListedItemsRef.current = stored.hideListedItems;
        }
        if (stored.forYouSubTab === 'recommendations' || stored.forYouSubTab === 'series') {
          setForYouSubTab(stored.forYouSubTab);
        }
      }
      uiPrefsHydratedProfileRef.current = activeProfileId;
    });
    return () => {
      active = false;
    };
  }, [activeProfileId]);

  useEffect(() => {
    if (uiPrefsHydratedProfileRef.current !== activeProfileId) return;
    void saveUiPrefsIdb({
      profileId: activeProfileId,
      selectedType: selectedType === 'movie' || selectedType === 'tv' ? selectedType : 'all',
      selectedSort,
      selectedGenre,
      hideListedItems,
      forYouSubTab,
      updatedAt: new Date().toISOString(),
    });
  }, [activeProfileId, selectedType, selectedSort, selectedGenre, hideListedItems, forYouSubTab]);

  const showToast = useCallback((msg: string) => {
    setToastMessage(msg);
    clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToastMessage(null), 7000);
  }, []);

  // Global Keyboard Shortcuts (IMP-08 & Section 6.5)
  useKeyboardShortcuts({
    onFocusSearch: () => {
      const searchInput = document.querySelector<HTMLInputElement>('.search-input');
      if (searchInput) {
        searchInput.focus();
        searchInput.select();
      }
    },
    onSelectTab: (targetTab) => {
      setTab(targetTab);
    },
    onQuickSaveOrSync: () => {
      void pushToServer();
      showToast('Değişiklikler kaydedildi ve yerel sunucuyla eşitlendi.');
    },
    onOpenAddCustom: () => {
      setAddCustomOpen(true);
    },
    onEscape: () => {
      setDetailItem(null);
      setQuickSaveItem(null);
      setPersonId(null);
      setAddCustomOpen(false);
      setProfileOpen(false);
      setPendingBackup(null);
    },
  });

  // Sync to localStorage (quota-safe for >2 MB libraries: metadata-only in PROFILES_STORAGE + isolated watchlist write)
  useEffect(() => {
    try {
      const lightweightProfiles = profiles.map((p) => ({
        id: p.id,
        name: p.id === activeProfileId ? profileName : p.name,
        createdAt: p.createdAt || '',
        isDemo: Boolean(p.isDemo),
        favoriteActors: p.id === activeProfileId ? favoriteActors : p.favoriteActors || [],
        items: [],
      }));
      localStorage.setItem(PROFILES_STORAGE, JSON.stringify(lightweightProfiles));
      localStorage.setItem(ACTIVE_PROFILE_STORAGE, activeProfileId);
      localStorage.setItem(PROFILE_STORAGE, profileName);
      localStorage.setItem(preferencesStorageKey(activeProfileId), JSON.stringify(preferences));
      localStorage.setItem(favActorsStorageKey(activeProfileId), JSON.stringify(favoriteActors));
      localStorage.setItem(deletedKeysStorageKey(activeProfileId), JSON.stringify(deletedKeys));
    } catch (err) {
      console.warn('LocalStorage metadata save warning:', err);
    }

    try {
      localStorage.setItem(listStorageKey(activeProfileId), JSON.stringify(savedItems));
    } catch {
      try {
        const compactSaved = savedItems.map((it) => ({
          ...it,
          overview: typeof it.overview === 'string' ? it.overview.slice(0, 120) : '',
        }));
        localStorage.setItem(listStorageKey(activeProfileId), JSON.stringify(compactSaved));
      } catch {
        // >5 MB yedeklerde tarayıcı localStorage kotası aşılabilir; tam veri React state'te ve data/cinetrack-data.json üzerinde korunur.
      }
    }

    if (!hasHydratedLocalEffectRef.current) {
      hasHydratedLocalEffectRef.current = true;
      return;
    }
    if (applyingRemoteSnapshotRef.current) {
      applyingRemoteSnapshotRef.current = false;
      return;
    }
    isDirtyRef.current = true;
    if (serverSyncReady) {
      try {
        localStorage.setItem(DIRTY_KEY, '1');
      } catch {}
    } else {
      localEditedDuringStartupRef.current = true;
    }
  }, [
    profiles,
    activeProfileId,
    profileName,
    savedItems,
    preferences,
    favoriteActors,
    deletedKeys,
    serverSyncReady,
  ]);

  const persistProfilesBestEffort = useCallback((profilesList: Profile[]) => {
    for (const p of profilesList) {
      if (!p || !p.id) continue;
      try {
        localStorage.setItem(preferencesStorageKey(p.id), JSON.stringify(p.preferences || {}));
        localStorage.setItem(favActorsStorageKey(p.id), JSON.stringify(p.favoriteActors || []));
        localStorage.setItem(
          deletedKeysStorageKey(p.id),
          JSON.stringify(normalizeDeletedKeys(p.deleted_keys))
        );
      } catch {}
      try {
        localStorage.setItem(listStorageKey(p.id), JSON.stringify(p.items || []));
      } catch {
        try {
          const compactSaved = (p.items || []).map((it) => ({
            ...it,
            overview: typeof it.overview === 'string' ? it.overview.slice(0, 120) : '',
          }));
          localStorage.setItem(listStorageKey(p.id), JSON.stringify(compactSaved));
        } catch {}
      }
      void saveUserListsIdb(p.id, p.items || []);
    }
  }, []);

  const buildCurrentLivePayloadFromRefs = useCallback((): DataDocument => {
    const currentActiveId = activeProfileIdRef.current;
    const currentProfiles = profilesRef.current;
    const currentActiveProf =
      currentProfiles.find((p) => p.id === currentActiveId) || currentProfiles[0];
    return {
      version: 3,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      engineVersion: ENGINE_VERSION,
      activeProfileId: currentActiveId,
      profiles: currentProfiles.map((p) => {
        const isCurrent = p.id === currentActiveId;
        const profDeletedKeys = isCurrent
          ? normalizeDeletedKeys(deletedKeysRef.current)
          : normalizeDeletedKeys(
              p.deleted_keys && Object.keys(p.deleted_keys).length > 0
                ? p.deleted_keys
                : loadDeletedKeys(p.id)
            );
        const profItems = isCurrent
          ? savedItemsRef.current
          : Array.isArray(p.items) && p.items.length > 0
          ? p.items
          : loadProfileItems(p.id);
        const profPrefs = isCurrent
          ? preferencesRef.current
          : p.preferences &&
            ((p.preferences.disliked?.length || 0) > 0 ||
              (p.preferences.hidden?.length || 0) > 0 ||
              (p.preferences.providers?.length || 0) > 0 ||
              Boolean(p.preferences.mood) ||
              Boolean(p.preferences.reminders))
          ? normalizePreferences(p.preferences, { knownMoods: Object.keys(MOOD_GENRES) })
          : loadProfilePreferences(p.id);
        const profFavActors = isCurrent
          ? favoriteActorsRef.current || []
          : Array.isArray(p.favoriteActors) && p.favoriteActors.length > 0
          ? p.favoriteActors
          : loadFavoriteActors(p.id);

        return {
          id: p.id,
          name: isCurrent ? profileNameRef.current : p.name,
          createdAt: p.createdAt || '',
          preferences: profPrefs,
          items: profItems,
          favoriteActors: profFavActors,
          isDemo: isCurrent ? Boolean(currentActiveProf?.isDemo) : Boolean(p.isDemo),
          ...(Object.keys(profDeletedKeys).length > 0 ? { deleted_keys: profDeletedKeys } : {}),
        };
      }),
    };
  }, []);

  const buildCurrentPayload = useCallback((): DataDocument => {
    return {
      version: 3,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      engineVersion: ENGINE_VERSION,
      activeProfileId,
      profiles: profiles.map((p) => {
        const isCurrent = p.id === activeProfileId;
        const profDeletedKeys = isCurrent
          ? normalizeDeletedKeys(deletedKeysRef.current)
          : normalizeDeletedKeys(
              p.deleted_keys && Object.keys(p.deleted_keys).length > 0
                ? p.deleted_keys
                : loadDeletedKeys(p.id)
            );
        const profItems = isCurrent
          ? savedItems
          : Array.isArray(p.items) && p.items.length > 0
          ? p.items
          : loadProfileItems(p.id);
        const profPrefs = isCurrent
          ? preferences
          : p.preferences &&
            ((p.preferences.disliked?.length || 0) > 0 ||
              (p.preferences.hidden?.length || 0) > 0 ||
              (p.preferences.providers?.length || 0) > 0 ||
              Boolean(p.preferences.mood) ||
              Boolean(p.preferences.reminders))
          ? normalizePreferences(p.preferences, { knownMoods: Object.keys(MOOD_GENRES) })
          : loadProfilePreferences(p.id);
        const profFavActors = isCurrent
          ? favoriteActorsRef.current || []
          : Array.isArray(p.favoriteActors) && p.favoriteActors.length > 0
          ? p.favoriteActors
          : loadFavoriteActors(p.id);

        return {
          id: p.id,
          name: isCurrent ? profileName : p.name,
          createdAt: p.createdAt || '',
          preferences: profPrefs,
          items: profItems,
          favoriteActors: profFavActors,
          isDemo: isCurrent ? Boolean(activeProfile?.isDemo) : Boolean(p.isDemo),
          ...(Object.keys(profDeletedKeys).length > 0 ? { deleted_keys: profDeletedKeys } : {}),
        };
      }),
    };
  }, [profiles, activeProfileId, profileName, preferences, savedItems, activeProfile?.isDemo]);

  const handleServerConflict = useCallback((conflict: ServerConflictDetail) => {
    setServerConflict(conflict);
    setSyncStatus(`Çakışma algılandı: ${conflict.message}`);
  }, []);

  const mergeRemoteDocumentIntoState = useCallback(
    (
      rawRemoteDoc: DataDocument,
      options: {
        preferActiveFrom?: 'local' | 'remote';
        foldUnhydrated?: boolean;
        keepDirtyIfLocalAhead?: boolean;
      } = {}
    ): DataDocument | null => {
      const remoteDoc = normalizeDataDocument(rawRemoteDoc);
      if (!remoteDoc) return null;

      const liveLocalDoc = buildCurrentLivePayloadFromRefs();
      const { mergedDoc } = reconcileUserDataDocumentsLossless(liveLocalDoc, remoteDoc, {
        foldUnhydratedDefaultProfile: Boolean(options.foldUnhydrated),
        preferActiveProfileFrom: options.preferActiveFrom || 'local',
      });

      const active =
        mergedDoc.profiles.find((p) => p.id === mergedDoc.activeProfileId) ||
        mergedDoc.profiles[0];
      const activeFavs = normalizeFavoriteActors(active.favoriteActors || []);
      const activeDeleted = normalizeDeletedKeys(active.deleted_keys);

      applyingRemoteSnapshotRef.current = true;
      hadStoredProfilesOnBootRef.current = true;

      profilesRef.current = mergedDoc.profiles;
      activeProfileIdRef.current = mergedDoc.activeProfileId;
      profileNameRef.current = active.name;
      preferencesRef.current = active.preferences;
      savedItemsRef.current = active.items;
      favoriteActorsRef.current = activeFavs;
      deletedKeysRef.current = activeDeleted;

      setProfiles(mergedDoc.profiles);
      setActiveProfileId(mergedDoc.activeProfileId);
      setProfileName(active.name);
      setPreferences(active.preferences);
      setSavedItems(active.items);
      setFavoriteActors(activeFavs);
      setDeletedKeys(activeDeleted);

      const loadedMap = loadPersistentTasteMap(active.id);
      tasteMapRef.current = loadedMap;
      setTasteMap(loadedMap);

      persistProfilesBestEffort(mergedDoc.profiles);

      const localHasUnpushedAdditions = !areUserDataDocumentsSemanticallyEqual(
        mergedDoc,
        remoteDoc
      );
      const shouldStayDirty =
        options.keepDirtyIfLocalAhead !== false && localHasUnpushedAdditions;

      isDirtyRef.current = shouldStayDirty;
      try {
        if (shouldStayDirty) {
          localStorage.setItem(DIRTY_KEY, '1');
        } else {
          localStorage.removeItem(DIRTY_KEY);
        }
      } catch {}

      if (!shouldStayDirty) {
        setServerConflict(null);
      }

      return mergedDoc;
    },
    [buildCurrentLivePayloadFromRefs, persistProfilesBestEffort]
  );

  const handleMergedServerDocument = useCallback(
    (serverDoc: DataDocument) => {
      mergeRemoteDocumentIntoState(serverDoc, {
        preferActiveFrom: 'local',
        keepDirtyIfLocalAhead: true,
      });
    },
    [mergeRemoteDocumentIntoState]
  );

  const {
    isOnline,
    pendingSync,
    unpersistedWarning,
    syncDocument,
    resolveQueuedConflict,
  } = useOfflineSync(handleServerConflict, handleMergedServerDocument);

  // Autonomous 500-movie + 500-TV IndexedDB stock engine & <250 background replenisher (Aşama 2 & 4)
  const stockEngineState = useStockEngine(activeProfileId);

  // Separate persistent Sinema Künyesi store (genre / year / cast keyed by contentId = title + year)
  const {
    cinemaKunye,
    mergeIncomingCinemaKunye,
    replaceCinemaKunye,
    flushCinemaKunyeToServer,
    refreshCinemaKunyeFromServer,
  } = useCinemaKunye({
    savedItems,
    genresMap,
    isDemo: Boolean(activeProfile?.isDemo),
    tmdbSource: tmdbSourceMeta.source,
  });

  // Hydrate discovery-history & candidate-pool from IndexedDB on startup/profile switch (BUG-02)
  useEffect(() => {
    let active = true;
    void Promise.all([
      hydrateDiscoveryHistoryIdb(activeProfileId),
      hydrateCandidatePoolsIdb(activeProfileId),
    ]).then(([hydratedMap]) => {
      if (!active || !hydratedMap) return;
      if ((hydratedMap.updatedAt || '') > (tasteMapRef.current?.updatedAt || '')) {
        tasteMapRef.current = hydratedMap;
        setTasteMap(hydratedMap);
      }
    });
    return () => {
      active = false;
    };
  }, [activeProfileId]);

  // Subscribe to ct:series-index changes & enforce 200 MiB poster LRU quota (EXT-03 & FEAT-01)
  useEffect(() => {
    const unsubSeries = subscribeSeriesIndex(() => {
      setSeriesIndexVersion((v) => v + 1);
    });
    void enforcePosterCacheQuota();
    void maintainEncodingsDepot();
    requestServiceWorkerPosterPurge();
    const quotaInterval = setInterval(() => {
      void enforcePosterCacheQuota();
      void maintainEncodingsDepot();
      requestServiceWorkerPosterPurge();
    }, 5 * 60 * 1000);
    return () => {
      unsubSeries();
      clearInterval(quotaInterval);
    };
  }, []);

  // Register local series hints with 0 network calls on startup/save; network backfill runs lazily ONLY when "Seriler" opens (FEAT-01 #6)
  useEffect(() => {
    if (savedItems.length > 0) {
      void registerLocalSavedSeriesHints(savedItems);
    }
  }, [savedItems]);

  const applyDataDocumentToState = useCallback(
    (rawDoc: DataDocument) => {
      const doc = normalizeDataDocument(rawDoc);
      if (!doc) return;
      applyingRemoteSnapshotRef.current = true;
      hadStoredProfilesOnBootRef.current = true;
      profilesRef.current = doc.profiles;
      setProfiles(doc.profiles);
      setActiveProfileId(doc.activeProfileId);
      activeProfileIdRef.current = doc.activeProfileId;
      const active = doc.profiles.find((p) => p.id === doc.activeProfileId) || doc.profiles[0];
      profileNameRef.current = active.name;
      setProfileName(active.name);
      preferencesRef.current = active.preferences;
      setPreferences(active.preferences);
      savedItemsRef.current = active.items;
      setSavedItems(active.items);
      const activeFavs = normalizeFavoriteActors(active.favoriteActors || []);
      favoriteActorsRef.current = activeFavs;
      setFavoriteActors(activeFavs);
      const activeDeleted = normalizeDeletedKeys(active.deleted_keys);
      deletedKeysRef.current = activeDeleted;
      setDeletedKeys(activeDeleted);
      const loadedMap = loadPersistentTasteMap(active.id);
      tasteMapRef.current = loadedMap;
      setTasteMap(loadedMap);
      persistProfilesBestEffort(doc.profiles);
      isDirtyRef.current = false;
      try {
        localStorage.removeItem(DIRTY_KEY);
      } catch {}
      resolveQueuedConflict();
      setServerConflict(null);
    },
    [persistProfilesBestEffort, resolveQueuedConflict]
  );

  // Push server data on changes (with lossless merge foundation & offline queue)
  const executePushToServer = useCallback(async () => {
    const payload = buildCurrentLivePayloadFromRefs();
    const confirmBulkDelete = confirmNextBulkSyncRef.current;
    const foldUnhydrated = !hadStoredProfilesOnBootRef.current;
    isPushingRef.current = true;
    try {
      const res = await syncDocument(
        payload,
        confirmBulkDelete
          ? { confirmBulkDelete: true }
          : { foldUnhydratedDefaultProfile: foldUnhydrated }
      );
      if (res.ok) {
        confirmNextBulkSyncRef.current = false;
        hadStoredProfilesOnBootRef.current = true;
        const authoritativeServerDoc = res.document || payload;
        const liveNow = buildCurrentLivePayloadFromRefs();
        if (areUserDataDocumentsSemanticallyEqual(liveNow, authoritativeServerDoc)) {
          isDirtyRef.current = false;
          try {
            localStorage.removeItem(DIRTY_KEY);
          } catch {}
        }
        setServerConflict(null);
        setSyncStatus('Kayıt yeri: data/cinetrack-data.json (bu bilgisayarda, tüm profiller).');
      } else if (res.queued) {
        setSyncStatus('Çevrimdışı kuyrukta: bağlantı sağlandığında yerel sunucuya aktarılacak.');
      } else if (!res.conflict) {
        setSyncStatus('Değişiklikler yerel veri dosyasına yazılamadı; şimdilik yalnızca bu tarayıcıda.');
      }
    } finally {
      isPushingRef.current = false;
    }
  }, [buildCurrentLivePayloadFromRefs, syncDocument]);

  const pushToServer = useCallback(async () => {
    if (inFlightPushRef.current) {
      await inFlightPushRef.current;
      if (!isDirtyRef.current && !confirmNextBulkSyncRef.current && !hasPendingOfflineSync()) {
        return;
      }
    }
    const promise = executePushToServer().finally(() => {
      if (inFlightPushRef.current === promise) {
        inFlightPushRef.current = null;
      }
    });
    inFlightPushRef.current = promise;
    await promise;
  }, [executePushToServer]);

  const handleKeepLocalOnConflict = useCallback(async () => {
    const payload = serverConflict?.localPayload || buildCurrentLivePayloadFromRefs();
    const res = await syncDocument(payload, { forceOverwrite: true, confirmBulkDelete: true });
    if (res.ok) {
      isDirtyRef.current = false;
      try {
        localStorage.removeItem(DIRTY_KEY);
      } catch {}
      resolveQueuedConflict();
      setServerConflict(null);
      setSyncStatus('Yerel değişiklikler sunucuya kaydedildi.');
      showToast('Yerel verileriniz sunucuya kaydedildi.');
    }
  }, [serverConflict, buildCurrentLivePayloadFromRefs, syncDocument, resolveQueuedConflict, showToast]);

  const handleMergeBothOnConflict = useCallback(async () => {
    if (serverConflict?.serverDocument) {
      mergeRemoteDocumentIntoState(serverConflict.serverDocument, {
        preferActiveFrom: 'local',
        keepDirtyIfLocalAhead: true,
      });
    }
    await pushToServer();
    resolveQueuedConflict();
    setServerConflict(null);
    setSyncStatus('Yerel ve sunucu verileri kayıpsız birleştirildi.');
    showToast('Yerel ve sunucu listeleriniz kayıpsız birleştirildi.');
  }, [serverConflict, mergeRemoteDocumentIntoState, pushToServer, resolveQueuedConflict, showToast]);

  const handleUseServerOnConflict = useCallback(() => {
    if (serverConflict?.serverDocument) {
      applyDataDocumentToState(serverConflict.serverDocument);
      showToast('Sunucudaki güncel veri yüklendi.');
    }
  }, [serverConflict, applyDataDocumentToState, showToast]);

  const handleMergeSyncedDocument = useCallback(
    (doc: DataDocument) => {
      mergeRemoteDocumentIntoState(doc, {
        preferActiveFrom: 'local',
        keepDirtyIfLocalAhead: true,
      });
    },
    [mergeRemoteDocumentIntoState]
  );

  // Debounced auto-push when user edits state (buildCurrentPayload tracks state dependencies)
  useEffect(() => {
    if (!serverSyncReady) return;
    let lsDirty = false;
    try {
      lsDirty = localStorage.getItem(DIRTY_KEY) === '1';
    } catch {}
    if (!isDirtyRef.current && !lsDirty && !confirmNextBulkSyncRef.current && !hasPendingOfflineSync()) {
      return;
    }
    const timer = setTimeout(() => {
      void pushToServer();
    }, 500);
    return () => clearTimeout(timer);
  }, [buildCurrentPayload, pushToServer, serverSyncReady, favoriteActors, deletedKeys]);

  // Arka plandaki GitHub otomatik senkronizasyonu (server.ts) revizyonu ilerlettiğinde
  // veya bekleyen yerel değişiklik varsa kayıpsız eşitleme yap
  const pullMergeFromServerIfAdvanced = useCallback(async () => {
    if (isPushingRef.current || !navigator.onLine) return;
    const prevRev = getLastKnownServerRevision();
    const remote = await fetchServerData();
    if (!remote) return;
    if (
      typeof remote.revision === 'number' &&
      (prevRev === null || remote.revision > prevRev)
    ) {
      mergeRemoteDocumentIntoState(remote, {
        preferActiveFrom: 'local',
        keepDirtyIfLocalAhead: true,
      });
      void refreshCinemaKunyeFromServer('merge');
    }
  }, [mergeRemoteDocumentIntoState, refreshCinemaKunyeFromServer]);

  useEffect(() => {
    if (!serverSyncReady) return;
    // Başlangıçtaki 1.5s sunucu-GitHub otomatik senkronunu yakalamak için erken kontrol
    const initialFollowUp = setTimeout(() => {
      void pullMergeFromServerIfAdvanced();
    }, 5000);

    const interval = setInterval(() => {
      let lsDirty = false;
      try {
        lsDirty = localStorage.getItem(DIRTY_KEY) === '1';
      } catch {}
      if (isDirtyRef.current || lsDirty || hasPendingOfflineSync()) {
        void pushToServer();
      } else {
        void pullMergeFromServerIfAdvanced();
      }
    }, 60 * 1000);

    const handleVisibilitySync = () => {
      if (document.visibilityState === 'visible') {
        void pullMergeFromServerIfAdvanced();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilitySync);

    return () => {
      clearTimeout(initialFollowUp);
      clearInterval(interval);
      document.removeEventListener('visibilitychange', handleVisibilitySync);
    };
  }, [pushToServer, pullMergeFromServerIfAdvanced, serverSyncReady]);

  // Initial startup sync with server (always lossless-merged, even if local was dirty or edited during boot!)
  useEffect(() => {
    fetchServerData()
      .then(async (remote) => {
        if (remote) {
          const doc = normalizeDataDocument(remote);
          if (doc) {
            const remoteHasData =
              doc.profiles.some(
                (p) =>
                  p.items.length > 0 ||
                  (p.preferences?.disliked?.length || 0) > 0 ||
                  (p.preferences?.hidden?.length || 0) > 0 ||
                  (p.favoriteActors?.length || 0) > 0
              ) ||
              doc.profiles.length > 1 ||
              (doc.revision ?? 0) > 0;
            const isDirty = Boolean(
              localWasDirtyRef.current || localEditedDuringStartupRef.current || isDirtyRef.current
            );
            if (remoteHasData) {
              const merged = mergeRemoteDocumentIntoState(doc, {
                preferActiveFrom: isDirty ? 'local' : 'remote',
                foldUnhydrated: !hadStoredProfilesOnBootRef.current,
                keepDirtyIfLocalAhead: true,
              });
              if (merged && !areUserDataDocumentsSemanticallyEqual(merged, doc)) {
                resolveQueuedConflict();
              } else {
                resolveQueuedConflict();
              }
            }
          }
          return;
        }

        // Sunucuya ulaşılamadıysa ve localStorage kotadan dolayı boş kaldıysa IndexedDB yedeğinden kurtar
        if (savedItemsRef.current.length === 0) {
          const idbCompact = await loadUserListsIdb(activeProfileIdRef.current);
          if (idbCompact.length > 0 && savedItemsRef.current.length === 0) {
            const recovered = idbCompact
              .map((it) =>
                normalizeSavedItem({
                  ...it,
                  title: `${it.media_type === 'tv' ? 'Dizi' : 'Film'} #${it.id}`,
                })
              )
              .filter(Boolean) as SavedItem[];
            if (recovered.length > 0) {
              applyingRemoteSnapshotRef.current = true;
              savedItemsRef.current = recovered;
              setSavedItems(recovered);
            }
          }
        }
      })
      .catch((error) => console.error('Cinethos: başlangıç verisi eşitlenemedi.', error))
      .finally(() => setServerSyncReady(true));

    // Load genres
    Promise.all([fetchTmdb('/genre/movie/list'), fetchTmdb('/genre/tv/list')])
      .then(([movies, series]) => {
        const map: Record<number, string> = {};
        for (const g of [...(movies.genres || []), ...(series.genres || [])]) {
          map[g.id] = g.name;
        }
        setGenresMap(map);
      })
      .catch((err) => console.warn('Genres fetch error:', err));

    const unsubSource = subscribeTmdbSource(setTmdbSourceMeta);
    checkServerTmdbStatus();

    return () => {
      unsubSource();
    };
  }, [mergeRemoteDocumentIntoState, resolveQueuedConflict]);

  // Release Reminders check (ref-backed with single batched state update — BUG-13.3)
  const checkReleaseReminders = useCallback(() => {
    const currentPrefs = preferencesRef.current;
    const currentItems = savedItemsRef.current;
    if (!currentPrefs.reminders || !('Notification' in window) || Notification.permission !== 'granted') {
      return;
    }
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const newlyNotified: string[] = [];

    for (const item of currentItems) {
      if (item.status === 'completed') continue;
      const airDate = resolveAirDate(item);
      if (!airDate) continue;
      const days = reminderDaysUntil(airDate, today);
      if (days === null) continue;
      const key = `${item.media_type}:${item.id}:${airDate}`;
      if (currentPrefs.notified.includes(key) || newlyNotified.includes(key)) continue;

      const next = item.next_episode_to_air;
      const episodeTag =
        item.media_type === 'tv' && next?.air_date === airDate && next.season_number
          ? ` (S${next.season_number}B${next.episode_number})`
          : '';
      const when = days === 0 ? 'bugün' : `${days} gün içinde`;

      const notification = new Notification('Cinethos yayın hatırlatıcısı', {
        body: `${displayTitle(item)} ${when} yayınlanıyor${episodeTag}.`,
      });
      notification.onclick = () => {
        window.focus();
        setDetailItem(item);
        notification.close();
      };

      newlyNotified.push(key);
    }

    if (newlyNotified.length > 0) {
      setPreferences((prev) => ({
        ...prev,
        notified: [...prev.notified, ...newlyNotified].slice(-200),
      }));
    }
  }, []);

  useEffect(() => {
    checkReleaseReminders();
    const interval = setInterval(checkReleaseReminders, 60_000);
    const handleVis = () => {
      if (document.visibilityState === 'visible') checkReleaseReminders();
    };
    document.addEventListener('visibilitychange', handleVis);
    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', handleVis);
    };
  }, [checkReleaseReminders]);

  const enrichItemsWithPersonalizedTaste = (items: any[]): any[] => {
    if (!items || items.length === 0) return items;
    try {
      const currentProfileId = activeProfileIdRef.current;
      const currentTasteMap = tasteMapRef.current || loadPersistentTasteMap(currentProfileId);
      return enrichCatalogItemsWithTaste({
        items,
        savedItems: savedItemsRef.current,
        preferences: preferencesRef.current,
        genresMap: genresMapRef.current,
        tasteMap: currentTasteMap,
      });
    } catch {
      return items;
    }
  };

  function mergeDiscoverResults(cat: string, movies: any[], tvs: any[]): any[] {
    const mList = (movies || []).map((m: any) => ({ ...m, media_type: 'movie' }));
    const tList = (tvs || []).map((t: any) => ({ ...t, media_type: 'tv' }));

    if (mList.length === 0) return tList;
    if (tList.length === 0) return mList;

    if (cat === 'top-rated') {
      return [...mList, ...tList].sort((a, b) => (Number(b.vote_average) || 0) - (Number(a.vote_average) || 0));
    }
    if (cat === 'upcoming') {
      return [...mList, ...tList].sort((a, b) =>
        compareMediaDatesAscending(
          a.release_date || a.first_air_date,
          b.release_date || b.first_air_date
        )
      );
    }
    if (cat === 'gems') {
      return [...mList, ...tList].sort((a, b) => (Number(b.vote_average) || 0) - (Number(a.vote_average) || 0));
    }
    const merged: any[] = [];
    const maxLen = Math.max(mList.length, tList.length);
    for (let i = 0; i < maxLen; i++) {
      if (i < mList.length) merged.push(mList[i]);
      if (i < tList.length) merged.push(tList[i]);
    }
    return merged;
  }

  // Load Catalog Data (Trending, For-You, Gems, Upcoming, etc.)
  const loadCategoryResults = useCallback(
    async (
      cat: string,
      p = 1,
      append = false,
      currentQuery = query,
      provider = selectedProvider,
      forceRefresh = false,
      typeFilter?: string,
      genreFilter?: string
    ) => {
      const ticket = requestGateRef.current.begin();
      if (!append) {
        setIsLoading(true);
        setCatalogPage(1);
      } else {
        setLoadingMore(true);
      }

      const activeGenre = genreFilter !== undefined ? genreFilter : selectedGenreRef.current;
      const effectiveType = typeFilter || selectedTypeRef.current || 'all';
      const targetType = effectiveType === 'movie' || effectiveType === 'tv' ? effectiveType : 'all';

      try {
        if (currentQuery.trim()) {
          const res = await fetchTmdb(
            '/search/multi',
            { query: currentQuery.trim(), page: String(p) },
            ticket.signal
          );
          if (!requestGateRef.current.isCurrent(ticket.id)) return;
          const items = (res.results || []).filter(
            (item: any) => item.media_type === 'movie' || item.media_type === 'tv'
          );
          const enriched = enrichItemsWithPersonalizedTaste(items);
          setCatalogItems((prev) => (append ? [...prev, ...enriched] : enriched));
          setCatalogTotalPages(res.total_pages || 1);
          setCatalogPage(p);
          return;
        }

        const fetchDiscoverPageByCategory = async (pageNum: number): Promise<{ rawItems: any[]; totalPages: number }> => {
          if (cat === 'stock') {
            const stock = await loadStockIdb();
            const stockMovies = (stock.movies || [])
              .map((m: any) => ({ ...m, media_type: 'movie' }))
              .filter((m: any) =>
                isCandidateEligibleForStock(m, savedItemsRef.current, preferencesRef.current)
              );
            const stockSeries = (stock.tv || [])
              .map((t: any) => ({ ...t, media_type: 'tv' }))
              .filter((t: any) =>
                isCandidateEligibleForStock(t, savedItemsRef.current, preferencesRef.current)
              );

            setStockStats({
              movieCount: stockMovies.length,
              tvCount: stockSeries.length,
            });

            console.info('[Cinethos Stock] loadStockIdb (arındırılmış):', {
              movies: stockMovies.length,
              tv: stockSeries.length,
              updatedAt: stock.updatedAt || null,
            });
            if (stockMovies.length === 0 && stockSeries.length === 0) {
              void executeStockReplenishment(activeProfileIdRef.current, {
                userListItems: savedItemsRef.current,
                preferences: preferencesRef.current,
              });
            } else if (
              stockMovies.length !== (stock.movies || []).length ||
              stockSeries.length !== (stock.tv || []).length
            ) {
              void syncStockWithUserExclusions(
                activeProfileIdRef.current,
                savedItemsRef.current,
                preferencesRef.current
              );
            }

            let filtered: any[] = [];
            if (targetType === 'movie') {
              filtered = stockMovies;
            } else if (targetType === 'tv') {
              filtered = stockSeries;
            } else {
              filtered = mergeDiscoverResults(cat, stockMovies, stockSeries);
            }

            filtered = filtered.filter((it) => {
              const d = it.release_date || it.first_air_date || '';
              return d ? isWithinReleaseWindow(d) : true;
            });

            if (hideListedItemsRef.current) {
              filtered = filterHiddenUserRegisteredItems(filtered, {
                savedItems: savedItemsRef.current,
                preferences: preferencesRef.current,
                tasteMap: tasteMapRef.current,
                hideListedItems: true,
              });
            }

            if (activeGenre) {
              const targetGenreId = Number(activeGenre);
              if (Number.isFinite(targetGenreId)) {
                filtered = filtered.filter((it) =>
                  Array.isArray(it.genre_ids) && it.genre_ids.includes(targetGenreId)
                );
              }
            }

            const activeSort = selectedSortRef.current;
            if (activeSort === 'similarity') {
              const savedEncodings = savedItemsRef.current.map((it) => ({
                encoding: getItemEncodingSync(it),
                personal_rating: it.personal_rating,
              }));
              const profileCentroid = computeProfileCentroid(savedEncodings);
              if (profileCentroid.length > 0) {
                const simMap = new Map<string, number>();
                for (const it of filtered) {
                  const enc = getItemEncodingSync(it);
                  const sim = cosineSimilarity(profileCentroid, enc.denseVector);
                  simMap.set(`${it.media_type}:${it.id}`, sim);
                }
                filtered.sort((a, b) => (simMap.get(`${b.media_type}:${b.id}`) ?? 0) - (simMap.get(`${a.media_type}:${a.id}`) ?? 0));
              } else {
                filtered.sort((a, b) => (Number(b.popularity) || 0) - (Number(a.popularity) || 0));
              }
            } else if (activeSort === 'rating' || activeSort === 'rating.desc' || activeSort === 'vote_average.desc') {
              filtered.sort((a, b) => (Number(b.vote_average) || 0) - (Number(a.vote_average) || 0));
            } else if (activeSort === 'recent' || activeSort === 'date.desc' || activeSort === 'primary_release_date.desc') {
              filtered.sort((a, b) =>
                compareMediaDatesDescending(
                  a.release_date || a.first_air_date,
                  b.release_date || b.first_air_date
                )
              );
            } else if (activeSort === 'title') {
              filtered.sort((a, b) => displayTitle(a).localeCompare(displayTitle(b), 'tr'));
            } else {
              filtered.sort((a, b) => (Number(b.popularity) || 0) - (Number(a.popularity) || 0));
            }

            const PAGE_SIZE = 24;
            const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
            const startIdx = (pageNum - 1) * PAGE_SIZE;
            const pageSlice = filtered.slice(startIdx, startIdx + PAGE_SIZE);

            return {
              rawItems: pageSlice,
              totalPages,
            };
          }

          const movieGenreParam = resolveDiscoverGenreParam(activeGenre, 'movie');
          const tvGenreParam = resolveDiscoverGenreParam(activeGenre, 'tv');

          if (provider && cat !== 'for-you') {
            const baseParams = {
              with_watch_providers: provider,
              watch_region: 'TR',
              sort_by: 'popularity.desc',
              page: String(pageNum),
            };
            let moviesPromise = Promise.resolve({ results: [], total_pages: 1 });
            let tvsPromise = Promise.resolve({ results: [], total_pages: 1 });
            if (targetType === 'all' || targetType === 'movie') {
              moviesPromise = fetchTmdb(
                '/discover/movie',
                movieGenreParam ? { ...baseParams, with_genres: movieGenreParam } : baseParams,
                ticket.signal
              );
            }
            if (targetType === 'all' || targetType === 'tv') {
              tvsPromise = fetchTmdb(
                '/discover/tv',
                tvGenreParam ? { ...baseParams, with_genres: tvGenreParam } : baseParams,
                ticket.signal
              );
            }
            const [movies, tvs] = await Promise.all([moviesPromise, tvsPromise]);
            return {
              rawItems: mergeDiscoverResults(cat, movies.results || [], tvs.results || []),
              totalPages: Math.max(movies.total_pages || 1, tvs.total_pages || 1),
            };
          }

          if (cat === 'gems') {
            const cutoffDate = dateYearsAgo(15);
            const common: Record<string, string> = {
              'vote_average.gte': '7',
              'vote_count.gte': '200',
              'vote_count.lte': '3000',
              sort_by: 'popularity.asc',
              page: String(pageNum),
            };
            let moviesPromise = Promise.resolve({ results: [], total_pages: 1 });
            let tvsPromise = Promise.resolve({ results: [], total_pages: 1 });
            if (targetType === 'all' || targetType === 'movie') {
              moviesPromise = fetchTmdb(
                '/discover/movie',
                {
                  ...common,
                  'primary_release_date.gte': cutoffDate,
                  ...(movieGenreParam ? { with_genres: movieGenreParam } : {}),
                },
                ticket.signal
              );
            }
            if (targetType === 'all' || targetType === 'tv') {
              tvsPromise = fetchTmdb(
                '/discover/tv',
                {
                  ...common,
                  'first_air_date.gte': cutoffDate,
                  ...(tvGenreParam ? { with_genres: tvGenreParam } : {}),
                },
                ticket.signal
              );
            }
            const [movies, tvs] = await Promise.all([moviesPromise, tvsPromise]);
            return {
              rawItems: mergeDiscoverResults(cat, movies.results || [], tvs.results || []),
              totalPages: Math.max(movies.total_pages || 1, tvs.total_pages || 1),
            };
          }

          if (cat === 'upcoming') {
            const todayIso = new Date().toISOString().slice(0, 10);
            let moviesPromise = Promise.resolve({ results: [], total_pages: 1 });
            let tvsPromise = Promise.resolve({ results: [], total_pages: 1 });
            if (targetType === 'all' || targetType === 'movie') {
              moviesPromise = movieGenreParam
                ? fetchTmdb(
                    '/discover/movie',
                    {
                      'primary_release_date.gte': todayIso,
                      with_genres: movieGenreParam,
                      sort_by: 'popularity.desc',
                      page: String(pageNum),
                    },
                    ticket.signal
                  )
                : fetchTmdb('/movie/upcoming', { page: String(pageNum) }, ticket.signal);
            }
            if (targetType === 'all' || targetType === 'tv') {
              tvsPromise = tvGenreParam
                ? fetchTmdb(
                    '/discover/tv',
                    {
                      'first_air_date.gte': todayIso,
                      with_genres: tvGenreParam,
                      sort_by: 'popularity.desc',
                      page: String(pageNum),
                    },
                    ticket.signal
                  )
                : fetchTmdb('/tv/on_the_air', { page: String(pageNum) }, ticket.signal);
            }
            const [movies, tvs] = await Promise.all([moviesPromise, tvsPromise]);
            const mergedUpcoming = mergeDiscoverResults(
              cat,
              movies.results || [],
              tvs.results || []
            ).filter((it) => {
              const d = it.release_date || it.first_air_date || '';
              return d ? isWithinReleaseWindow(d) : false;
            });
            return {
              rawItems: mergedUpcoming,
              totalPages: Math.max(movies.total_pages || 1, tvs.total_pages || 1),
            };
          }

          if (activeGenre) {
            let moviesPromise = Promise.resolve({ results: [], total_pages: 1 });
            let tvsPromise = Promise.resolve({ results: [], total_pages: 1 });

            if (cat === 'top-rated') {
              if (targetType === 'all' || targetType === 'movie') {
                moviesPromise = fetchTmdb(
                  '/discover/movie',
                  {
                    ...(movieGenreParam ? { with_genres: movieGenreParam } : {}),
                    sort_by: 'vote_average.desc',
                    'vote_count.gte': '200',
                    page: String(pageNum),
                  },
                  ticket.signal
                );
              }
              if (targetType === 'all' || targetType === 'tv') {
                tvsPromise = fetchTmdb(
                  '/discover/tv',
                  {
                    ...(tvGenreParam ? { with_genres: tvGenreParam } : {}),
                    sort_by: 'vote_average.desc',
                    'vote_count.gte': '150',
                    page: String(pageNum),
                  },
                  ticket.signal
                );
              }
            } else if (cat === 'popular-movies') {
              moviesPromise = fetchTmdb(
                '/discover/movie',
                {
                  ...(movieGenreParam ? { with_genres: movieGenreParam } : {}),
                  sort_by: 'popularity.desc',
                  page: String(pageNum),
                },
                ticket.signal
              );
            } else if (cat === 'popular-tv') {
              tvsPromise = fetchTmdb(
                '/discover/tv',
                {
                  ...(tvGenreParam ? { with_genres: tvGenreParam } : {}),
                  sort_by: 'popularity.desc',
                  page: String(pageNum),
                },
                ticket.signal
              );
            } else {
              if (targetType === 'all' || targetType === 'movie') {
                moviesPromise = fetchTmdb(
                  '/discover/movie',
                  {
                    ...(movieGenreParam ? { with_genres: movieGenreParam } : {}),
                    sort_by: 'popularity.desc',
                    page: String(pageNum),
                  },
                  ticket.signal
                );
              }
              if (targetType === 'all' || targetType === 'tv') {
                tvsPromise = fetchTmdb(
                  '/discover/tv',
                  {
                    ...(tvGenreParam ? { with_genres: tvGenreParam } : {}),
                    sort_by: 'popularity.desc',
                    page: String(pageNum),
                  },
                  ticket.signal
                );
              }
            }

            const [mRes, tRes] = await Promise.all([moviesPromise, tvsPromise]);
            return {
              rawItems: mergeDiscoverResults(cat, mRes.results || [], tRes.results || []),
              totalPages: Math.max(mRes.total_pages || 1, tRes.total_pages || 1),
            };
          }

          if (cat === 'popular-movies') {
            const res = await fetchTmdb('/movie/popular', { page: String(pageNum) }, ticket.signal);
            return {
              rawItems: (res.results || []).map((m: any) => ({ ...m, media_type: 'movie' })),
              totalPages: res.total_pages || 1,
            };
          }
          if (cat === 'popular-tv') {
            const res = await fetchTmdb('/tv/popular', { page: String(pageNum) }, ticket.signal);
            return {
              rawItems: (res.results || []).map((t: any) => ({ ...t, media_type: 'tv' })),
              totalPages: res.total_pages || 1,
            };
          }
          if (cat === 'top-rated') {
            if (targetType === 'tv') {
              const res = await fetchTmdb('/tv/top_rated', { page: String(pageNum) }, ticket.signal);
              return {
                rawItems: (res.results || []).map((t: any) => ({ ...t, media_type: 'tv' })),
                totalPages: res.total_pages || 1,
              };
            }
            if (targetType === 'movie') {
              const res = await fetchTmdb('/movie/top_rated', { page: String(pageNum) }, ticket.signal);
              return {
                rawItems: (res.results || []).map((m: any) => ({ ...m, media_type: 'movie' })),
                totalPages: res.total_pages || 1,
              };
            }
            const [mRes, tRes] = await Promise.all([
              fetchTmdb('/movie/top_rated', { page: String(pageNum) }, ticket.signal),
              fetchTmdb('/tv/top_rated', { page: String(pageNum) }, ticket.signal),
            ]);
            return {
              rawItems: mergeDiscoverResults(cat, mRes.results || [], tRes.results || []),
              totalPages: Math.max(mRes.total_pages || 1, tRes.total_pages || 1),
            };
          }

          const trendEndpoint =
            targetType === 'movie'
              ? '/trending/movie/day'
              : targetType === 'tv'
              ? '/trending/tv/day'
              : '/trending/all/day';
          const res = await fetchTmdb(trendEndpoint, { page: String(pageNum) }, ticket.signal);
          return {
            rawItems: (res.results || []).map((item: any) =>
              item.media_type
                ? item
                : { ...item, media_type: targetType !== 'all' ? targetType : item.title ? 'movie' : 'tv' }
            ),
            totalPages: res.total_pages || 1,
          };
        };

        if (cat === 'for-you') {
          const currentProfileId = activeProfileIdRef.current;
          const rawSaved = savedItemsRef.current;
          const currentPrefs = preferencesRef.current;
          const currentGenres = genresMapRef.current;
          const isFilteredView = Boolean(activeGenre || provider);
          const forYouQueryKey = `${currentProfileId}|${targetType}|${activeGenre || ''}|${provider || ''}`;
          const isFilterTriggeredRun = Boolean(
            !forceRefresh &&
            lastForYouQueryKeyRef.current &&
            lastForYouQueryKeyRef.current !== forYouQueryKey
          );

          const currentSig = computeTasteProfileSignature(rawSaved, currentPrefs, favoriteActorsRef.current, { targetType });
          const diskTasteMap = loadPersistentTasteMap(currentProfileId);
          const inMemTasteMap = tasteMapRef.current;
          let storedTasteMap =
            inMemTasteMap &&
            inMemTasteMap.profileId === currentProfileId &&
            (inMemTasteMap.updatedAt || '') > (diskTasteMap.updatedAt || '')
              ? inMemTasteMap
              : diskTasteMap;

          // Yerel Zevk Haritası henüz soğuksa veya imzası güncellenmişse sunucudaki doğrulanmış türetilmiş profil önbelleğini dene
          let serverCatalogSnapshot: any = null;
          if (
            !forceRefresh &&
            (Object.keys(storedTasteMap.entries || {}).length < 400 ||
              storedTasteMap.profileSignature !== currentSig)
          ) {
            const [remoteDerived, remoteCatalog] = await Promise.all([
              fetchDerivedProfileData(currentProfileId, {
                profileFingerprint: currentSig,
                algorithmVersion: ALGORITHM_VERSION,
              }),
              fetchCatalogItems(),
            ]);
            if (!requestGateRef.current.isCurrent(ticket.id)) return;
            serverCatalogSnapshot = remoteCatalog;

            if (remoteDerived) {
              const catalogLookup: Record<string, any> = {
                ...(remoteCatalog?.movies || {}),
                ...(remoteCatalog?.tv || {}),
              };
              const expectedCatalogHash =
                typeof remoteCatalog?.manifest?.contentHash === 'string'
                  ? remoteCatalog.manifest.contentHash
                  : undefined;

              const hydratedCache = hydrateTasteMapWithDerivedCache({
                tasteMap: storedTasteMap,
                derivedDoc: remoteDerived,
                profileId: currentProfileId,
                profileFingerprint: currentSig,
                algorithmVersion: ALGORITHM_VERSION,
                sourceCatalogHash: expectedCatalogHash,
                savedItems: rawSaved,
                preferences: currentPrefs,
                catalogLookup,
                forceRefresh,
              });

              if (hydratedCache.cacheHit) {
                storedTasteMap = hydratedCache.tasteMap;
                savePersistentTasteMap(currentProfileId, storedTasteMap);
                tasteMapRef.current = storedTasteMap;
              }
            }
          }

          // 500 + 500 havuz Zevk Haritasında zaten işlenmişse (>= 400 kayıt) ve filtre yoksa önbellekten hızlı yükle
          const processedEntriesCount = Object.keys(storedTasteMap.entries || {}).length;
          if (
            !isFilteredView &&
            processedEntriesCount >= 400 &&
            isTasteMapCacheValid({
              tasteMap: storedTasteMap,
              currentSig,
              targetType,
              savedItems: rawSaved,
              preferences: currentPrefs,
              favoriteActors: favoriteActorsRef.current,
              forceRefresh,
            })
          ) {
            const restored = enforceStrictMediaTypePool(
              (storedTasteMap.cachedBalancedItems || []).filter((item: any) =>
                isCandidateEligibleInPool(item.candidate || item, rawSaved, currentPrefs)
              ),
              targetType
            );
            if (restored.length >= TARGET_RECOMMENDATION_COUNT) {
              const impressionSync = recordDisplayedRecommendations(storedTasteMap, restored, {
                targetType,
              });
              const activeMap = impressionSync.tasteMap;
              if (impressionSync.changed) {
                savePersistentTasteMap(currentProfileId, activeMap);
              }
              tasteMapRef.current = activeMap;

              setForYouExplanation(activeMap.lastExplanation || '');
              const { displayItems, reasonsMap } = mapRecommendationBatchToDisplayItems(
                restored,
                activeMap,
                targetType
              );
              setForYouReasons(reasonsMap);
              setForYouItems(displayItems);
              lastForYouQueryKeyRef.current = forYouQueryKey;
              setTasteMap(activeMap);
              setCatalogTotalPages(1);
              setCatalogPage(1);
              setForYouProgressStep('');
              setIsLoading(false);
              return;
            }
          }

          // Aynı profil + tür + kategori + platform sorgusu halihazırda 20 öneriyle yüklüyse ve manuel yenileme istenmediyse koru
          if (
            forYouItemsRef.current.length >= TARGET_RECOMMENDATION_COUNT &&
            !forceRefresh &&
            processedEntriesCount >= 400 &&
            lastForYouQueryKeyRef.current === forYouQueryKey
          ) {
            setIsLoading(false);
            return;
          }

          // Hem film hem dizi zevk profillerini kullanıcının geçmişinden hesapla (500 film + 500 dizi tam işleme için)
          const selectTopSeeds = (list: SavedItem[], watchedCap: number, watchlistCap: number) => {
            const watched = list
              .filter(
                (item) =>
                  item.status === 'completed' ||
                  item.status === 'watching' ||
                  Number(item.personal_rating) >= 7
              )
              .sort(
                (a, b) =>
                  Number(b.personal_rating || (b.status === 'completed' ? 7 : 5)) -
                  Number(a.personal_rating || (a.status === 'completed' ? 7 : 5))
              )
              .slice(0, watchedCap);
            const wlist = list
              .filter(
                (item) =>
                  item.status === 'watchlist' &&
                  (item.personal_rating === '' || Number(item.personal_rating) < 7)
              )
              .slice(0, watchlistCap);
            return [...watched, ...wlist];
          };

          const rawMovieSaved = filterHistoryByType(rawSaved, 'movie');
          const rawTvSaved = filterHistoryByType(rawSaved, 'tv');
          const seeds = [
            ...selectTopSeeds(rawMovieSaved, 8, 2),
            ...selectTopSeeds(rawTvSaved, 8, 2),
          ];

          const allDislikedKeys = filterDislikedByType(currentPrefs.disliked, 'all');
          const dislikedSeeds = allDislikedKeys
            .map((key) => {
              const [mediaType, id] = key.split(':');
              if (!/^\d+$/.test(id) || !['movie', 'tv'].includes(mediaType)) return undefined;
              return dislikedItemsRef.current.find(
                (item) => String(item.id) === id && item.media_type === mediaType
              );
            })
            .filter(Boolean)
            .slice(0, 10)
            .map((item) => ({ ...item, status: 'disliked', isDisliked: true }));

          setForYouProgressStep('Zevk profili ve geçmiş sinyalleri analiz ediliyor…');
          const historyCredits = await mapLimit([...seeds, ...dislikedSeeds], 4, async (seed) => {
            try {
              const details = await fetchTmdbCached(
                `/${seed.media_type}/${seed.id}`,
                { append_to_response: 'credits' },
                ticket.signal
              );
              return {
                ...seed,
                overview: seed.overview || details?.overview || '',
                belongs_to_collection: details?.belongs_to_collection || null,
                production_companies: details?.production_companies || [],
                cast: (details?.credits?.cast || []).slice(0, 8),
                crew: (details?.credits?.crew || []).filter(
                  (m: any) => m.job === 'Director' || m.job === 'Creator'
                ),
              };
            } catch {
              return { ...seed, cast: seed.cast || [], crew: seed.crew || [] };
            }
          });
          if (!requestGateRef.current.isCurrent(ticket.id)) return;

          const creditsByKey = new Map(
            historyCredits.map((entry) => [makeMediaKey(entry), entry])
          );

          const generalTasteProfile = buildTasteProfileV3(
            [
              ...rawSaved.map((item) => creditsByKey.get(makeMediaKey(item)) || item),
              ...dislikedSeeds.map((item) => creditsByKey.get(makeMediaKey(item)) || item),
            ],
            {
              lambda: 1,
              dislikedKeys: allDislikedKeys,
            }
          );

          const movieDislikedSeeds = dislikedSeeds.filter((it) => it.media_type === 'movie');
          const tvDislikedSeeds = dislikedSeeds.filter((it) => it.media_type === 'tv');

          const movieTasteProfile =
            rawMovieSaved.length > 0
              ? buildTasteProfileV3(
                  [
                    ...rawMovieSaved.map((item) => creditsByKey.get(makeMediaKey(item)) || item),
                    ...movieDislikedSeeds.map((item) => creditsByKey.get(makeMediaKey(item)) || item),
                  ],
                  {
                    lambda: 1,
                    dislikedKeys: filterDislikedByType(currentPrefs.disliked, 'movie'),
                  }
                )
              : generalTasteProfile;

          const tvTasteProfile =
            rawTvSaved.length > 0
              ? buildTasteProfileV3(
                  [
                    ...rawTvSaved.map((item) => creditsByKey.get(makeMediaKey(item)) || item),
                    ...tvDislikedSeeds.map((item) => creditsByKey.get(makeMediaKey(item)) || item),
                  ],
                  {
                    lambda: 1,
                    dislikedKeys: filterDislikedByType(currentPrefs.disliked, 'tv'),
                  }
                )
              : generalTasteProfile;

          // FEAT-02 #5: Önce birincil istemci deposu ct:stock'tan aday havuzlarını besle (sıfır ağ maliyeti)
          await Promise.all([
            seedCandidatePoolFromStock(currentProfileId, 'movie', rawSaved, currentPrefs),
            seedCandidatePoolFromStock(currentProfileId, 'tv', rawSaved, currentPrefs),
          ]);
          if (!requestGateRef.current.isCurrent(ticket.id)) return;

          // Sunucuda indirilmiş katalog (data/catalog/movies.json & tv.json) varsa yerel havuzları tamamla
          const preMoviePool = loadPersistentPoolData(currentProfileId, 'movie');
          const preTvPool = loadPersistentPoolData(currentProfileId, 'tv');
          if (
            preMoviePool.items.length <= POOL_LOW_WATERMARK ||
            preTvPool.items.length <= POOL_LOW_WATERMARK
          ) {
            const serverCatalog = serverCatalogSnapshot || (await fetchCatalogItems());
            if (!requestGateRef.current.isCurrent(ticket.id)) return;
            if (serverCatalog) {
              if (preMoviePool.items.length <= POOL_LOW_WATERMARK && serverCatalog.movies) {
                const hydratedMovies = hydratePoolFromCatalog(
                  preMoviePool,
                  serverCatalog.movies,
                  rawSaved,
                  currentPrefs
                );
                if (hydratedMovies.addedCount > 0) {
                  savePersistentPoolData(currentProfileId, hydratedMovies.poolData);
                }
              }
              if (preTvPool.items.length <= POOL_LOW_WATERMARK && serverCatalog.tv) {
                const hydratedTv = hydratePoolFromCatalog(
                  preTvPool,
                  serverCatalog.tv,
                  rawSaved,
                  currentPrefs
                );
                if (hydratedTv.addedCount > 0) {
                  savePersistentPoolData(currentProfileId, hydratedTv.poolData);
                }
              }
            }
          }

          const shouldForcePoolForType = (mType: 'movie' | 'tv'): boolean => {
            if (!forceRefresh) return false;
            const existingPool = loadPersistentPoolData(currentProfileId, mType);
            const eligibleNonRing1 = filterOutLastRecommendedCandidates(
              existingPool.items.filter(
                (it) => it.media_type === mType && isCandidateEligibleInPool(it, rawSaved, currentPrefs)
              ),
              storedTasteMap.lastRecommendedKeys
            );
            const ring0Count = eligibleNonRing1.filter((it) => {
              const key = makeMediaKey(it);
              const mapEntry = storedTasteMap.entries?.[key];
              return (
                (it.shownCount || 0) === 0 &&
                (it.skippedCount || 0) === 0 &&
                (mapEntry?.shownCount || 0) === 0 &&
                (mapEntry?.skippedCount || 0) === 0
              );
            }).length;
            return existingPool.items.length <= POOL_LOW_WATERMARK || ring0Count < 60;
          };

          // Her koşuda hem 500 film hem 500 dizi havuzu tam kapasitede tutulur ve kullanıcıya göre işlenir
          setForYouProgressStep('500 film + 500 dizi aday havuzu kullanıcı zevk haritasına göre işleniyor…');
          const [moviePool, tvPool] = await Promise.all([
            replenishCandidatePool({
              profileId: currentProfileId,
              mediaType: 'movie',
              savedItems: rawSaved,
              preferences: currentPrefs,
              favoriteActors: favoriteActorsRef.current,
              fetchTmdbFn: fetchTmdbCached,
              signal: ticket.signal,
              force: shouldForcePoolForType('movie'),
              onProgress: (step) => {
                if (requestGateRef.current.isCurrent(ticket.id)) setForYouProgressStep(step);
              },
            }),
            replenishCandidatePool({
              profileId: currentProfileId,
              mediaType: 'tv',
              savedItems: rawSaved,
              preferences: currentPrefs,
              favoriteActors: favoriteActorsRef.current,
              fetchTmdbFn: fetchTmdbCached,
              signal: ticket.signal,
              force: shouldForcePoolForType('tv'),
            }),
          ]);
          if (!requestGateRef.current.isCurrent(ticket.id)) return;

          const fullMovieCandidates = moviePool.items.filter(
            (item) => item.media_type === 'movie' && isCandidateEligibleInPool(item, rawSaved, currentPrefs)
          );
          const fullTvCandidates = tvPool.items.filter(
            (item) => item.media_type === 'tv' && isCandidateEligibleInPool(item, rawSaved, currentPrefs)
          );

          // En güncel Zevk Haritası durumunu al
          const latestDiskMap = loadPersistentTasteMap(currentProfileId);
          const tasteMap =
            tasteMapRef.current &&
            tasteMapRef.current.profileId === currentProfileId &&
            (tasteMapRef.current.updatedAt || '') >= (latestDiskMap.updatedAt || '') &&
            (tasteMapRef.current.lastRecommendedKeys?.length || 0) >=
              (latestDiskMap.lastRecommendedKeys?.length || 0)
              ? tasteMapRef.current
              : latestDiskMap;
          const prevRecommendedKeys = tasteMap.lastRecommendedKeys || [];

          // Daraltılmış filtrelerde (örn. Sana Özel -> Film -> Fantastik) 20 öneriyi garantilemek için çok sayfalı tamamlama
          let movieCandidates = fullMovieCandidates;
          let tvCandidates = fullTvCandidates;
          const extraCatalogItemsToPersist: PoolCandidateItem[] = [];

          if (isFilteredView || fullMovieCandidates.length < TARGET_RECOMMENDATION_COUNT || fullTvCandidates.length < TARGET_RECOMMENDATION_COUNT) {
            const minNeeded = targetType === 'all' ? 16 : 28;
            if (targetType === 'all' || targetType === 'movie') {
              setForYouProgressStep('Seçili filtrelere uygun film adayları tamamlanıyor…');
              const topUpMovies = await topUpFilteredCandidates({
                profileId: currentProfileId,
                mediaType: 'movie',
                existingCandidates: fullMovieCandidates,
                savedItems: rawSaved,
                preferences: currentPrefs,
                lastRecommendedKeys: prevRecommendedKeys,
                selectedGenre: activeGenre,
                selectedProvider: provider,
                minFreshRequired: minNeeded,
                fetchTmdbFn: fetchTmdbCached,
                signal: ticket.signal,
              });
              movieCandidates = topUpMovies.filteredCandidates;
              extraCatalogItemsToPersist.push(...topUpMovies.newlyDiscovered);
            } else {
              movieCandidates = [];
            }

            if (targetType === 'all' || targetType === 'tv') {
              setForYouProgressStep('Seçili filtrelere uygun dizi adayları tamamlanıyor…');
              const topUpTv = await topUpFilteredCandidates({
                profileId: currentProfileId,
                mediaType: 'tv',
                existingCandidates: fullTvCandidates,
                savedItems: rawSaved,
                preferences: currentPrefs,
                lastRecommendedKeys: prevRecommendedKeys,
                selectedGenre: activeGenre,
                selectedProvider: provider,
                minFreshRequired: minNeeded,
                fetchTmdbFn: fetchTmdbCached,
                signal: ticket.signal,
              });
              tvCandidates = topUpTv.filteredCandidates;
              extraCatalogItemsToPersist.push(...topUpTv.newlyDiscovered);
            } else {
              tvCandidates = [];
            }
          }
          if (!requestGateRef.current.isCurrent(ticket.id)) return;

          // İndirilmiş tüm 500 film + 500 dizi (+ filtre keşifleri) kalıcı kataloğa senkronize edilir
          const catalogSyncPayload = [
            ...fullMovieCandidates,
            ...fullTvCandidates,
            ...extraCatalogItemsToPersist,
          ];
          const catalogUpsertPromise = pushCatalogItems(catalogSyncPayload);

          // Tüm 500 film + 500 dizi havuzunu kullanıcının kendi zevk profiline göre puanla
          const allMoviesUnionMap = new Map<string, PoolCandidateItem>();
          for (const m of [...fullMovieCandidates, ...movieCandidates]) {
            allMoviesUnionMap.set(makeMediaKey(m), m);
          }
          const allTvUnionMap = new Map<string, PoolCandidateItem>();
          for (const t of [...fullTvCandidates, ...tvCandidates]) {
            allTvUnionMap.set(makeMediaKey(t), t);
          }

          const fullMovieScored = scoreCandidatesV3(
            Array.from(allMoviesUnionMap.values()),
            movieTasteProfile,
            {
              weights: RECOMMENDATION_WEIGHTS_V3,
              genreNames: currentGenres,
              mood: currentPrefs.mood,
              tasteMap,
            }
          ).sort((a, b) => b.score - a.score);

          const fullTvScored = scoreCandidatesV3(
            Array.from(allTvUnionMap.values()),
            tvTasteProfile,
            {
              weights: RECOMMENDATION_WEIGHTS_V3,
              genreNames: currentGenres,
              mood: currentPrefs.mood,
              tasteMap,
            }
          ).sort((a, b) => b.score - a.score);

          const activeMovieKeys = new Set(movieCandidates.map((m) => makeMediaKey(m)));
          const activeTvKeys = new Set(tvCandidates.map((t) => makeMediaKey(t)));

          const movieScored = isFilteredView
            ? fullMovieScored.filter((entry) => activeMovieKeys.has(makeMediaKey(entry.candidate)))
            : fullMovieScored;
          const tvScored = isFilteredView
            ? fullTvScored.filter((entry) => activeTvKeys.has(makeMediaKey(entry.candidate)))
            : fullTvScored;

          // Adayları ayrıntılı bilgilerle zenginleştirme (Halka 1 kesinlikle hariç)
          const buildEnrichmentShortlist = (scoredList: any[], count: number) => {
            const withoutLastBatch = filterOutLastRecommendedCandidates(scoredList, prevRecommendedKeys);
            const ring0Items = withoutLastBatch.filter((e) => e.ring === 'ring0');
            const ring2Items = withoutLastBatch.filter((e) => e.ring === 'ring2');
            return [...ring0Items, ...ring2Items].slice(0, count);
          };

          let shortlist: any[] = [];
          let movieShortlist: any[] = [];
          let tvShortlist: any[] = [];

          if (targetType === 'all') {
            movieShortlist = buildEnrichmentShortlist(movieScored, 24);
            tvShortlist = buildEnrichmentShortlist(tvScored, 24);
            shortlist = [...movieShortlist, ...tvShortlist];
          } else if (targetType === 'movie') {
            movieShortlist = buildEnrichmentShortlist(movieScored, 40);
            shortlist = movieShortlist;
          } else {
            tvShortlist = buildEnrichmentShortlist(tvScored, 40);
            shortlist = tvShortlist;
          }

          setForYouProgressStep('Öne çıkan adayların kadro ve hikâye sinyalleri zenginleştiriliyor…');
          const shortlistTopCast: Record<string, number[]> = {};
          await mapLimit(shortlist, 5, async (entry) => {
            try {
              const details = await fetchTmdbCached(
                `/${entry.candidate.media_type}/${entry.candidate.id}`,
                { append_to_response: 'credits' },
                ticket.signal
              );
              const castSlice = (details?.credits?.cast || []).slice(0, 8);
              const top3Ids = castSlice
                .slice(0, 3)
                .map((c: any) => Number(c?.id))
                .filter((n: number) => Number.isInteger(n) && n > 0);
              if (top3Ids.length > 0) {
                shortlistTopCast[makeMediaKey(entry.candidate)] = top3Ids;
              }
              Object.assign(entry.candidate, {
                overview: entry.candidate.overview || details?.overview || '',
                belongs_to_collection: details?.belongs_to_collection || null,
                production_companies: details?.production_companies || [],
                cast: castSlice,
                crew: (details?.credits?.crew || []).filter(
                  (m: any) => m.job === 'Director' || m.job === 'Creator'
                ),
              });
            } catch {}
          });
          if (Object.keys(shortlistTopCast).length > 0) {
            void enrichStockItemsTopCast(shortlistTopCast);
          }
          if (!requestGateRef.current.isCurrent(ticket.id)) return;

          // Zenginleştirilmiş adayları bağımsız olarak yeniden puanla ve lastRecommendedKeys'i süz
          let enrichedMovieScored: any[] = [];
          let enrichedTvScored: any[] = [];

          if (movieShortlist.length > 0) {
            enrichedMovieScored = filterOutLastRecommendedCandidates(
              scoreCandidatesV3(
                movieShortlist.map((e) => e.candidate),
                movieTasteProfile,
                {
                  weights: RECOMMENDATION_WEIGHTS_V3,
                  genreNames: currentGenres,
                  mood: currentPrefs.mood,
                  tasteMap,
                }
              ),
              prevRecommendedKeys
            )
              .filter((entry) => isCandidateEligibleInPool(entry.candidate, rawSaved, currentPrefs))
              .sort((a, b) => b.score - a.score);
          }

          if (tvShortlist.length > 0) {
            enrichedTvScored = filterOutLastRecommendedCandidates(
              scoreCandidatesV3(
                tvShortlist.map((e) => e.candidate),
                tvTasteProfile,
                {
                  weights: RECOMMENDATION_WEIGHTS_V3,
                  genreNames: currentGenres,
                  mood: currentPrefs.mood,
                  tasteMap,
                }
              ),
              prevRecommendedKeys
            )
              .filter((entry) => isCandidateEligibleInPool(entry.candidate, rawSaved, currentPrefs))
              .sort((a, b) => b.score - a.score);
          }

          const movieShortlistKeys = new Set(movieShortlist.map((e) => makeMediaKey(e.candidate)));
          const tvShortlistKeys = new Set(tvShortlist.map((e) => makeMediaKey(e.candidate)));
          const remainingMovieScored = filterOutLastRecommendedCandidates(movieScored, prevRecommendedKeys).filter(
            (entry) =>
              !movieShortlistKeys.has(makeMediaKey(entry.candidate)) &&
              isCandidateEligibleInPool(entry.candidate, rawSaved, currentPrefs)
          );
          const remainingTvScored = filterOutLastRecommendedCandidates(tvScored, prevRecommendedKeys).filter(
            (entry) =>
              !tvShortlistKeys.has(makeMediaKey(entry.candidate)) &&
              isCandidateEligibleInPool(entry.candidate, rawSaved, currentPrefs)
          );

          const balancedResult = selectBalancedRecommendations({
            targetType,
            scoredMovies: enrichedMovieScored,
            scoredTv: enrichedTvScored,
            remainingMovies: remainingMovieScored,
            remainingTv: remainingTvScored,
            lastRecommendedKeys: prevRecommendedKeys,
            tasteMap,
            targetTotal: TARGET_RECOMMENDATION_COUNT,
            minPerTypeInAll: 10,
            maxPerGenre: isFilteredView ? TARGET_RECOMMENDATION_COUNT : undefined,
          });

          const picked = [...balancedResult.items];
          // Dar bir tür/platform filtresinde 'all' seçiliyken bir medya tipi 10 adedin altında kalırsa 20'ye tamamla
          if (isFilteredView && targetType === 'all' && picked.length < TARGET_RECOMMENDATION_COUNT) {
            const pickedKeys = new Set(picked.map((e: any) => makeMediaKey(e.candidate || e)));
            const overflowPool = [
              ...enrichedMovieScored,
              ...enrichedTvScored,
              ...remainingMovieScored,
              ...remainingTvScored,
            ].sort((a, b) => b.score - a.score);
            for (const candidateEntry of overflowPool) {
              if (picked.length >= TARGET_RECOMMENDATION_COUNT) break;
              const k = makeMediaKey(candidateEntry.candidate || candidateEntry);
              if (!pickedKeys.has(k)) {
                pickedKeys.add(k);
                picked.push(candidateEntry);
              }
            }
          }

          const explanationText = balancedResult.explanation;
          setForYouExplanation(explanationText);

          // Tam 500 film + 500 dizi kullanıcı puanlarını tek bir haritada birleştir (hiçbir filtre havuz kayıtlarını silmez!)
          const fullPoolScoredMap = new Map<string, any>();
          for (const entry of [...fullMovieScored, ...fullTvScored, ...enrichedMovieScored, ...enrichedTvScored]) {
            fullPoolScoredMap.set(makeMediaKey(entry.candidate || entry), entry);
          }
          const allPoolCandidates = Array.from(fullPoolScoredMap.values());

          const summaryProfile =
            targetType === 'movie'
              ? movieTasteProfile
              : targetType === 'tv'
              ? tvTasteProfile
              : generalTasteProfile;
          const tasteSummary = buildTasteProfileSummary(summaryProfile, tasteMap, currentGenres);

          const updatedTasteMap = updateTasteMapWithBatch({
            tasteMap,
            newRecommendedItems: picked,
            allPoolCandidates,
            savedItems: rawSaved,
            preferences: currentPrefs,
            favoriteActors: favoriteActorsRef.current,
            profileSignature: currentSig,
            targetType,
            explanation: explanationText,
            summary: tasteSummary,
            isFilterChange: isFilterTriggeredRun,
            isFilteredView,
            pruneInactiveCandidates: !isFilteredView,
            normalizeLegacyRings: true,
          });
          savePersistentTasteMap(currentProfileId, updatedTasteMap);
          tasteMapRef.current = updatedTasteMap;
          setTasteMap(updatedTasteMap);

          // Kullanıcının işlenmiş 500+500 Zevk Haritası verisini (signals + reasons + katalog özetiyle) sunucudaki data/profiles/<profileId>.json dosyasına yaz
          const localCatalogSignature = computeSourceCatalogSignature(catalogSyncPayload);
          void catalogUpsertPromise.then((catalogRes) => {
            const effectiveCatalogHash =
              typeof catalogRes?.contentHash === 'string' && catalogRes.contentHash
                ? catalogRes.contentHash
                : localCatalogSignature;
            const derivedPayload = buildDerivedProfilePayloadFromTasteMap({
              profileId: currentProfileId,
              tasteMap: updatedTasteMap,
              profileFingerprint: currentSig,
              algorithmVersion: ALGORITHM_VERSION,
              sourceCatalogHash: effectiveCatalogHash,
            });
            return pushDerivedProfileData(derivedPayload);
          });

          const { displayItems, reasonsMap } = mapRecommendationBatchToDisplayItems(
            picked,
            updatedTasteMap,
            targetType
          );

          setForYouReasons(reasonsMap);
          setForYouItems(displayItems);
          lastForYouQueryKeyRef.current = forYouQueryKey;
          setCatalogTotalPages(1);
          setCatalogPage(1);
          setForYouProgressStep('');
          if (forceRefresh) showToast(explanationText);
          return;
        }

        // Diğer Keşfet kategorileri (Gündemdekiler, Yüksek Puanlılar, Gizli Cevherler, Yakında, Platform):
        // 'Listemdekileri Gizle' veya beğenilmeyenler nedeniyle sonuç 20'nin altına düşerse sonraki sayfalardan 20'ye tamamla
        const firstPage = await fetchDiscoverPageByCategory(p);
        if (!requestGateRef.current.isCurrent(ticket.id)) return;

        const combinedRawItems = [...firstPage.rawItems];
        const totalPages = firstPage.totalPages;
        let effectiveLastPage = p;

        if (!append) {
          const seenKeys = new Set(combinedRawItems.map((it) => makeMediaKey(it)));
          const shouldHideListed =
            hideListedItemsRef.current &&
            (HIDE_LISTED_CATEGORIES as readonly string[]).includes(cat);

          const countVisibleItems = (list: any[]) =>
            list.filter((it) => {
              const mType = it.media_type || (it.title ? 'movie' : 'tv');
              const k = makeMediaKey(mType, it.id);
              if (preferencesRef.current.disliked.includes(k)) return false;
              if (preferencesRef.current.hidden?.includes(k)) return false;
              if (targetType !== 'all' && mType !== targetType) return false;
              if (activeGenre && !matchesSelectedGenre(it, activeGenre)) return false;
              if (
                shouldHideListed &&
                filterHiddenUserRegisteredItems([it], {
                  savedItems: savedItemsRef.current,
                  preferences: preferencesRef.current,
                  tasteMap: tasteMapRef.current,
                  hideListedItems: true,
                }).length === 0
              ) {
                return false;
              }
              return true;
            }).length;

          let extraScans = 0;
          while (
            cat !== 'stock' &&
            countVisibleItems(combinedRawItems) < TARGET_RECOMMENDATION_COUNT &&
            effectiveLastPage < totalPages &&
            extraScans < 5
          ) {
            extraScans += 1;
            effectiveLastPage += 1;
            const nextRes = await fetchDiscoverPageByCategory(effectiveLastPage);
            if (!requestGateRef.current.isCurrent(ticket.id)) return;
            for (const item of nextRes.rawItems) {
              const k = makeMediaKey(item);
              if (!seenKeys.has(k)) {
                seenKeys.add(k);
                combinedRawItems.push(item);
              }
            }
          }
        }

        const enriched = enrichItemsWithPersonalizedTaste(combinedRawItems);

        if (cat === 'trending' && !append && enriched[0]) {
          setTrendingTop(enriched[0]);
        }
        setCatalogItems((prev) => {
          if (!append) return enriched;
          const seen = new Set(prev.map((it) => makeMediaKey(it.media_type || (it.title ? 'movie' : 'tv'), it.id)));
          const fresh = enriched.filter((it) => {
            const k = makeMediaKey(it.media_type || (it.title ? 'movie' : 'tv'), it.id);
            if (seen.has(k)) return false;
            seen.add(k);
            return true;
          });
          return [...prev, ...fresh];
        });
        setCatalogTotalPages(totalPages);
        setCatalogPage(effectiveLastPage);
      } catch (err: any) {
        if (!ticket.signal.aborted) {
          console.warn('Catalog load error:', err.message);
          if (forceRefresh) showToast('Öneriler yenilenemedi. Lütfen tekrar deneyin.');
          if (!append) setCatalogItems([]);
        }
      } finally {
        if (requestGateRef.current.isCurrent(ticket.id)) {
          setForYouProgressStep('');
          setIsLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [query, selectedProvider, showToast]
  );

  const handleRefreshForYou = useCallback(() => {
    const savedSet = new Set(savedItemsRef.current.map((s) => makeMediaKey(s)));
    const skipped = forYouItemsRef.current
      .map((it) => makeMediaKey(it))
      .filter((k) => !savedSet.has(k));
    if (skipped.length > 0) {
      void recordSkippedKeysIdb(activeProfileIdRef.current, skipped);
    }
    loadCategoryResults('for-you', 1, false, '', selectedProvider, true, selectedType, selectedGenre);
  }, [loadCategoryResults, selectedProvider, selectedType, selectedGenre]);

  const handleRefreshTasteMap = useCallback(() => {
    loadCategoryResults('for-you', 1, false, '', selectedProvider, true, selectedType, selectedGenre);
  }, [loadCategoryResults, selectedProvider, selectedType, selectedGenre]);

  const handleLoadRelationshipCandidates = useCallback(
    async (mediaFilter: 'all' | 'movie' | 'tv'): Promise<PoolCandidateItem[]> => {
      const mediaTypes: Array<'movie' | 'tv'> =
        mediaFilter === 'all' ? ['movie', 'tv'] : [mediaFilter];

      const result: PoolCandidateItem[] = [];

      for (const mediaType of mediaTypes) {
        await seedCandidatePoolFromStock(activeProfileId, mediaType, savedItems, preferences);
        const pool = await replenishCandidatePool({
          profileId: activeProfileId,
          mediaType,
          savedItems,
          preferences,
          favoriteActors,
          fetchTmdbFn: fetchTmdbCached,
          force: false,
        });

        result.push(...pool.items);
      }

      return result;
    },
    [activeProfileId, savedItems, preferences, favoriteActors]
  );

  const handleSelectType = useCallback((newType: string) => {
    setSelectedType(newType);
    selectedTypeRef.current = newType;
  }, []);

  const handleSelectGenre = useCallback((newGenre: string) => {
    setSelectedGenre(newGenre);
    selectedGenreRef.current = newGenre;
  }, []);

  useEffect(() => {
    if (tab === 'taste-map') {
      const stored = loadPersistentTasteMap(activeProfileId);
      if (Object.keys(stored.entries || {}).length < 400 && !isLoading) {
        loadCategoryResults('for-you', 1, false, '', selectedProvider, false, selectedType, selectedGenre);
      }
    }
  }, [tab, activeProfileId, isLoading, loadCategoryResults, selectedProvider, selectedType, selectedGenre]);

  const stockHasItems = stockStats.movieCount + stockStats.tvCount > 0;

  const handleManualStockReplenish = useCallback(() => {
    void manualPullStock(activeProfileId, {
      userListItems: savedItemsRef.current,
      preferences: preferencesRef.current,
    }).then((res) => {
      setStockStats({
        movieCount: res.moviesCount,
        tvCount: res.tvCount,
      });
      if (tab === 'discover' && category === 'stock' && !query.trim()) {
        loadCategoryResults('stock', 1, false, '', selectedProvider, false, selectedType, selectedGenre);
      }
      if (!res.ok && res.error) {
        showToast(`Stok çekilemedi: ${res.error}`);
        return;
      }
      const totalAdded = res.addedMovies + res.addedTv;
      const skippedTotal = res.skippedListedCount + res.skippedDuplicateStockCount;
      if (totalAdded > 0) {
        const skipNote =
          skippedTotal > 0 ? ` (${skippedTotal} mevcut liste/stok kaydı atlandı)` : '';
        showToast(
          `✓ Stoka +${res.addedMovies} film ve +${res.addedTv} dizi eklendi${skipNote}.`
        );
      } else {
        showToast(
          'Yeni stok adayı bulunamadı; çekilen içerikler zaten listenizde veya stok havuzunda kayıtlı.'
        );
      }
    });
  }, [
    activeProfileId,
    tab,
    category,
    query,
    loadCategoryResults,
    selectedProvider,
    selectedType,
    selectedGenre,
    showToast,
  ]);

  useEffect(() => {
    if (tab === 'discover') {
      if (category === 'stock' && !query.trim()) {
        return;
      }
      if (category === 'for-you') {
        // FEAT-01 #11: Switching Tümü / Film / Dizi or genre inside "Seriler" filters from memory with ZERO network calls
        if (forYouSubTab === 'series' && !query.trim()) {
          return;
        }
        const currentForYouKey = `${activeProfileId}|${
          selectedType === 'movie' || selectedType === 'tv' ? selectedType : 'all'
        }|${selectedGenre || ''}|${selectedProvider || ''}`;
        if (
          lastForYouQueryKeyRef.current === currentForYouKey &&
          forYouItemsRef.current.length >= TARGET_RECOMMENDATION_COUNT
        ) {
          return;
        }
        loadCategoryResults(category, 1, false, query, selectedProvider, false, selectedType, selectedGenre);
        return;
      }
      loadCategoryResults(category, 1, false, query, selectedProvider, false, selectedType, selectedGenre);
    }
  }, [tab, category, forYouSubTab, query, selectedProvider, selectedType, selectedGenre, hideListedItems, loadCategoryResults]);

  useEffect(() => {
    if (tab === 'discover' && category === 'stock' && !query.trim()) {
      loadCategoryResults('stock', 1, false, '', selectedProvider, false, selectedType, selectedGenre);
    }
  }, [selectedSort, hideListedItems, stockHasItems, tab, category, query, selectedProvider, selectedType, selectedGenre, loadCategoryResults]);

  // Load more pagination
  const handleLoadMore = () => {
    if (tab === 'discover' && category !== 'for-you' && catalogPage < catalogTotalPages) {
      loadCategoryResults(category, catalogPage + 1, true, query, selectedProvider, false, selectedType, selectedGenre);
    }
  };

  // Searching
  const handleSearchSubmit = (q: string) => {
    setQuery(q);
    if (q.trim()) {
      setTab('discover');
      setCategory('trending');
    }
  };

  const handleSearchClear = () => {
    setQuery('');
    if (tab === 'discover') {
      loadCategoryResults(category, 1, false, '');
    }
  };

  // Saved items CRUD (V1.5: ratedAt & completedAt zaman damgası altyapısı)
  const commitSavedItem = (
    normalized: SavedItem,
    rawItem: any,
    effectiveStatus: 'watching' | 'watchlist' | 'completed'
  ) => {
    const mediaType = normalized.media_type;
    const targetId = String(normalized.id);
    const targetTitle = (rawItem.title || rawItem.name || normalized.title || '').trim().toLowerCase();

    if (activeProfile?.isDemo) {
      setProfiles((prev) =>
        prev.map((p) => (p.id === activeProfileId ? { ...p, isDemo: false } : p))
      );
    }

    const itemKey = makeMediaKey(mediaType, targetId);
    if (deletedKeysRef.current[itemKey]) {
      setDeletedKeys((prev) => {
        if (!prev[itemKey]) return prev;
        const copy = { ...prev };
        delete copy[itemKey];
        deletedKeysRef.current = copy;
        return copy;
      });
    }
    setSavedItems((currentSaved) => {
      const existingIndex = currentSaved.findIndex(
        (entry) =>
          makeMediaKey(entry) === itemKey ||
          (Boolean(targetTitle) &&
            entry.media_type === mediaType &&
            (entry.title || '').trim().toLowerCase() === targetTitle)
      );

      let next: SavedItem[];
      if (existingIndex >= 0) {
        next = [...currentSaved];
        next[existingIndex] = normalized;
      } else {
        next = [normalized, ...currentSaved];
      }
      savedItemsRef.current = next;
      return next;
    });

    // Immediately remove from recommendations (Sana Özel) so it NEVER lingers!
    setForYouItems((prev) =>
      prev.filter((i) => makeMediaKey(i) !== itemKey)
    );

    // Sorun D: Kalıcı Zevk Haritasında yapımı 'saved' olarak işaretle
    try {
      const currentTasteMap = loadPersistentTasteMap(activeProfileIdRef.current);
      markTasteMapItemStatus(currentTasteMap, itemKey, 'saved');
      savePersistentTasteMap(activeProfileIdRef.current, currentTasteMap);
      const nextMap = { ...currentTasteMap };
      tasteMapRef.current = nextMap;
      setTasteMap(nextMap);
    } catch {}

    // Aşama 3 & 4: Stoktan düş, ct:surfaced & ct:skip-log geçmişinden çıkar ve seri indeksini güncelle
    void consumeStockItem(normalized, activeProfileIdRef.current);
    void removeSurfacedKey(itemKey);
    void removeSkippedKeyIdb(activeProfileIdRef.current, itemKey);
    void indexItemForSeries(normalized);
    void recordProfileChangeAndMaybeBackup();

    const title = displayTitle(rawItem);
    if (effectiveStatus === 'completed') {
      showToast(`✓ "${title}" izlendi listesine kaydedildi! 🎉`);
    } else if (effectiveStatus === 'watching') {
      showToast(`▶ "${title}" izleniyor olarak kaydedildi! 🍿`);
    } else {
      showToast(`✓ "${title}" izlenecekler listesine kaydedildi! ✨`);
    }

    // Auto-enrich TV show metadata if episode count or runtime is missing
    if (normalized.media_type === 'tv' && !normalized.custom && !normalized.number_of_episodes) {
      const tvId = normalized.id;
      fetchTmdb(`/tv/${tvId}`)
        .then((tvDetails) => {
          if (tvDetails) {
            setSavedItems((currentList) =>
              currentList.map((entry) => {
                if (entry.id === tvId && entry.media_type === 'tv') {
                  return {
                    ...entry,
                    number_of_episodes: Number(tvDetails.number_of_episodes) || 10,
                    number_of_seasons: Number(tvDetails.number_of_seasons) || 1,
                    episode_run_time: tvDetails.episode_run_time || [45],
                    runtime: tvDetails.episode_run_time?.[0] || 45,
                  };
                }
                return entry;
              })
            );
          }
        })
        .catch(() => {});
    }
  };

  const { saveItem, setItemStatus, markCompleted, dislikeItem, hideItem } = useItemActions({
    getSavedItems: () => savedItemsRef.current,
    onCommitSavedItem: commitSavedItem,
  });

  const handleSaveItem = (
    item: any,
    status: 'watching' | 'watchlist' | 'completed',
    personalRating: number | '',
    tracking: any = {}
  ) => {
    saveItem(item, status, personalRating, tracking);
  };

  const handleQuickAdd = (item: any) => {
    saveItem(item, 'watchlist', '');
    showToast(`✓ "${displayTitle(item)}" izlenecekler listesine eklendi! ✨`);
  };

  const handleMarkCompleted = (item: any) => {
    markCompleted(item);
    showToast(`✓ "${displayTitle(item)}" izlendi listesine eklendi! 🎉`);
  };

  const handleSetStatus = (item: any, status: 'watching' | 'watchlist' | 'completed') => {
    setItemStatus(item, status);
    const title = displayTitle(item);
    if (status === 'completed') {
      showToast(`✓ "${title}" izlendi listesine eklendi! 🎉`);
    } else if (status === 'watching') {
      showToast(`▶ "${title}" izleniyor olarak işaretlendi! 🍿`);
    } else {
      showToast(`✓ "${title}" izlenecekler listesine eklendi! ✨`);
    }
  };

  const handleToggleFavoriteActor = (actor: any) => {
    const actorId = Number(actor?.id);
    if (!Number.isInteger(actorId) || actorId <= 0) return;
    setFavoriteActors((prev) => {
      const normalizedPrev = normalizeFavoriteActors(prev);
      const exists = normalizedPrev.some((a) => a.id === actorId);
      if (exists) {
        showToast(`"${actor.name || 'Oyuncu'}" favori oyuncularınızdan çıkarıldı.`);
        return normalizedPrev.filter((a) => a.id !== actorId);
      } else {
        showToast(`"${actor.name || 'Oyuncu'}" favori oyuncularınıza eklendi!`);
        return normalizeFavoriteActors([
          {
            id: actorId,
            name: actor.name || 'Bilinmeyen Oyuncu',
            profile_path: actor.profile_path || '',
            character: actor.character || '',
          },
          ...normalizedPrev,
        ]);
      }
    });
    void recordProfileChangeAndMaybeBackup();
  };

  const handleIncrementTvEpisode = (targetItem: SavedItem) => {
    const nowIso = new Date().toISOString();
    const progressedItem = advanceTvEpisodeProgress(targetItem, nowIso);
    const transitionedToCompleted =
      targetItem.status !== 'completed' && progressedItem.status === 'completed';
    const updatedItem: SavedItem = transitionedToCompleted
      ? { ...progressedItem, completedAt: nowIso }
      : progressedItem;
    setSavedItems((prev) => {
      const next = prev.map((entry) =>
        makeMediaKey(entry) === makeMediaKey(targetItem) ? updatedItem : entry
      );
      savedItemsRef.current = next;
      return next;
    });
    void recordProfileChangeAndMaybeBackup();
    const seriesTitle = displayTitle(updatedItem);
    if (transitionedToCompleted) {
      showToast(`✓ "${seriesTitle}" tüm bölümler izlendi olarak tamamlandı!`);
    } else {
      showToast(
        `▶ "${seriesTitle}" S${updatedItem.current_season || 1} · B${
          (updatedItem.season_progress || {})[updatedItem.current_season || 1] || 1
        } kaydedildi.`
      );
    }
  };

  const handleMergeDuplicates = (
    keepId: SavedItem['id'],
    dropId: SavedItem['id'],
    mediaType: 'movie' | 'tv'
  ) => {
    const { mergedItems, mergedItem, removedKey } = mergeDuplicateSavedPair(
      savedItemsRef.current,
      keepId,
      dropId,
      mediaType
    );
    if (!mergedItem) return;

    const dropKey = removedKey || makeMediaKey(mediaType, dropId);

    setDeletedKeys((prev) => {
      const nextDeleted = normalizeDeletedKeys({ ...prev, [dropKey]: new Date().toISOString() });
      deletedKeysRef.current = nextDeleted;
      return nextDeleted;
    });

    setSavedItems(() => {
      savedItemsRef.current = mergedItems;
      return mergedItems;
    });

    void recordProfileChangeAndMaybeBackup();
    showToast(`✓ "${displayTitle(mergedItem)}" çift kaydı başarıyla birleştirildi.`);
  };

  const handleRemoveItem = (item: any) => {
    const itemKey = makeMediaKey(item);
    const mediaType = item.media_type || (item.title ? 'movie' : 'tv');
    const targetTitle = (item.title || item.name || '').trim().toLowerCase();
    if (itemKey.startsWith('movie:') || itemKey.startsWith('tv:')) {
      const deletedAtIso = new Date().toISOString();
      setDeletedKeys((prev) => {
        const nextDeleted = normalizeDeletedKeys({ ...prev, [itemKey]: deletedAtIso });
        deletedKeysRef.current = nextDeleted;
        return nextDeleted;
      });
    }
    setSavedItems((prev) => {
      const next = prev.filter(
        (entry) =>
          makeMediaKey(entry) !== itemKey &&
          (!targetTitle ||
            entry.media_type !== mediaType ||
            (entry.title || '').trim().toLowerCase() !== targetTitle)
      );
      savedItemsRef.current = next;
      return next;
    });

    try {
      const currentTasteMap = loadPersistentTasteMap(activeProfileIdRef.current);
      markTasteMapItemStatus(currentTasteMap, itemKey, 'active');
      savePersistentTasteMap(activeProfileIdRef.current, currentTasteMap);
      const nextMap = { ...currentTasteMap };
      tasteMapRef.current = nextMap;
      setTasteMap(nextMap);
    } catch {}

    void recordProfileChangeAndMaybeBackup();
    showToast(`"${displayTitle(item)}" listeden kaldırıldı.`);
  };

  const handleToggleDislike = (key: string) => {
    setPreferences((prev) => {
      const isCurrentlyDisliked = prev.disliked.includes(key);
      const disliked = isCurrentlyDisliked
        ? prev.disliked.filter((k) => k !== key)
        : [...prev.disliked, key].slice(-500);

      // Cache disliked item details so "İlgilenmediklerim" tab can display posters & details
      if (!isCurrentlyDisliked) {
        const target =
          catalogItems.find((c) => `${c.media_type}:${c.id}` === key) ||
          forYouItems.find((c) => `${c.media_type}:${c.id}` === key) ||
          savedItems.find((s) => `${s.media_type}:${s.id}` === key);
        if (target) {
          setDislikedItems((current) => {
            if (current.some((item) => `${item.media_type}:${item.id}` === key)) return current;
            const updated = [target, ...current];
            try {
              const cache: Record<string, any> = {};
              updated.forEach((item) => {
                cache[`${item.media_type}:${item.id}`] = item;
              });
              localStorage.setItem('cinetrack_disliked_cache', JSON.stringify(cache));
            } catch {}
            return updated;
          });
        }
      }

      showToast(
        isCurrentlyDisliked
          ? 'İlgilenmiyorum listesinden kaldırıldı.'
          : '🚫 İlgilenmiyorum olarak işaretlendi (Önerilerden gizlendi).'
      );

      // Sorun D: Kalıcı Zevk Haritasında yapımı 'disliked' veya 'active' olarak güncelle
      try {
        const currentTasteMap = loadPersistentTasteMap(activeProfileIdRef.current);
        markTasteMapItemStatus(currentTasteMap, key, isCurrentlyDisliked ? 'active' : 'disliked');
        savePersistentTasteMap(activeProfileIdRef.current, currentTasteMap);
        const nextMap = { ...currentTasteMap };
        tasteMapRef.current = nextMap;
        setTasteMap(nextMap);
      } catch {}

      if (!isCurrentlyDisliked) {
        const [mType, rawId] = key.split(':');
        if (mType && rawId) {
          void consumeStockItem({ id: rawId, media_type: mType }, activeProfileIdRef.current);
        }
        const targetMeta =
          catalogItems.find((c) => `${c.media_type}:${c.id}` === key) ||
          forYouItems.find((c) => `${c.media_type}:${c.id}` === key) ||
          savedItems.find((s) => `${s.media_type}:${s.id}` === key);
        dislikeItem(key, targetMeta as Record<string, unknown> | undefined);
      }

      return { ...prev, disliked };
    });
    void recordProfileChangeAndMaybeBackup();
  };

  const handleToggleHide = (key: string) => {
    setPreferences((prev) => {
      const currentHidden = Array.isArray(prev.hidden) ? prev.hidden : [];
      const isCurrentlyHidden = currentHidden.includes(key);
      const hidden = isCurrentlyHidden
        ? currentHidden.filter((k) => k !== key)
        : [...currentHidden, key].slice(-500);

      showToast(
        isCurrentlyHidden
          ? 'Gizlenenler listesinden kaldırıldı.'
          : 'İçerik zevk profilinizi etkilemeden keşfet akışından gizlendi.'
      );

      if (!isCurrentlyHidden) {
        const [mType, rawId] = key.split(':');
        if (mType && rawId) {
          void consumeStockItem({ id: rawId, media_type: mType }, activeProfileIdRef.current);
        }
        const targetMeta =
          catalogItems.find((c) => `${c.media_type}:${c.id}` === key) ||
          forYouItems.find((c) => `${c.media_type}:${c.id}` === key) ||
          savedItems.find((s) => `${s.media_type}:${s.id}` === key);
        hideItem(key, targetMeta as Record<string, unknown> | undefined);
      }

      return { ...prev, hidden };
    });
    void recordProfileChangeAndMaybeBackup();
  };

  // Background fetch for any missing disliked items when entering disliked tab
  useEffect(() => {
    if (tab === 'list' && listStatus === 'disliked') {
      const missingKeys = preferences.disliked.filter(
        (key) => !dislikedItems.some((item) => `${item.media_type}:${item.id}` === key)
      );
      if (missingKeys.length > 0) {
        Promise.allSettled(
          missingKeys.map((key) => {
            const [type, id] = key.split(':');
            return fetchTmdb(`/${type}/${id}`).then((res) => ({ ...res, media_type: type }));
          })
        ).then((results) => {
          const newItems = results
            .filter((r): r is PromiseFulfilledResult<any> => r.status === 'fulfilled' && Boolean(r.value))
            .map((r) => r.value);
          if (newItems.length > 0) {
            setDislikedItems((prev) => {
              const combined = [...prev, ...newItems].filter(
                (item, idx, arr) =>
                  arr.findIndex((x) => `${x.media_type}:${x.id}` === `${item.media_type}:${item.id}`) === idx
              );
              try {
                const cache: Record<string, any> = {};
                combined.forEach((item) => {
                  cache[`${item.media_type}:${item.id}`] = item;
                });
                localStorage.setItem('cinetrack_disliked_cache', JSON.stringify(cache));
              } catch {}
              return combined;
            });
          }
        });
      }
    }
  }, [tab, listStatus, preferences.disliked, dislikedItems]);

  // Background enrich TV shows with missing episode count
  useEffect(() => {
    const unhydratedTvShows = savedItems.filter(
      (i) => i.media_type === 'tv' && !i.custom && !i.number_of_episodes
    );
    if (unhydratedTvShows.length > 0) {
      unhydratedTvShows.slice(0, 5).forEach((tv) => {
        fetchTmdb(`/tv/${tv.id}`)
          .then((details) => {
            if (details) {
              setSavedItems((currentList) =>
                currentList.map((entry) => {
                  if (entry.id === tv.id && entry.media_type === 'tv') {
                    return {
                      ...entry,
                      number_of_episodes: Number(details.number_of_episodes) || 10,
                      number_of_seasons: Number(details.number_of_seasons) || 1,
                      episode_run_time: details.episode_run_time || [45],
                      runtime: details.episode_run_time?.[0] || 45,
                    };
                  }
                  return entry;
                })
              );
            }
          })
          .catch(() => {});
      });
    }
  }, [savedItems.length]);

  // Filter & sort displayed items
  const filterAndSortItems = (items: any[]) => {
    let filtered = items.filter((item) => {
      if (item.media_type !== 'movie' && item.media_type !== 'tv') return false;
      if (selectedType !== 'all' && item.media_type !== selectedType) return false;
      if (selectedGenre && !matchesSelectedGenre(item, selectedGenre)) return false;
      return true;
    });

    if (tab === 'discover' && category !== 'for-you' && selectedSort === 'popular') {
      return filtered;
    }

    if (selectedSort === 'similarity') {
      const savedEncodings = savedItemsRef.current.map((it) => ({
        encoding: getItemEncodingSync(it),
        personal_rating: it.personal_rating,
      }));
      const profileCentroid = computeProfileCentroid(savedEncodings);
      if (profileCentroid.length > 0) {
        const simMap = new Map<string, number>();
        for (const it of filtered) {
          const enc = getItemEncodingSync(it);
          const sim = cosineSimilarity(profileCentroid, enc.denseVector);
          simMap.set(`${it.media_type}:${it.id}`, sim);
        }
        filtered = [...filtered].sort(
          (a, b) =>
            (simMap.get(`${b.media_type}:${b.id}`) ?? 0) -
            (simMap.get(`${a.media_type}:${a.id}`) ?? 0)
        );
      }
    } else if (selectedSort === 'rating') {
      filtered = [...filtered].sort((a, b) => (b.vote_average || 0) - (a.vote_average || 0));
    } else if (selectedSort === 'title') {
      filtered = [...filtered].sort((a, b) =>
        displayTitle(a).localeCompare(displayTitle(b), 'tr')
      );
    } else if (selectedSort === 'recent') {
      filtered = [...filtered].sort((a, b) =>
        tab === 'list'
          ? (b.addedAt || '').localeCompare(a.addedAt || '')
          : (b.release_date || b.first_air_date || '').localeCompare(
              a.release_date || a.first_air_date || ''
            )
      );
    }
    return filtered;
  };

  // FEAT-01 #10 & #11: Compute missing franchise parts strictly for franchises present in user's savedItems
  const seriesUniverseData = React.useMemo(() => {
    void seriesIndexVersion;
    const effectiveDemo = Boolean(activeProfile?.isDemo || tmdbSourceMeta.source === 'demo');
    const universes = computeUserSeriesUniverses(savedItems, {
      includeStubs: !effectiveDemo,
      dislikedKeys: preferences.disliked,
      hiddenKeys: preferences.hidden,
    });
    const items: any[] = [];
    const reasonsMap = new Map<string, string>();
    const seenKeys = new Set<string>();
    const dislikedSet = new Set(preferences.disliked || []);
    const hiddenSet = new Set(preferences.hidden || []);

    for (const u of universes) {
      const ownedTitles = u.userOwnedParts
        .slice(0, 2)
        .map((p) => p.title || p.name)
        .filter(Boolean)
        .join(', ');
      const reason = ownedTitles
        ? `${u.collection.name} · Listenizdeki "${ownedTitles}" ile aynı seride`
        : `${u.collection.name} serisinin devam halkası`;

      for (const part of u.userMissingParts) {
        const mType = part.media_type === 'tv' ? 'tv' : 'movie';
        const key = makeMediaKey(mType, part.id);
        if (seenKeys.has(key) || dislikedSet.has(key) || hiddenSet.has(key)) continue;
        if (isItemSaved(savedItems, part, mType)) continue;
        seenKeys.add(key);
        items.push({
          ...part,
          media_type: mType,
          belongs_to_collection: mType === 'movie' ? { id: u.collection.id, name: u.collection.name } : undefined,
        });
        reasonsMap.set(key, reason);
      }
    }

    return { items, reasonsMap, universesCount: universes.length };
  }, [savedItems, preferences.disliked, preferences.hidden, seriesIndexVersion, activeProfile?.isDemo, tmdbSourceMeta.source]);

  const getDisplayedItems = () => {
    if (tab === 'discover') {
      if (category === 'for-you' && forYouSubTab === 'series' && !query.trim()) {
        return filterAndSortItems(seriesUniverseData.items);
      }

      const rawSource = category === 'for-you' ? forYouItems : catalogItems;
      const shouldHideUserRegistered =
        !query.trim() &&
        hideListedItems &&
        (HIDE_LISTED_CATEGORIES as readonly string[]).includes(category);

      const preFiltered = shouldHideUserRegistered
        ? filterHiddenUserRegisteredItems(rawSource, {
            savedItems,
            preferences,
            tasteMap,
            hideListedItems: true,
          })
        : rawSource;

      const filtered = preFiltered.filter((item) => {
        const itemType = item.media_type || (item.title ? 'movie' : 'tv');
        const key = makeMediaKey(itemType, item.id);
        if (preferences.disliked.includes(key)) return false;
        if (preferences.hidden?.includes(key)) return false;

        // In Sana Özel (recommendations), strictly filter out items already in the user's list
        if (category === 'for-you') {
          if (isItemSaved(savedItems, item, itemType)) return false;
        }

        return true;
      });
      return filterAndSortItems(filtered);
    }

    if (listStatus === 'disliked') {
      const activeDisliked = dislikedItems.filter((item) =>
        preferences.disliked.includes(`${item.media_type}:${item.id}`)
      );
      return filterAndSortItems(activeDisliked);
    }

    let list = savedItems;
    if (listStatus === 'upcoming') {
      const todayStr = new Date().toISOString().slice(0, 10);
      list = savedItems
        .filter((item) => {
          const airDate = resolveAirDate(item);
          return airDate && airDate >= todayStr;
        })
        .sort((a, b) => resolveAirDate(a).localeCompare(resolveAirDate(b)));
    } else if (listStatus !== 'all') {
      list = savedItems.filter((item) => item.status === listStatus);
    }
    return filterAndSortItems(list);
  };

  const displayedItems = getDisplayedItems();

  // FEAT-02 #6: Record unsaved items displayed on the Discover tab into ct:surfaced FIFO ring history
  // REG-01: Never mark local ct:stock browsing as surfaced so stock items do not self-poison cooldowns
  useEffect(() => {
    if (tab !== 'discover' || displayedItems.length === 0) return;
    if (category === 'stock') return;
    if (category === 'for-you' && forYouSubTab === 'series' && !query.trim()) return;
    const savedKeySet = new Set(
      savedItems.map((it) => `${it.media_type === 'tv' ? 'tv' : 'movie'}:${it.id}`)
    );
    void markItemsAsSurfaced(displayedItems, savedKeySet);
  }, [tab, category, forYouSubTab, query, displayedItems, savedItems]);

  // Hero Item
  const watchingItem = savedItems.find((item) => item.status === 'watching') || null;
  const currentHeroItem = watchingItem || trendingTop || catalogItems[0] || null;
  const featuredHeroItems = React.useMemo(() => {
    const list: any[] = [];
    if (currentHeroItem) list.push(currentHeroItem);
    if (
      trendingTop &&
      !list.some(
        (it) =>
          `${it.media_type || (it.title ? 'movie' : 'tv')}:${it.id}` ===
          `${trendingTop.media_type || (trendingTop.title ? 'movie' : 'tv')}:${trendingTop.id}`
      )
    ) {
      list.push(trendingTop);
    }
    for (const item of catalogItems) {
      if (list.length >= 3) break;
      const key = `${item.media_type || (item.title ? 'movie' : 'tv')}:${item.id}`;
      if (
        !list.some(
          (existing) =>
            `${existing.media_type || (existing.title ? 'movie' : 'tv')}:${existing.id}` === key
        )
      ) {
        list.push(item);
      }
    }
    return list;
  }, [currentHeroItem, trendingTop, catalogItems]);

  const todayStr = new Date().toISOString().slice(0, 10);
  const upcomingCount = savedItems.filter((item) => {
    const airDate = resolveAirDate(item);
    return airDate && airDate >= todayStr && (selectedType === 'all' || item.media_type === selectedType);
  }).length;
  const watchingCount = savedItems.filter(
    (item) => item.status === 'watching' && (selectedType === 'all' || item.media_type === selectedType)
  ).length;
  const watchlistCount = savedItems.filter(
    (item) => item.status === 'watchlist' && (selectedType === 'all' || item.media_type === selectedType)
  ).length;
  const completedCount = savedItems.filter(
    (item) => item.status === 'completed' && (selectedType === 'all' || item.media_type === selectedType)
  ).length;
  const allListCount = savedItems.filter(
    (item) => selectedType === 'all' || item.media_type === selectedType
  ).length;

  const tasteSummary = React.useMemo<TasteProfileSummary>(() => {
    if (tasteMap.summary && tasteMap.summary.topGenres && tasteMap.summary.topGenres.length > 0) {
      return tasteMap.summary;
    }
    const currentSaved = filterHistoryByType(savedItems, 'all');
    const profile = buildTasteProfileV3(currentSaved, { dislikedKeys: preferences.disliked });
    return buildTasteProfileSummary(profile, tasteMap, genresMap);
  }, [tasteMap, savedItems, preferences.disliked, genresMap]);

  // FEAT-02 #4: Persist isolated ct:profile (Theme, DNA, Preferences) and compact ct:user-lists (IDs & statuses only)
  useEffect(() => {
    const resolvedTheme =
      typeof document !== 'undefined'
        ? document.documentElement.dataset.theme || 'dark-navy'
        : 'dark-navy';
    void saveIsolatedProfileIdb({
      profileId: activeProfileId,
      name: profileName,
      theme: resolvedTheme,
      dna: tasteSummary,
      preferences,
      favoriteActors,
      updatedAt: new Date().toISOString(),
    });
  }, [activeProfileId, profileName, tasteSummary, preferences, favoriteActors]);

  useEffect(() => {
    void saveUserListsIdb(activeProfileId, savedItems);
  }, [activeProfileId, savedItems]);

  // Header and Catalog Section Titles
  const getCatalogTitles = () => {
    if (tab === 'list') {
      const typeLabel =
        selectedType === 'movie'
          ? 'film'
          : selectedType === 'tv'
          ? 'dizi'
          : 'içerik (film + dizi)';
      const statusTitles: Record<string, { title: string; count: number }> = {
        all: { title: 'Tüm takip listem', count: allListCount },
        watching: { title: 'Şu an izlediklerim', count: watchingCount },
        watchlist: { title: 'İzlenecekler listem', count: watchlistCount },
        completed: { title: 'Tamamladıklarım', count: completedCount },
        upcoming: { title: 'Yaklaşan yayınlar', count: upcomingCount },
        actors: { title: 'Favori oyuncularım', count: favoriteActors.length },
        disliked: { title: 'İlgilenmediğim içerikler', count: preferences.disliked.length },
      };
      const info = statusTitles[listStatus] || statusTitles.all;
      if (listStatus === 'actors') {
        return {
          title: `${info.title} (${info.count})`,
          description: `Takip ettiğin ${info.count} favori oyuncu ve senin için kişiselleştirilmiş film & dizi önerileri`,
        };
      }
      return {
        title: `${info.title} (${info.count})`,
        description: `Listenizde toplam ${info.count} kayıtlı ${typeLabel} bulunuyor`,
      };
    }
    if (query) {
      return {
        title: `"${query}" için arama sonuçları`,
        description: 'Sonuçlar doğrudan TMDB arama servisinden alınır',
      };
    }
    const catMap: Record<string, { title: string; description: string }> = {
      trending: { title: 'Güncel trendler', description: 'TMDB\'den canlı olarak yükleniyor' },
      'for-you': {
        title: forYouSubTab === 'series' ? 'Sana özel · Seriler' : 'Sana özel',
        description:
          forYouSubTab === 'series'
            ? 'Listenizdeki film ve dizilerin aynı evrendeki diğer halkaları ve devam yapımları'
            : forYouExplanation ||
              (selectedGenre && genresMap[Number(selectedGenre)]
                ? `${genresMap[Number(selectedGenre)]} türünde zevk profiline göre oluşturulan 20 öneri`
                : selectedType === 'movie'
                ? 'Film izleme geçmişin ve kişisel puanlarından oluşturulan 20 film önerisi'
                : selectedType === 'tv'
                ? 'Dizi izleme geçmişin ve kişisel puanlarından oluşturulan 20 dizi önerisi'
                : 'İzleme listen ve kişisel puanlarından oluşturulan 20 öneri'),
      },
      gems: {
        title: 'Keşfedilmemiş mücevherler',
        description: 'Yüksek puanlı, daha az popüler ve keşfedilmeyi bekleyen film ve diziler',
      },
      upcoming: { title: 'Yakında ve yayında', description: 'Yaklaşan filmler ve yayındaki diziler' },
      'popular-movies': { title: 'Popüler filmler', description: 'TMDB\'de en çok ilgi gören filmler' },
      'popular-tv': { title: 'Popüler diziler', description: 'TMDB\'de en çok ilgi gören diziler' },
      'top-rated': { title: 'Yüksek puanlı filmler', description: 'TMDB puanına göre sıralanır' },
      stock: {
        title: `Keşfet — ${stockStats.movieCount} Film · ${stockStats.tvCount} Dizi`,
        description: 'Listenizde olmayan, çevrimdışı erişime hazır kişisel aday havuzu ve zevk vektörü sıralaması',
      },
    };
    return catMap[category] || catMap.trending;
  };

  const { title: catalogTitle, description: catalogDescription } = getCatalogTitles();

  // Profile Management
  const handleSaveProfileName = (newName: string) => {
    setProfileName(newName);
    setProfiles((prev) =>
      prev.map((p) => (p.id === activeProfileId ? { ...p, name: newName } : p))
    );
    showToast('Profil kaydedildi.');
  };

  const handleSwitchProfile = (newId: string) => {
    if (newId === activeProfileId) return;
    const outgoingId = activeProfileId;
    const outgoingDeleted = normalizeDeletedKeys(deletedKeysRef.current);
    const updatedProfiles = profiles.map((p) =>
      p.id === outgoingId
        ? {
            ...p,
            name: profileName,
            items: savedItems,
            preferences,
            favoriteActors: favoriteActorsRef.current || [],
            ...(Object.keys(outgoingDeleted).length > 0 ? { deleted_keys: outgoingDeleted } : {}),
          }
        : p
    );
    profilesRef.current = updatedProfiles;
    setProfiles(updatedProfiles);
    persistProfilesBestEffort(updatedProfiles);

    setActiveProfileId(newId);
    activeProfileIdRef.current = newId;
    const target = updatedProfiles.find((p) => p.id === newId);
    const nextName = target?.name || 'Profilim';
    profileNameRef.current = nextName;
    setProfileName(nextName);
    const items = target?.items?.length ? target.items : loadProfileItems(newId);
    savedItemsRef.current = items;
    setSavedItems(items);
    const nextPrefs =
      target?.preferences &&
      ((target.preferences.disliked?.length || 0) > 0 ||
        (target.preferences.hidden?.length || 0) > 0 ||
        (target.preferences.providers?.length || 0) > 0 ||
        Boolean(target.preferences.mood) ||
        Boolean(target.preferences.reminders))
        ? target.preferences
        : loadProfilePreferences(newId);
    preferencesRef.current = nextPrefs;
    setPreferences(nextPrefs);
    const favs = target?.favoriteActors?.length ? target.favoriteActors : loadFavoriteActors(newId);
    favoriteActorsRef.current = favs;
    setFavoriteActors(favs);
    const targetDeleted = normalizeDeletedKeys(target?.deleted_keys || loadDeletedKeys(newId));
    deletedKeysRef.current = targetDeleted;
    setDeletedKeys(targetDeleted);
    const nextTasteMap = loadPersistentTasteMap(newId);
    tasteMapRef.current = nextTasteMap;
    setTasteMap(nextTasteMap);
    lastForYouQueryKeyRef.current = '';
    setForYouItems([]);
    setForYouReasons(new Map());
    setQuery('');
    setProfileOpen(false);
  };

  const handleCreateProfile = (name: string, isDemo = false) => {
    const outgoingId = activeProfileId;
    const outgoingDeleted = normalizeDeletedKeys(deletedKeysRef.current);
    const newId = `profile-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const newProf: Profile = {
      id: newId,
      name,
      createdAt: new Date().toISOString(),
      preferences: { disliked: [], providers: [], mood: '', reminders: false, notified: [] },
      items: [],
      favoriteActors: [],
      isDemo,
    };
    const nextProfiles = [
      ...profiles.map((p) =>
        p.id === outgoingId
          ? {
              ...p,
              name: profileName,
              items: savedItems,
              preferences,
              favoriteActors: favoriteActorsRef.current || [],
              ...(Object.keys(outgoingDeleted).length > 0 ? { deleted_keys: outgoingDeleted } : {}),
            }
          : p
      ),
      newProf,
    ];
    profilesRef.current = nextProfiles;
    setProfiles(nextProfiles);
    persistProfilesBestEffort(nextProfiles);

    setActiveProfileId(newId);
    activeProfileIdRef.current = newId;
    profileNameRef.current = name;
    setProfileName(name);
    savedItemsRef.current = [];
    setSavedItems([]);
    preferencesRef.current = newProf.preferences;
    setPreferences(newProf.preferences);
    favoriteActorsRef.current = [];
    setFavoriteActors([]);
    deletedKeysRef.current = {};
    setDeletedKeys({});
    const nextTasteMap = loadPersistentTasteMap(newId);
    tasteMapRef.current = nextTasteMap;
    setTasteMap(nextTasteMap);
    lastForYouQueryKeyRef.current = '';
    setForYouItems([]);
    setForYouReasons(new Map());
    setProfileOpen(false);
    showToast(`"${name}" profili oluşturuldu.`);
  };

  const handleSavePreferences = (providers: string[], mood: string) => {
    setPreferences((prev) => ({
      ...prev,
      providers,
      mood,
    }));
    showToast('Tercihler kaydedildi.');
  };

  const handleToggleReminders = async () => {
    if (preferences.reminders) {
      setPreferences((prev) => ({ ...prev, reminders: false }));
      showToast('Yayın hatırlatıcıları kapatıldı.');
      return;
    }
    if (!('Notification' in window)) {
      showToast('Bu tarayıcı bildirimleri desteklemiyor.');
      return;
    }
    try {
      const permission = await Notification.requestPermission();
      if (permission === 'granted') {
        setPreferences((prev) => ({ ...prev, reminders: true }));
        showToast('Yayın hatırlatıcıları etkinleştirildi.');
        checkReleaseReminders();
      } else {
        showToast('Bildirim izni verilmedi.');
      }
    } catch {
      showToast('Bildirim izni alınamadı.');
    }
  };

  const handleToggleDemoMode = () => {
    const nextState = !activeProfile?.isDemo;
    setProfiles((prev) =>
      prev.map((p) => (p.id === activeProfileId ? { ...p, isDemo: nextState } : p))
    );
    showToast(
      nextState
        ? 'Profil Demo moduna alındı (Örnek havuz kullanılır).'
        : 'Profil Canlı moda alındı (Kişisel verileriniz kullanılır).'
    );
  };

  // Export / Import
  const handleExportBackup = () => {
    const exportedKunye = mergeCinemaKunyeDocumentsLossless(
      cinemaKunye,
      extractCinemaKunyeFromItems(savedItems, genresMap)
    );
    const enrichedExportItems = enrichSavedItemsFromCinemaKunye(savedItems, exportedKunye);
    const backup = {
      version: 3,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      engineVersion: ENGINE_VERSION,
      profileId: activeProfileId,
      profileName,
      items: enrichedExportItems,
      cinemaKunye: exportedKunye,
      preferences,
      favoriteActors: favoriteActorsRef.current,
      isDemo: Boolean(activeProfile?.isDemo),
      exportedAt: new Date().toISOString(),
    };
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `cinetrack-local-backup-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const handleImportBackupFile = async (file: File) => {
    try {
      const text = await file.text();
      const parsed = parseBackupText(text);
      setPendingBackup(parsed);
    } catch (err: any) {
      showToast(err.message || 'Yedek dosyası okunamadı.');
    }
  };

  const handleConfirmImport = (mode: 'overwrite' | 'merge') => {
    if (!pendingBackup) return;
    if (mode === 'overwrite') {
      confirmNextBulkSyncRef.current = true;
    }

    const effectiveKunye =
      mode === 'merge'
        ? mergeIncomingCinemaKunye(pendingBackup.cinemaKunye)
        : replaceCinemaKunye(pendingBackup.cinemaKunye);

    const rawImportedItems =
      mode === 'merge'
        ? mergeSavedItemListsLossless(savedItems, pendingBackup.items, activeProfileId)
        : dedupeItems(pendingBackup.items);
    const importedItems = enrichSavedItemsFromCinemaKunye(rawImportedItems, effectiveKunye);

    savedItemsRef.current = importedItems;
    setSavedItems(importedItems);
    lastForYouQueryKeyRef.current = '';
    setForYouItems([]);
    if (pendingBackup.profileName) {
      handleSaveProfileName(pendingBackup.profileName);
    }
    if (pendingBackup.preferences) {
      setPreferences((prev) => ({
        ...prev,
        ...pendingBackup.preferences,
        disliked:
          mode === 'merge'
            ? Array.from(new Set([...(prev.disliked || []), ...(pendingBackup.preferences.disliked || [])]))
            : pendingBackup.preferences.disliked || [],
        hidden:
          mode === 'merge'
            ? Array.from(new Set([...(prev.hidden || []), ...(pendingBackup.preferences.hidden || [])]))
            : pendingBackup.preferences.hidden || [],
        providers:
          mode === 'merge'
            ? Array.from(new Set([...(prev.providers || []), ...(pendingBackup.preferences.providers || [])]))
            : pendingBackup.preferences.providers || [],
        reminders: false,
        notified: [],
      }));
    }
    const importedActors =
      mode === 'merge'
        ? normalizeFavoriteActors([...favoriteActors, ...(pendingBackup.favoriteActors || [])])
        : normalizeFavoriteActors(pendingBackup.favoriteActors || []);
    setFavoriteActors(importedActors);
    try {
      localStorage.setItem(favActorsStorageKey(activeProfileId), JSON.stringify(importedActors));
    } catch {}

    if (pendingBackup.isDemo !== undefined) {
      setProfiles((prev) =>
        prev.map((p) => (p.id === activeProfileId ? { ...p, isDemo: pendingBackup.isDemo } : p))
      );
    }

    setPendingBackup(null);
    setProfileOpen(false);
    showToast(`Yedek başarıyla içe aktarıldı (${importedItems.length} içerik)!`);
  };

  const handleEmptyAction = (act: string) => {
    switch (act) {
      case 'clear-search':
        handleSearchClear();
        break;
      case 'clear-filters':
        setSelectedGenre('');
        setSelectedType('all');
        setHideListedItems(false);
        break;
      case 'trending':
        setQuery('');
        setCategory('trending');
        break;
      case 'all-items':
        setListStatus('all');
        break;
      case 'discover':
        setTab('discover');
        break;
    }
  };

  return (
    <>
      <OfflineIndicator
        isOnline={isOnline}
        pendingSync={pendingSync}
        unpersistedWarning={unpersistedWarning}
      />
      <Header
        profileName={profileName}
        query={query}
        tab={tab}
        onTabChange={setTab}
        myListCount={allListCount}
        onSearchChange={setQuery}
        onSearchSubmit={handleSearchSubmit}
        onSearchClear={handleSearchClear}
        onOpenProfile={() => setProfileOpen(true)}
        onOpenAdd={() => setAddCustomOpen(true)}
        onSelectItem={(item) => setDetailItem(item)}
        getSaved={(item) => findSavedItem(savedItems, item)}
        tmdbSource={tmdbSourceMeta.source}
        tmdbStaleReason={tmdbSourceMeta.staleReason}
        onOpenTvdbStock={() => setTvdbModalOpen(true)}
      />
      <ConflictBanner
        conflict={serverConflict}
        onMergeBoth={handleMergeBothOnConflict}
        onKeepLocal={handleKeepLocalOnConflict}
        onUseServer={handleUseServerOnConflict}
        onDismiss={() => setServerConflict(null)}
      />

      <main className="shell">
        {tab === 'discover' && !query && (
          <Hero
            heroItem={currentHeroItem}
            featuredItems={featuredHeroItems}
            isWatching={Boolean(watchingItem)}
            onOpenDetails={(item) => setDetailItem(item)}
          />
        )}

        {tab === 'list' && (
          <Stats
            items={savedItems}
            profileName={profileName}
            favoriteActors={favoriteActors}
            genresMap={genresMap}
            cinemaKunye={cinemaKunye}
            onSelectItem={(id, mediaType) => {
              const found = findSavedItem(savedItems, { id, media_type: mediaType });
              setDetailItem(found || { id, media_type: mediaType });
            }}
            onMergeDuplicates={handleMergeDuplicates}
          />
        )}

        <Controls
          tab={tab}
          onTabChange={setTab}
          myListCount={allListCount}
          upcomingCount={upcomingCount}
          dislikedCount={preferences.disliked.length}
          favoriteActorsCount={favoriteActors.length}
          watchingCount={watchingCount}
          watchlistCount={watchlistCount}
          completedCount={completedCount}
          genres={genresMap}
          selectedGenre={selectedGenre}
          onGenreChange={handleSelectGenre}
          selectedType={selectedType}
          onTypeChange={handleSelectType}
          selectedCategory={category}
          onCategoryChange={setCategory}
          isSearchActive={Boolean(query.trim())}
          selectedSort={selectedSort}
          onSortChange={setSelectedSort}
          selectedProvider={selectedProvider}
          onProviderChange={setSelectedProvider}
          listStatus={listStatus}
          onListStatusChange={setListStatus}
          hideListedItems={hideListedItems}
          onHideListedItemsChange={setHideListedItems}
          stockStats={stockStats}
          onReplenishStock={handleManualStockReplenish}
          isStockReplenishing={stockEngineState.isReplenishing}
          onOpenTvdbStock={() => setTvdbModalOpen(true)}
        />

        {tab === 'relationships' ? (
          <ErrorBoundary sectionName="İlişki Keşfi">
            <Suspense
              fallback={
                <div className="lazy-tab-fallback" role="status">
                  İlişki Keşfi görünümü yükleniyor…
                </div>
              }
            >
              <RelationshipExplorer
                key={`${activeProfileId}-relationships`}
                mode="relationships"
                profileId={activeProfileId}
                savedItems={savedItems}
                preferences={preferences}
                candidates={[]}
                favoriteActors={favoriteActors}
                genreNames={genresMap}
                onRefresh={handleLoadRelationshipCandidates}
                onOpenDetails={(item) => setDetailItem(item as SavedItem)}
                onQuickSave={(item) => setQuickSaveItem(item as SavedItem)}
                initialSourceKey={relationshipInitialSourceKey}
              />
            </Suspense>
          </ErrorBoundary>
        ) : tab === 'taste-map' ? (
          <div className="taste-map-page">
            <div className="taste-map-view-toggle" role="group" aria-label="Zevk haritası görünüm modu">
              <button
                className={`btn ${tasteMapDisplayMode === 'identity' ? 'btn-primary' : ''}`}
                type="button"
                onClick={() => setTasteMapDisplayMode('identity')}
                aria-pressed={tasteMapDisplayMode === 'identity'}
              >
                Sinema Kimliğim
              </button>
              <button
                className={`btn ${tasteMapDisplayMode === 'poster' ? 'btn-primary' : ''}`}
                type="button"
                onClick={() => setTasteMapDisplayMode('poster')}
                aria-pressed={tasteMapDisplayMode === 'poster'}
              >
                Poster Duvarı
              </button>
              <button
                className={`btn ${tasteMapDisplayMode === 'graph' ? 'btn-primary' : ''}`}
                type="button"
                onClick={() => setTasteMapDisplayMode('graph')}
                aria-pressed={tasteMapDisplayMode === 'graph'}
              >
                Zevk Ağı (Grafik)
              </button>
            </div>

            <ErrorBoundary sectionName="Zevk Haritası">
              <Suspense
                fallback={
                  <div className="lazy-tab-fallback" role="status">
                    Zevk Haritası yükleniyor…
                  </div>
                }
              >
                {tasteMapDisplayMode === 'poster' ? (
                  <TasteMapView
                    tasteMap={tasteMap}
                    summary={tasteSummary}
                    genresMap={genresMap}
                    savedItems={savedItems}
                    onOpenDetails={(item) => setDetailItem(item)}
                    onQuickSave={(item) => setQuickSaveItem(item)}
                    onSetStatus={(item, status) => handleSetStatus(item, status)}
                    onToggleDislike={(key) => handleToggleDislike(key)}
                    onRefreshTasteMap={handleRefreshTasteMap}
                    isLoading={isLoading}
                    isDemo={Boolean(activeProfile?.isDemo)}
                    tmdbSource={tmdbSourceMeta.source}
                    tmdbStaleReason={tmdbSourceMeta.staleReason}
                  />
                ) : tasteMapDisplayMode === 'identity' ? (
                  <TasteProfileDashboard />
                ) : (
                  <RelationshipExplorer
                    key={`${activeProfileId}-taste-map`}
                    mode="taste-map"
                    profileId={activeProfileId}
                    savedItems={savedItems}
                    preferences={preferences}
                    candidates={[]}
                    favoriteActors={favoriteActors}
                    genreNames={genresMap}
                    onRefresh={handleLoadRelationshipCandidates}
                    onOpenDetails={(item) => setDetailItem(item as SavedItem)}
                    onQuickSave={(item) => setQuickSaveItem(item as SavedItem)}
                  />
                )}
              </Suspense>
            </ErrorBoundary>
          </div>
        ) : (
          <ErrorBoundary sectionName="Katalog ve Listem">
            <MediaGrid
              title={catalogTitle}
              description={catalogDescription}
              isLoading={category === 'for-you' && forYouSubTab === 'series' && !query.trim() ? false : isLoading}
              loadingMore={loadingMore}
              items={displayedItems}
              savedItems={savedItems}
              genres={genresMap}
              recommendationReasons={
                category === 'for-you'
                  ? forYouSubTab === 'series' && !query.trim()
                    ? seriesUniverseData.reasonsMap
                    : forYouReasons
                  : EMPTY_REASONS_MAP
              }
              dislikedKeys={preferences.disliked}
              preferredProviders={preferences.providers}
              tab={tab}
              query={query}
              listStatus={listStatus}
              category={category}
              page={catalogPage}
              totalPages={catalogTotalPages}
              hasMore={tab === 'discover' && category !== 'for-you' && catalogPage < catalogTotalPages}
              favoriteActors={favoriteActors}
              onLoadMore={handleLoadMore}
              onOpenDetails={(item) => setDetailItem(item)}
              onQuickAdd={handleQuickAdd}
              onSetStatus={handleSetStatus}
              onQuickSave={(item) => setQuickSaveItem(item)}
              onToggleDislike={handleToggleDislike}
              onEmptyAction={handleEmptyAction}
              onOpenPerson={(id, name) => {
                setPersonId(id);
                setPersonName(name);
              }}
              onToggleFavoriteActor={handleToggleFavoriteActor}
              onRefreshForYou={handleRefreshForYou}
              forYouProgressStep={forYouProgressStep}
              tmdbSource={tmdbSourceMeta.source}
              tmdbStaleReason={tmdbSourceMeta.staleReason}
              selectedType={selectedType}
              onTypeChange={handleSelectType}
              selectedGenre={selectedGenre}
              onGenreChange={handleSelectGenre}
              selectedSort={selectedSort}
              onSortChange={setSelectedSort}
              forYouSubTab={forYouSubTab}
              onForYouSubTabChange={setForYouSubTab}
              seriesCount={seriesUniverseData.universesCount}
              hiddenKeys={preferences.hidden}
              mood={preferences.mood}
              isDemo={Boolean(activeProfile?.isDemo)}
              onIncrementEpisode={handleIncrementTvEpisode}
              stockStats={stockStats}
              isStockReplenishing={stockEngineState.isReplenishing}
              stockReplenishError={stockEngineState.lastError}
              onReplenishStock={handleManualStockReplenish}
              onOpenAddCustom={() => setAddCustomOpen(true)}
            />
          </ErrorBoundary>
        )}
      </main>

      <footer>
        <div className="shell footer-shell">
          <div>
            Cinethos | Kişisel listen bu tarayıcıda saklanır. Katalog kaynağı:{' '}
            <a
              href="https://www.themoviedb.org/"
              target="_blank"
              rel="noopener noreferrer"
              className="footer-link"
            >
              The Movie Database (TMDB)
            </a>
            .
          </div>
          <div className="footer-source-status">
            <span>Veri Durumu:</span>{' '}
            <strong>
              {tmdbSourceMeta.source === 'live'
                ? 'Canlı TMDB API'
                : tmdbSourceMeta.source === 'stale-cache'
                ? 'Eski Önbellek (Offline)'
                : tmdbSourceMeta.source === 'demo'
                ? 'Örnek Katalog'
                : 'Bağlantı Bekleniyor'}
            </strong>
          </div>
          <div className="footer-shortcuts-hint">
            <span>Kısayollar: </span>
            <kbd className="footer-kbd">1-4</kbd> Sekmeler ·{' '}
            <kbd className="footer-kbd">/</kbd> Ara ·{' '}
            <kbd className="footer-kbd">S</kbd> Eşitle ·{' '}
            <kbd className="footer-kbd">N</kbd> Ekle ·{' '}
            <kbd className="footer-kbd">Esc</kbd> Kapat
          </div>
        </div>
      </footer>

      {/* Mobil 56px sticky alt tab bar (v6 spec Section 2.2 / 5) */}
      <nav className="mobile-tab-bar" aria-label="Mobil Gezinme">
        <button
          type="button"
          className={`mobile-tab-btn ${tab === 'discover' ? 'active' : ''}`}
          onClick={() => setTab('discover')}
          aria-label="Keşfet"
        >
          <svg className="icon" aria-hidden="true"><use href="#icon-film" /></svg>
          <span className="mobile-tab-label">Keşfet</span>
        </button>

        <button
          type="button"
          className={`mobile-tab-btn ${tab === 'list' ? 'active' : ''}`}
          onClick={() => setTab('list')}
          aria-label="Listem"
        >
          <span className="mobile-tab-icon-wrap">
            <svg className="icon" aria-hidden="true"><use href="#icon-bookmark" /></svg>
            {allListCount > 0 && (
              <span className="mobile-tab-badge">{allListCount > 99 ? '99+' : allListCount}</span>
            )}
          </span>
          <span className="mobile-tab-label">Listem</span>
        </button>

        <button
          type="button"
          className={`mobile-tab-btn ${tab === 'taste-map' ? 'active' : ''}`}
          onClick={() => setTab('taste-map')}
          aria-label="Zevkim"
        >
          <svg className="icon" aria-hidden="true"><use href="#icon-dna" /></svg>
          <span className="mobile-tab-label">Zevkim</span>
        </button>

        <button
          type="button"
          className={`mobile-tab-btn ${tab === 'relationships' ? 'active' : ''}`}
          onClick={() => setTab('relationships')}
          aria-label="İlişkiler"
        >
          <svg className="icon" aria-hidden="true"><use href="#icon-network" /></svg>
          <span className="mobile-tab-label">İlişkiler</span>
        </button>
      </nav>

      {/* Modals & Drawers */}
      <DetailModal
        item={detailItem}
        savedItem={detailItem ? findSavedItem(savedItems, detailItem) : undefined}
        savedItems={savedItems}
        isOpen={Boolean(detailItem)}
        genresMap={genresMap}
        isDisliked={
          detailItem
            ? preferences.disliked.includes(
                `${detailItem.media_type || (detailItem.title ? 'movie' : 'tv')}:${detailItem.id}`
              )
            : false
        }
        isHidden={
          detailItem
            ? Boolean(
                preferences.hidden?.includes(
                  `${detailItem.media_type || (detailItem.title ? 'movie' : 'tv')}:${detailItem.id}`
                )
              )
            : false
        }
        favoriteActors={favoriteActors}
        onClose={() => setDetailItem(null)}
        onSave={handleSaveItem}
        onRemove={handleRemoveItem}
        onToggleDislike={handleToggleDislike}
        onToggleHide={handleToggleHide}
        onToggleFavoriteActor={handleToggleFavoriteActor}
        onSelectMedia={(next) => setDetailItem(next)}
        onOpenPerson={(id, name) => {
          setPersonId(id);
          setPersonName(name);
        }}
      />

      <QuickSaveModal
        item={quickSaveItem}
        savedItem={quickSaveItem ? findSavedItem(savedItems, quickSaveItem) : undefined}
        isOpen={Boolean(quickSaveItem)}
        onClose={() => setQuickSaveItem(null)}
        onSave={(item, status, rating) => {
          handleSaveItem(item, status, rating);
          showToast(`✓ "${displayTitle(item)}" listenize kaydedildi!`);
        }}
        onRemove={handleRemoveItem}
      />

      <PersonDrawer
        personId={personId}
        personName={personName}
        profileId={activeProfileId}
        isOpen={Boolean(personId)}
        savedItems={savedItems}
        isFavoriteActor={favoriteActors.some((a) => a.id === personId)}
        onClose={() => setPersonId(null)}
        onOpenDetails={(item) => setDetailItem(item)}
        onQuickAdd={handleQuickAdd}
        onMarkCompleted={handleMarkCompleted}
        onQuickSave={(item) => setQuickSaveItem(item)}
        onToggleFavoriteActor={handleToggleFavoriteActor}
        onOpenInRelationships={(mediaKey) => {
          setPersonId(null);
          setRelationshipInitialSourceKey(mediaKey);
          setTab('relationships');
        }}
      />

      <AddCustomModal
        isOpen={addCustomOpen}
        onClose={() => setAddCustomOpen(false)}
        onAdd={(item, status) => {
          handleSaveItem(item, status, '');
          showToast(`✓ "${item.title}" listenize eklendi!`);
        }}
      />

      <ProfileModal
        isOpen={profileOpen}
        profiles={profiles}
        activeProfile={activeProfile}
        activeProfileId={activeProfileId}
        activeProfileName={profileName}
        preferences={preferences}
        savedItems={savedItems}
        favoriteActors={favoriteActors}
        dislikedItems={dislikedItems}
        genresMap={genresMap}
        cinemaKunye={cinemaKunye}
        tasteEntries={tasteMap.entries}
        syncStatus={syncStatus}
        onClose={() => setProfileOpen(false)}
        onSaveProfileName={handleSaveProfileName}
        onSwitchProfile={handleSwitchProfile}
        onCreateProfile={handleCreateProfile}
        onSavePreferences={handleSavePreferences}
        onToggleReminders={handleToggleReminders}
        onExportBackup={handleExportBackup}
        onImportBackupFile={handleImportBackupFile}
        onImportCsvItems={(items, importedKunye) => {
          const effectiveKunye = importedKunye
            ? mergeIncomingCinemaKunye(importedKunye)
            : cinemaKunye;
          const merged = enrichSavedItemsFromCinemaKunye(
            mergeSavedItemListsLossless(savedItems, items, activeProfileId),
            effectiveKunye
          );
          savedItemsRef.current = merged;
          setSavedItems(merged);
          void recordProfileChangeAndMaybeBackup();
          showToast(`${items.length} yapım CSV'den listenize kayıpsız birleştirildi.`);
        }}
        onApplyRestoredDocument={(doc) => {
          applyDataDocumentToState(doc);
          void refreshCinemaKunyeFromServer('merge');
          showToast('Sunucu yedeği başarıyla geri yüklendi.');
        }}
        onBeforeSyncFlush={async () => {
          await Promise.all([pushToServer(), flushCinemaKunyeToServer()]);
        }}
        onMergeSyncedDocument={(doc) => {
          handleMergeSyncedDocument(doc);
          void refreshCinemaKunyeFromServer('merge');
        }}
        onCinemaKunyeSynced={(syncMode) => {
          void refreshCinemaKunyeFromServer(syncMode);
        }}
        onMergeDuplicates={handleMergeDuplicates}
        isDemo={Boolean(activeProfile?.isDemo)}
        onToggleDemoMode={handleToggleDemoMode}
      />

      <ImportChoiceModal
        isOpen={Boolean(pendingBackup)}
        onClose={() => setPendingBackup(null)}
        onConfirm={handleConfirmImport}
      />

      <TvdbStockModal
        isOpen={tvdbModalOpen}
        onClose={() => setTvdbModalOpen(false)}
        onStockMutated={() => {
          if (category === 'stock') {
            loadCategoryResults('stock', 1, false, '', selectedProvider, false, selectedType, selectedGenre);
          }
          showToast('✓ Stok başarıyla güncellendi!');
        }}
      />

      <Toast message={toastMessage} />
    </>
  );
}
export default App;
