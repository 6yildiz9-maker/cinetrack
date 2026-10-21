import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Header } from './components/Header';
import { Hero } from './components/Hero';
import { Stats } from './components/Stats';
import { Controls } from './components/Controls';
import { MediaGrid } from './components/MediaGrid';
import { DetailModal } from './components/DetailModal';
import { QuickSaveModal } from './components/QuickSaveModal';
import { PersonDrawer } from './components/PersonDrawer';
import { AddCustomModal } from './components/AddCustomModal';
import { ProfileModal } from './components/ProfileModal';
import { ImportChoiceModal } from './components/ImportChoiceModal';
import { Toast } from './components/Toast';

import {
  SavedItem,
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
  buildTasteProfile,
  scoreCandidates,
  diversifyList,
  createCandidatePool,
  parseBackupText,
  buildSeasonCounts,
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
} from './core/cinetrack-core';
import { fetchTmdb, fetchTmdbCached, fetchServerData, pushServerData } from './services/api';
import { dateYearsAgo, displayTitle, mapLimit, MOOD_GENRES, MOOD_LABELS } from './utils/helpers';

const PROFILES_STORAGE = 'cinetrack.profiles.v1';
const ACTIVE_PROFILE_STORAGE = 'cinetrack.activeProfile.v1';
const PROFILE_STORAGE = 'cinetrack.profile.v1';
const LIST_STORAGE = 'cinetrack.watchlist.v1';
const DIRTY_KEY = 'cinetrack.dirty.v2';

function listStorageKey(profileId: string) {
  return `cinetrack.profile.${profileId}.watchlist.v1`;
}
function preferencesStorageKey(profileId: string) {
  return `cinetrack.profile.${profileId}.preferences.v1`;
}

function loadInitialProfiles(): Profile[] {
  try {
    const stored = JSON.parse(localStorage.getItem(PROFILES_STORAGE) || 'null');
    const profiles = Array.isArray(stored)
      ? stored
          .filter((p) => p && /^profile-[A-Za-z0-9_-]{1,60}$/.test(p.id) && typeof p.name === 'string')
          .map((p) => ({
            id: p.id,
            name: p.name.slice(0, 40),
            createdAt: p.createdAt || '',
            preferences: { disliked: [], providers: [], mood: '', reminders: false, notified: [] },
            items: [],
          }))
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

function loadFavoriteActors(profileId: string): any[] {
  try {
    const stored = localStorage.getItem(favActorsStorageKey(profileId));
    return stored ? JSON.parse(stored) : [];
  } catch {
    return [];
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
  const [favoriteActors, setFavoriteActors] = useState<any[]>(() => loadFavoriteActors(activeProfileId));
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
  const [tab, setTab] = useState<'discover' | 'list'>('discover');
  const [category, setCategory] = useState<string>('trending');
  const [listStatus, setListStatus] = useState<string>('all');
  const [query, setQuery] = useState<string>('');
  const [selectedGenre, setSelectedGenre] = useState<string>('');
  const [selectedType, setSelectedType] = useState<string>('all');
  const [selectedSort, setSelectedSort] = useState<string>('popular');
  const [selectedProvider, setSelectedProvider] = useState<string>('');
  const [genresMap, setGenresMap] = useState<Record<number, string>>({});

  const [catalogItems, setCatalogItems] = useState<any[]>([]);
  const [trendingTop, setTrendingTop] = useState<any | null>(null);
  const [catalogPage, setCatalogPage] = useState<number>(1);
  const [catalogTotalPages, setCatalogTotalPages] = useState<number>(1);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [loadingMore, setLoadingMore] = useState<boolean>(false);
  const [recommendationReasons, setRecommendationReasons] = useState<Map<string, string>>(new Map());
  const [forYouItems, setForYouItems] = useState<any[]>([]);
  const [forYouReasons, setForYouReasons] = useState<Map<string, string>>(new Map());
  const [forYouExplanation, setForYouExplanation] = useState<string>('');
  const [serverSyncReady, setServerSyncReady] = useState(false);

  const [detailItem, setDetailItem] = useState<any | null>(null);
  const [quickSaveItem, setQuickSaveItem] = useState<any | null>(null);
  const [personId, setPersonId] = useState<number | null>(null);
  const [personName, setPersonName] = useState<string>('');
  const [addCustomOpen, setAddCustomOpen] = useState<boolean>(false);
  const [profileOpen, setProfileOpen] = useState<boolean>(false);
  const [pendingBackup, setPendingBackup] = useState<any | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const requestGateRef = useRef(createRequestGate());
  const toastTimerRef = useRef<any>(null);
  const lastForYouTypeRef = useRef<string>('all');
  const selectedTypeRef = useRef<string>(selectedType);
  selectedTypeRef.current = selectedType;
  const initialLocalSnapshotRef = useRef<string | null>(null);
  const localEditedDuringStartupRef = useRef(false);
  const localWasDirtyRef = useRef<boolean | null>(null);
  if (localWasDirtyRef.current === null) {
    localWasDirtyRef.current = localStorage.getItem(DIRTY_KEY) === '1';
  }
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
  const currentLocalSnapshot = JSON.stringify({
    profiles,
    activeProfileId,
    profileName,
    preferences,
    savedItems,
    favoriteActors,
  });
  if (initialLocalSnapshotRef.current === null) {
    initialLocalSnapshotRef.current = currentLocalSnapshot;
  }

  const showToast = useCallback((msg: string) => {
    setToastMessage(msg);
    clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToastMessage(null), 7000);
  }, []);

  // Sync to localStorage
  useEffect(() => {
    try {
      localStorage.setItem(PROFILES_STORAGE, JSON.stringify(profiles));
      localStorage.setItem(ACTIVE_PROFILE_STORAGE, activeProfileId);
      localStorage.setItem(PROFILE_STORAGE, profileName);
      localStorage.setItem(listStorageKey(activeProfileId), JSON.stringify(savedItems));
      localStorage.setItem(preferencesStorageKey(activeProfileId), JSON.stringify(preferences));
      localStorage.setItem(favActorsStorageKey(activeProfileId), JSON.stringify(favoriteActors));
      if (serverSyncReady) {
        localStorage.setItem(DIRTY_KEY, '1');
      } else if (currentLocalSnapshot !== initialLocalSnapshotRef.current) {
        localEditedDuringStartupRef.current = true;
      }
    } catch (err) {
      console.warn('LocalStorage save error:', err);
    }
  }, [
    profiles,
    activeProfileId,
    profileName,
    savedItems,
    preferences,
    favoriteActors,
    serverSyncReady,
    currentLocalSnapshot,
  ]);

  // Push server data on changes
  const pushToServer = useCallback(async () => {
    const payload: DataDocument = {
      version: 3,
      activeProfileId,
      profiles: profiles.map((p) => ({
        id: p.id,
        name: p.id === activeProfileId ? profileName : p.name,
        createdAt: p.createdAt || '',
        preferences: p.id === activeProfileId ? preferences : loadProfilePreferences(p.id),
        items: p.id === activeProfileId ? savedItems : loadProfileItems(p.id),
      })),
    };
    const ok = await pushServerData(payload);
    if (ok) {
      localStorage.removeItem(DIRTY_KEY);
      setSyncStatus('Kayıt yeri: data/cinetrack-data.json (bu bilgisayarda, tüm profiller).');
    } else {
      setSyncStatus('Değişiklikler yerel veri dosyasına yazılamadı; şimdilik yalnızca bu tarayıcıda.');
    }
  }, [profiles, activeProfileId, profileName, preferences, savedItems]);

  useEffect(() => {
    if (!serverSyncReady) return;
    const timer = setTimeout(() => {
      pushToServer();
    }, 500);
    return () => clearTimeout(timer);
  }, [pushToServer, serverSyncReady]);

  // Initial startup sync with server & load genres
  useEffect(() => {
    fetchServerData()
      .then((remote) => {
        if (remote) {
          const doc = normalizeDataDocument(remote);
          if (doc) {
            const remoteHasData = doc.profiles.some((p) => p.items.length > 0) || doc.profiles.length > 1;
            const isDirty = localWasDirtyRef.current || localEditedDuringStartupRef.current;
            if (remoteHasData && !isDirty) {
              setProfiles(doc.profiles);
              setActiveProfileId(doc.activeProfileId);
              const active = doc.profiles.find((p) => p.id === doc.activeProfileId) || doc.profiles[0];
              setProfileName(active.name);
              setPreferences(active.preferences);
              setSavedItems(active.items);
            }
          }
        }
      })
      .catch((error) => console.error('CineTrack: başlangıç verisi eşitlenemedi.', error))
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
  }, []);

  // Release Reminders check
  const checkReleaseReminders = useCallback(() => {
    if (!preferences.reminders || !('Notification' in window) || Notification.permission !== 'granted') {
      return;
    }
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    for (const item of savedItems) {
      if (item.status === 'completed') continue;
      const airDate = resolveAirDate(item);
      if (!airDate) continue;
      const days = reminderDaysUntil(airDate, today);
      if (days === null) continue;
      const key = `${item.media_type}:${item.id}:${airDate}`;
      if (preferences.notified.includes(key)) continue;

      const next = item.next_episode_to_air;
      const episodeTag =
        item.media_type === 'tv' && next?.air_date === airDate && next.season_number
          ? ` (S${next.season_number}B${next.episode_number})`
          : '';
      const when = days === 0 ? 'bugün' : `${days} gün içinde`;

      const notification = new Notification('CineTrack yayın hatırlatıcısı', {
        body: `${displayTitle(item)} ${when} yayınlanıyor${episodeTag}.`,
      });
      notification.onclick = () => {
        window.focus();
        setDetailItem(item);
        notification.close();
      };

      setPreferences((prev) => ({
        ...prev,
        notified: [...prev.notified.slice(-199), key],
      }));
    }
  }, [preferences, savedItems]);

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

  // Load Catalog Data (Trending, For-You, Gems, Upcoming, etc.)
  const loadCategoryResults = useCallback(
    async (
      cat: string,
      p = 1,
      append = false,
      currentQuery = query,
      provider = selectedProvider,
      forceRefresh = false,
      typeFilter?: string
    ) => {
      const ticket = requestGateRef.current.begin();
      if (!append) {
        setIsLoading(true);
        setCatalogPage(1);
      } else {
        setLoadingMore(true);
      }

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
          setCatalogItems((prev) => (append ? [...prev, ...items] : items));
          setCatalogTotalPages(res.total_pages || 1);
          setCatalogPage(p);
          return;
        }

        if (provider && cat !== 'for-you') {
          const [movies, tvs] = await Promise.all([
            fetchTmdb(
              '/discover/movie',
              { with_watch_providers: provider, watch_region: 'TR', sort_by: 'popularity.desc', page: String(p) },
              ticket.signal
            ),
            fetchTmdb(
              '/discover/tv',
              { with_watch_providers: provider, watch_region: 'TR', sort_by: 'popularity.desc', page: String(p) },
              ticket.signal
            ),
          ]);
          if (!requestGateRef.current.isCurrent(ticket.id)) return;
          const combined = [
            ...(movies.results || []).map((m: any) => ({ ...m, media_type: 'movie' })),
            ...(tvs.results || []).map((t: any) => ({ ...t, media_type: 'tv' })),
          ];
          setCatalogItems((prev) => (append ? [...prev, ...combined] : combined));
          setCatalogTotalPages(Math.max(movies.total_pages || 1, tvs.total_pages || 1));
          setCatalogPage(p);
          return;
        }

        if (cat === 'for-you') {
          const effectiveType = typeFilter || selectedTypeRef.current || 'all';
          const targetType = effectiveType === 'movie' || effectiveType === 'tv' ? effectiveType : 'all';

          // If already loaded for the current type and not explicitly force-refreshed, reuse cached recommendations
          if (forYouItems.length > 0 && !forceRefresh && lastForYouTypeRef.current === targetType) {
            setIsLoading(false);
            return;
          }
          lastForYouTypeRef.current = targetType;

          const rawSaved = savedItemsRef.current;
          const currentPrefs = preferencesRef.current;
          const currentGenres = genresMapRef.current;

          // Film önerisi istendiğinde dizi geçmişini ilgi profili hesabının dışında bırak; yalnızca film geçmişini ve film tercihlerini değerlendir.
          const currentSaved = filterHistoryByType(rawSaved, targetType);
          const currentDislikedKeys = filterDislikedByType(currentPrefs.disliked, targetType);

          // Sana Özel v3:
          // Watched & Completed items have highest importance (2.5x / 1.6x)
          // Watchlist items have auxiliary influence (0.35x)
          const watchedSeeds = currentSaved
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
            .slice(0, 10);

          const watchlistSeeds = currentSaved
            .filter(
              (item) =>
                item.status === 'watchlist' &&
                (item.personal_rating === '' || Number(item.personal_rating) < 7)
            )
            .slice(0, 4);

          const seeds = [...watchedSeeds, ...watchlistSeeds];
          const moodGenres = MOOD_GENRES[currentPrefs.mood] || [];
          const dislikedSeeds = currentDislikedKeys
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

          // Build Taste Profile V3 with smoothing lambda = 1 and time decay
          const tasteProfile = buildTasteProfileV3(
            [
              ...currentSaved.map((item) => creditsByKey.get(makeMediaKey(item)) || item),
              ...dislikedSeeds.map((item) => creditsByKey.get(makeMediaKey(item)) || item),
            ],
            {
              lambda: 1,
              dislikedKeys: currentDislikedKeys,
            }
          );

          // Candidate Pool with strict allowedMediaType restriction at ingestion level
          const pool = createCandidatePool({ maxItems: 600, allowedMediaType: targetType });
          const isCandidateEligible = (item: any, defaultMediaType?: string) => {
            const itemType = item.media_type || defaultMediaType || (item.title ? 'movie' : 'tv');
            if (targetType !== 'all' && itemType !== targetType) return false;
            const itemKey = makeMediaKey(itemType, item.id);
            if (currentPrefs.disliked.includes(itemKey)) return false;
            if (isItemSaved(rawSaved, item, itemType)) return false;
            return true;
          };

          const TARGET_COUNT = TARGET_RECOMMENDATION_COUNT; // 20

          // AŞAMA 1: Birincil Kişiselleştirilmiş Adaylar (Sıkı Eşikler)
          const st1Requests: any[] = [];
          for (const seed of watchedSeeds.slice(0, 8)) {
            st1Requests.push({
              path: `/${seed.media_type}/${seed.id}/recommendations`,
              mediaType: seed.media_type,
              reason: `İzlediğin “${displayTitle(seed)}” yapımına benzer`,
              seedSourceType: seed.status === 'completed' ? 'completed' : 'watching',
            });
          }

          for (const seed of watchlistSeeds) {
            st1Requests.push({
              path: `/${seed.media_type}/${seed.id}/recommendations`,
              mediaType: seed.media_type,
              reason: `İzleme listendeki “${displayTitle(seed)}” benzeri`,
              seedSourceType: 'watchlist',
            });
          }

          // Discover by top liked genres and mood (vote_count >= 80, vote_average >= 6.5)
          const likedGenreIds = tasteProfile.positiveGenres.slice(0, 4);
          const primaryGenreIds = [...new Set([...likedGenreIds, ...moodGenres.map(String)])];
          for (const gid of primaryGenreIds) {
            const label = currentGenres[Number(gid)] || '';
            const reason =
              moodGenres.includes(Number(gid)) && !likedGenreIds.includes(gid)
                ? `${MOOD_LABELS[currentPrefs.mood] || ''} ruh hâline uygun seçkiler`.trim()
                : label
                ? `${label} türünü sevdiğin için`
                : 'Sevdiğin türlerden seçmeler';

            if (targetType === 'all' || targetType === 'movie') {
              st1Requests.push({
                path: '/discover/movie',
                params: { with_genres: gid, sort_by: 'popularity.desc', 'vote_count.gte': '80', 'vote_average.gte': '6.5' },
                mediaType: 'movie',
                reason,
              });
            }
            if (targetType === 'all' || targetType === 'tv') {
              st1Requests.push({
                path: '/discover/tv',
                params: { with_genres: gid, sort_by: 'popularity.desc', 'vote_count.gte': '80', 'vote_average.gte': '6.5' },
                mediaType: 'tv',
                reason,
              });
            }
          }

          await mapLimit(st1Requests, 5, async (req) => {
            try {
              const res = await fetchTmdbCached(req.path, req.params || {}, ticket.signal);
              const acceptable = (res?.results || []).filter((item: any) => isCandidateEligible(item, req.mediaType));
              pool.add(req.path, req.reason, req.mediaType, acceptable, req.seedSourceType || '');
            } catch {}
          });
          if (!requestGateRef.current.isCurrent(ticket.id)) return;

          let currentStage = 1;
          const getValidCandidates = () =>
            pool.list().filter((c) => isCandidateEligible(c));

          let candidates = getValidCandidates();
          let quickScored = scoreCandidatesV3(candidates, tasteProfile, {
            weights: RECOMMENDATION_WEIGHTS_V3,
            genreNames: currentGenres,
            mood: currentPrefs.mood,
          });
          let quickPicked = diversifyList(quickScored, { limit: TARGET_COUNT, maxPerGenre: 5 });

          // AŞAMA 2: Sonuç 20'den azsa tür, benzerlik ve oyuncu eşiklerini gevşet
          if (quickPicked.length < TARGET_COUNT) {
            currentStage = 2;
            const st2Requests: any[] = [];

            // 1. Watched seeds similar endpoint
            for (const seed of watchedSeeds) {
              st2Requests.push({
                path: `/${seed.media_type}/${seed.id}/similar`,
                mediaType: seed.media_type,
                reason: `“${displayTitle(seed)}” tarzında yapımlar`,
                seedSourceType: seed.status === 'completed' ? 'completed' : 'watching',
              });
            }

            // 2. Discover across secondary positive genres with relaxed quality (vote_count >= 35, vote_average >= 5.8)
            const secondaryGenres = tasteProfile.positiveGenres.slice(0, 8);
            for (const gid of secondaryGenres) {
              const label = currentGenres[Number(gid)] || '';
              const reason = label ? `${label} türünde keşifler` : 'Keşif seçkileri';
              if (targetType === 'all' || targetType === 'movie') {
                st2Requests.push({
                  path: '/discover/movie',
                  params: { with_genres: gid, sort_by: 'popularity.desc', 'vote_count.gte': '35', 'vote_average.gte': '5.8' },
                  mediaType: 'movie',
                  reason,
                });
              }
              if (targetType === 'all' || targetType === 'tv') {
                st2Requests.push({
                  path: '/discover/tv',
                  params: { with_genres: gid, sort_by: 'popularity.desc', 'vote_count.gte': '35', 'vote_average.gte': '5.8' },
                  mediaType: 'tv',
                  reason,
                });
              }
            }

            // 3. Favorite actors discovery if any
            const favoriteActorsList = favoriteActorsRef.current || [];
            for (const actor of favoriteActorsList.slice(0, 3)) {
              if (targetType === 'all' || targetType === 'movie') {
                st2Requests.push({
                  path: '/discover/movie',
                  params: { with_cast: String(actor.id), sort_by: 'popularity.desc' },
                  mediaType: 'movie',
                  reason: `Favori oyuncun ${actor.name} kadrosunda`,
                });
              }
              if (targetType === 'all' || targetType === 'tv') {
                st2Requests.push({
                  path: '/discover/tv',
                  params: { with_cast: String(actor.id), sort_by: 'popularity.desc' },
                  mediaType: 'tv',
                  reason: `Favori oyuncun ${actor.name} kadrosunda`,
                });
              }
            }

            await mapLimit(st2Requests, 5, async (req) => {
              try {
                const res = await fetchTmdbCached(req.path, req.params || {}, ticket.signal);
                const acceptable = (res?.results || []).filter((item: any) => isCandidateEligible(item, req.mediaType));
                pool.add(req.path, req.reason, req.mediaType, acceptable, req.seedSourceType || '');
              } catch {}
            });
            if (!requestGateRef.current.isCurrent(ticket.id)) return;

            candidates = getValidCandidates();
            quickScored = scoreCandidatesV3(candidates, tasteProfile, {
              weights: RECOMMENDATION_WEIGHTS_V3,
              genreNames: currentGenres,
              mood: currentPrefs.mood,
            });
            quickPicked = diversifyList(quickScored, { limit: TARGET_COUNT, maxPerGenre: 7 });
          }

          // AŞAMA 3: Hâlâ 20'den azsa kalite, tarih ve popülerlik eşiklerini gevşet
          if (quickPicked.length < TARGET_COUNT) {
            currentStage = 3;
            const st3Requests: any[] = [];

            if (targetType === 'all' || targetType === 'movie') {
              st3Requests.push(
                { path: '/movie/popular', params: { page: '1' }, mediaType: 'movie', reason: 'Popüler filmler arasından' },
                { path: '/movie/popular', params: { page: '2' }, mediaType: 'movie', reason: 'Popüler filmler arasından' },
                { path: '/movie/top_rated', params: { page: '1' }, mediaType: 'movie', reason: 'Klasik ve yüksek puanlı filmler' },
                { path: '/trending/movie/week', params: {}, mediaType: 'movie', reason: 'Bu haftanın trend filmleri' }
              );
            }
            if (targetType === 'all' || targetType === 'tv') {
              st3Requests.push(
                { path: '/tv/popular', params: { page: '1' }, mediaType: 'tv', reason: 'Popüler diziler arasından' },
                { path: '/tv/popular', params: { page: '2' }, mediaType: 'tv', reason: 'Popüler diziler arasından' },
                { path: '/tv/top_rated', params: { page: '1' }, mediaType: 'tv', reason: 'Yüksek puanlı diziler' },
                { path: '/trending/tv/week', params: {}, mediaType: 'tv', reason: 'Bu haftanın trend dizileri' }
              );
            }

            await mapLimit(st3Requests, 4, async (req) => {
              try {
                const res = await fetchTmdbCached(req.path, req.params || {}, ticket.signal);
                const acceptable = (res?.results || []).filter((item: any) => isCandidateEligible(item, req.mediaType));
                pool.add(req.path, req.reason, req.mediaType, acceptable);
              } catch {}
            });
            if (!requestGateRef.current.isCurrent(ticket.id)) return;
          }

          // Kesin tür filtresi ve ilk sıralama (tür filtresi puanlama ve çeşitlendirmeden önce devreye girer)
          candidates = getValidCandidates();
          let scored = scoreCandidatesV3(candidates, tasteProfile, {
            weights: RECOMMENDATION_WEIGHTS_V3,
            genreNames: currentGenres,
            mood: currentPrefs.mood,
          });
          scored.sort((a, b) => b.score - a.score);

          // En yüksek puanlı adayları (ilk 40) detay ve kadro bilgisiyle zenginleştir
          const shortlist = scored.slice(0, 40);
          await mapLimit(shortlist, 5, async (entry) => {
            try {
              const details = await fetchTmdbCached(
                `/${entry.candidate.media_type}/${entry.candidate.id}`,
                { append_to_response: 'credits' },
                ticket.signal
              );
              Object.assign(entry.candidate, {
                overview: entry.candidate.overview || details?.overview || '',
                belongs_to_collection: details?.belongs_to_collection || null,
                production_companies: details?.production_companies || [],
                cast: (details?.credits?.cast || []).slice(0, 8),
                crew: (details?.credits?.crew || []).filter(
                  (m: any) => m.job === 'Director' || m.job === 'Creator'
                ),
              });
            } catch {}
          });
          if (!requestGateRef.current.isCurrent(ticket.id)) return;

          // Derin zenginleştirilmiş nihai puanlama
          scored = scoreCandidatesV3(
            shortlist.map((e) => e.candidate),
            tasteProfile,
            {
              weights: RECOMMENDATION_WEIGHTS_V3,
              genreNames: currentGenres,
              mood: currentPrefs.mood,
            }
          );

          // Kullanıcının listesinde bulunan veya disliked kayıtları makeMediaKey ile kesin dışla
          scored = scored.filter(
            (entry) =>
              !isItemSaved(rawSaved, entry.candidate) &&
              !currentPrefs.disliked.includes(makeMediaKey(entry.candidate))
          );
          scored.sort((a, b) => b.score - a.score);

          // Çeşitlendirme ve hedef sayı (20) garantisi
          const genreLimit = currentStage === 1 ? 5 : currentStage === 2 ? 7 : 10;
          let picked = diversifyList(scored, { limit: TARGET_COUNT, maxPerGenre: genreLimit });
          if (picked.length < TARGET_COUNT && scored.length > picked.length) {
            // Sonuç azsa tür tavanını gevşeterek 20 hedefine ulaş
            picked = diversifyList(scored, { limit: TARGET_COUNT, maxPerGenre: TARGET_COUNT });
          }

          // Kullanıcıya aşamalı genişleme ve kalan sonuç sayısını açıklama
          const finalCount = picked.length;
          const typeWord = targetType === 'movie' ? 'film' : targetType === 'tv' ? 'dizi' : 'içerik';
          let explanationText = '';
          if (finalCount >= TARGET_COUNT) {
            if (currentStage === 1) {
              explanationText = `Zevk profiline ve izleme geçmişine göre ${finalCount} ${typeWord} önerisi hazırlandı.`;
            } else if (currentStage === 2) {
              explanationText = `Profiline tam uyan ${typeWord} sayısı sınırlı olduğundan tür ve benzerlik eşikleri genişletilerek ${finalCount} ${typeWord} önerisi hazırlandı.`;
            } else {
              explanationText = `Kriterlerine uygun ${typeWord} sayısı sınırlı olduğu için tür, kalite ve popülerlik eşikleri kademeli genişletilerek ${finalCount} ${typeWord} önerisi hazırlandı.`;
            }
          } else if (finalCount > 0) {
            explanationText = `Listen ve tercihlerine uygun ${finalCount} ${typeWord} bulundu. Kriterler, tür ve keşif havuzları aşamalı genişletilmesine rağmen kalan sonuç sayısı bu kadardır.`;
          } else {
            explanationText = `Henüz ${typeWord} önerisi üretilemedi. Listenize birkaç yapım ekleyerek önerileri zenginleştirebilirsiniz.`;
          }

          setForYouExplanation(explanationText);

          const reasonsMap = new Map<string, string>();
          picked.forEach((entry) => {
            reasonsMap.set(makeMediaKey(entry.candidate), entry.tags.join(' · '));
          });

          setForYouReasons(reasonsMap);
          setForYouItems(
            picked.map((e) => ({
              ...e.candidate,
              matchScore: Math.max(1, Math.min(100, Math.round(Number(e.score) || 75))),
            }))
          );
          setCatalogTotalPages(1);
          setCatalogPage(1);
          if (forceRefresh) showToast(explanationText);
          return;
        }

        if (cat === 'gems') {
          const cutoffDate = dateYearsAgo(15);
          const common = {
            'vote_average.gte': '7',
            'vote_count.gte': '200',
            'vote_count.lte': '3000',
            sort_by: 'popularity.asc',
            page: String(p),
          };
          const [movies, tvs] = await Promise.all([
            fetchTmdb('/discover/movie', { ...common, 'primary_release_date.gte': cutoffDate }, ticket.signal),
            fetchTmdb('/discover/tv', { ...common, 'first_air_date.gte': cutoffDate }, ticket.signal),
          ]);
          if (!requestGateRef.current.isCurrent(ticket.id)) return;
          const combined = [
            ...(movies.results || []).map((m: any) => ({ ...m, media_type: 'movie' })),
            ...(tvs.results || []).map((t: any) => ({ ...t, media_type: 'tv' })),
          ];
          setCatalogItems((prev) => (append ? [...prev, ...combined] : combined));
          setCatalogTotalPages(Math.max(movies.total_pages || 1, tvs.total_pages || 1));
          setCatalogPage(p);
          return;
        }

        if (cat === 'upcoming') {
          const [movies, tvs] = await Promise.all([
            fetchTmdb('/movie/upcoming', { page: String(p) }, ticket.signal),
            fetchTmdb('/tv/on_the_air', { page: String(p) }, ticket.signal),
          ]);
          if (!requestGateRef.current.isCurrent(ticket.id)) return;
          const combined = [
            ...(movies.results || []).map((m: any) => ({ ...m, media_type: 'movie' })),
            ...(tvs.results || []).map((t: any) => ({ ...t, media_type: 'tv' })),
          ];
          setCatalogItems((prev) => (append ? [...prev, ...combined] : combined));
          setCatalogTotalPages(Math.max(movies.total_pages || 1, tvs.total_pages || 1));
          setCatalogPage(p);
          return;
        }

        const endpointMap: Record<string, string> = {
          trending: '/trending/all/day',
          'popular-movies': '/movie/popular',
          'popular-tv': '/tv/popular',
          'top-rated': '/movie/top_rated',
        };
        const endpoint = endpointMap[cat] || '/trending/all/day';
        const res = await fetchTmdb(endpoint, { page: String(p) }, ticket.signal);
        if (!requestGateRef.current.isCurrent(ticket.id)) return;

        const defaultType = endpoint.startsWith('/movie')
          ? 'movie'
          : endpoint.startsWith('/tv')
          ? 'tv'
          : '';
        const items = (res.results || []).map((item: any) =>
          item.media_type ? item : { ...item, media_type: defaultType || (item.title ? 'movie' : 'tv') }
        );

        if (cat === 'trending' && !append && items[0]) {
          setTrendingTop(items[0]);
        }
        setCatalogItems((prev) => (append ? [...prev, ...items] : items));
        setCatalogTotalPages(res.total_pages || 1);
        setCatalogPage(p);
      } catch (err: any) {
        if (!ticket.signal.aborted) {
          console.warn('Catalog load error:', err.message);
          if (forceRefresh) showToast('Öneriler yenilenemedi. Lütfen tekrar deneyin.');
          if (!append) setCatalogItems([]);
        }
      } finally {
        if (requestGateRef.current.isCurrent(ticket.id)) {
          setIsLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [query, selectedProvider, showToast]
  );

  const handleRefreshForYou = useCallback(() => {
    loadCategoryResults('for-you', 1, false, '', selectedProvider, true, selectedType);
  }, [loadCategoryResults, selectedProvider, selectedType]);

  const handleSelectType = useCallback(
    (newType: string) => {
      setSelectedType(newType);
      selectedTypeRef.current = newType;
      if (tab === 'discover' && category === 'for-you') {
        loadCategoryResults('for-you', 1, false, query, selectedProvider, false, newType);
      }
    },
    [tab, category, query, selectedProvider, loadCategoryResults]
  );

  useEffect(() => {
    if (tab === 'discover') {
      if (category === 'for-you') {
        if (lastForYouTypeRef.current === selectedType && forYouItems.length > 0) {
          return;
        }
        lastForYouTypeRef.current = selectedType;
        loadCategoryResults(category, 1, false, query, selectedProvider, false, selectedType);
        return;
      }
      loadCategoryResults(category, 1, false, query, selectedProvider);
    }
  }, [tab, category, query, selectedProvider, selectedType, loadCategoryResults, forYouItems.length]);

  // Load more pagination
  const handleLoadMore = () => {
    if (tab === 'discover' && category !== 'for-you' && catalogPage < catalogTotalPages) {
      loadCategoryResults(category, catalogPage + 1, true, query, selectedProvider);
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

  // Saved items CRUD
  const handleSaveItem = (
    item: any,
    status: 'watching' | 'watchlist' | 'completed',
    personalRating: number | '',
    tracking: any = {}
  ) => {
    const mediaType = item.media_type || (item.title ? 'movie' : 'tv');
    const targetId = String(item.id);
    const targetTitle = (item.title || item.name || '').trim().toLowerCase();
    const existing = savedItemsRef.current.find(
      (entry) =>
        (String(entry.id) === targetId && entry.media_type === mediaType) ||
        String(entry.id) === targetId ||
        (Boolean(targetTitle) && (entry.title || '').trim().toLowerCase() === targetTitle)
    );
    const normalized = normalizeSavedItem({
      ...item,
      media_type: mediaType,
      ...tracking,
      status,
      personal_rating: personalRating || '',
      personal_rating_cleared: Boolean(existing && !personalRating && existing.personal_rating !== ''),
      addedAt: existing ? existing.addedAt : new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    if (!normalized) return;

    const itemKey = makeMediaKey(mediaType, targetId);
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

    const title = displayTitle(item);
    if (status === 'completed') {
      showToast(`✓ "${title}" izlendi listesine kaydedildi! 🎉`);
    } else if (status === 'watching') {
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

  const handleQuickAdd = (item: any) => {
    handleSaveItem(item, 'watchlist', '');
    showToast(`✓ "${displayTitle(item)}" izlenecekler listesine eklendi! ✨`);
  };

  const handleMarkCompleted = (item: any) => {
    handleSaveItem(item, 'completed', '');
    showToast(`✓ "${displayTitle(item)}" izlendi listesine eklendi! 🎉`);
  };

  const handleSetStatus = (item: any, status: 'watching' | 'watchlist' | 'completed') => {
    handleSaveItem(item, status, '');
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
    setFavoriteActors((prev) => {
      const exists = prev.some((a) => a.id === actor.id);
      if (exists) {
        showToast(`"${actor.name}" favori oyuncularınızdan çıkarıldı.`);
        return prev.filter((a) => a.id !== actor.id);
      } else {
        showToast(`❤️ "${actor.name}" favori oyuncularınıza eklendi!`);
        return [
          {
            id: actor.id,
            name: actor.name,
            profile_path: actor.profile_path || '',
            character: actor.character || '',
          },
          ...prev,
        ];
      }
    });
  };

  const handleRemoveItem = (item: any) => {
    const itemKey = makeMediaKey(item);
    const mediaType = item.media_type || (item.title ? 'movie' : 'tv');
    const targetTitle = (item.title || item.name || '').trim().toLowerCase();
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
      return { ...prev, disliked };
    });
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
      if (selectedGenre && !(item.genre_ids || []).includes(Number(selectedGenre))) return false;
      return true;
    });

    if (selectedSort === 'rating') {
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

  const getDisplayedItems = () => {
    if (tab === 'discover') {
      const source = category === 'for-you' ? forYouItems : catalogItems;
      const filtered = source.filter((item) => {
        const itemType = item.media_type || (item.title ? 'movie' : 'tv');
        const key = makeMediaKey(itemType, item.id);
        if (preferences.disliked.includes(key)) return false;

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

  // Hero Item
  const watchingItem = savedItems.find((item) => item.status === 'watching') || null;
  const currentHeroItem = watchingItem || trendingTop || catalogItems[0] || null;

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
        title: 'Sana özel',
        description:
          forYouExplanation ||
          (selectedType === 'movie'
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
    setActiveProfileId(newId);
    const target = profiles.find((p) => p.id === newId);
    setProfileName(target?.name || 'Profilim');
    setSavedItems(loadProfileItems(newId));
    setPreferences(loadProfilePreferences(newId));
    setFavoriteActors(loadFavoriteActors(newId));
    setForYouItems([]);
    setForYouReasons(new Map());
    setQuery('');
    setProfileOpen(false);
  };

  const handleCreateProfile = (name: string) => {
    const newId = `profile-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const newProf: Profile = {
      id: newId,
      name,
      createdAt: new Date().toISOString(),
      preferences: { disliked: [], providers: [], mood: '', reminders: false, notified: [] },
      items: [],
    };
    setProfiles((prev) => [...prev, newProf]);
    setActiveProfileId(newId);
    setProfileName(name);
    setSavedItems([]);
    setPreferences(newProf.preferences);
    setFavoriteActors([]);
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

  // Export / Import
  const handleExportBackup = () => {
    const backup = {
      version: 2,
      profileId: activeProfileId,
      profileName,
      items: savedItems,
      preferences,
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
    const importedItems =
      mode === 'merge' ? dedupeItems([...savedItems, ...pendingBackup.items]) : pendingBackup.items;
    setSavedItems(importedItems);
    if (pendingBackup.profileName) {
      handleSaveProfileName(pendingBackup.profileName);
    }
    if (pendingBackup.preferences) {
      setPreferences((prev) => ({
        ...prev,
        ...pendingBackup.preferences,
        reminders: false,
        notified: [],
      }));
    }
    setPendingBackup(null);
    setProfileOpen(false);
    showToast('Yedek başarıyla içe aktarıldı!');
  };

  const handleEmptyAction = (act: string) => {
    switch (act) {
      case 'clear-search':
        handleSearchClear();
        break;
      case 'clear-filters':
        setSelectedGenre('');
        setSelectedType('all');
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
      <Header
        profileName={profileName}
        query={query}
        onSearchChange={setQuery}
        onSearchSubmit={handleSearchSubmit}
        onSearchClear={handleSearchClear}
        onOpenProfile={() => setProfileOpen(true)}
        onOpenAdd={() => setAddCustomOpen(true)}
        onSelectItem={(item) => setDetailItem(item)}
        getSaved={(item) => findSavedItem(savedItems, item)}
      />

      <main className="shell">
        <Hero
          heroItem={currentHeroItem}
          isWatching={Boolean(watchingItem)}
          onOpenDetails={(item) => setDetailItem(item)}
        />

        <Stats items={savedItems} />

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
          onGenreChange={setSelectedGenre}
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
        />

        <MediaGrid
          title={catalogTitle}
          description={catalogDescription}
          isLoading={isLoading}
          loadingMore={loadingMore}
          items={displayedItems}
          savedItems={savedItems}
          genres={genresMap}
          recommendationReasons={category === 'for-you' ? forYouReasons : recommendationReasons}
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
        />
      </main>

      <footer>
        <div className="shell">
          CineTrack | Kişisel listen bu tarayıcıda saklanır. Katalog kaynağı:{' '}
          <a
            href="https://www.themoviedb.org/"
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: '#94a3b8' }}
          >
            The Movie Database (TMDB)
          </a>
          .
        </div>
      </footer>

      {/* Modals & Drawers */}
      <DetailModal
        item={detailItem}
        savedItem={detailItem ? findSavedItem(savedItems, detailItem) : undefined}
        isOpen={Boolean(detailItem)}
        genresMap={genresMap}
        isDisliked={
          detailItem
            ? preferences.disliked.includes(
                `${detailItem.media_type || (detailItem.title ? 'movie' : 'tv')}:${detailItem.id}`
              )
            : false
        }
        favoriteActors={favoriteActors}
        onClose={() => setDetailItem(null)}
        onSave={handleSaveItem}
        onRemove={handleRemoveItem}
        onToggleDislike={handleToggleDislike}
        onToggleFavoriteActor={handleToggleFavoriteActor}
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
        isOpen={Boolean(personId)}
        savedItems={savedItems}
        isFavoriteActor={favoriteActors.some((a) => a.id === personId)}
        onClose={() => setPersonId(null)}
        onOpenDetails={(item) => setDetailItem(item)}
        onQuickAdd={handleQuickAdd}
        onMarkCompleted={handleMarkCompleted}
        onQuickSave={(item) => setQuickSaveItem(item)}
        onToggleFavoriteActor={handleToggleFavoriteActor}
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
        activeProfileId={activeProfileId}
        activeProfileName={profileName}
        preferences={preferences}
        savedItems={savedItems}
        genresMap={genresMap}
        syncStatus={syncStatus}
        onClose={() => setProfileOpen(false)}
        onSaveProfileName={handleSaveProfileName}
        onSwitchProfile={handleSwitchProfile}
        onCreateProfile={handleCreateProfile}
        onSavePreferences={handleSavePreferences}
        onToggleReminders={handleToggleReminders}
        onExportBackup={handleExportBackup}
        onImportBackupFile={handleImportBackupFile}
      />

      <ImportChoiceModal
        isOpen={Boolean(pendingBackup)}
        onClose={() => setPendingBackup(null)}
        onConfirm={handleConfirmImport}
      />

      <Toast message={toastMessage} />
    </>
  );
}
export default App;
