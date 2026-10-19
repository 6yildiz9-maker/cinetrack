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

  // Active Modals & Drawer State
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
      localStorage.setItem(DIRTY_KEY, '1');
    } catch (err) {
      console.warn('LocalStorage save error:', err);
    }
  }, [profiles, activeProfileId, profileName, savedItems, preferences, favoriteActors]);

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
    const timer = setTimeout(() => {
      pushToServer();
    }, 500);
    return () => clearTimeout(timer);
  }, [pushToServer]);

  // Initial startup sync with server & load genres
  useEffect(() => {
    fetchServerData().then((remote) => {
      if (remote) {
        const doc = normalizeDataDocument(remote);
        if (doc) {
          const remoteHasData = doc.profiles.some((p) => p.items.length > 0) || doc.profiles.length > 1;
          const isDirty = localStorage.getItem(DIRTY_KEY) === '1';
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
    });

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
    async (cat: string, p = 1, append = false, currentQuery = query, provider = selectedProvider) => {
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

        if (provider) {
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
          // Multistage Personalized Recommendation Engine:
          // Watched/Completed items have the strongest influence on recommendations
          // Watchlist items have a lighter, auxiliary influence
          const watchedSeeds = savedItems
            .filter((item) => item.status === 'completed' || item.status === 'watching' || Number(item.personal_rating) >= 7)
            .sort(
              (a, b) =>
                Number(b.personal_rating || (b.status === 'completed' ? 7 : 5)) -
                Number(a.personal_rating || (a.status === 'completed' ? 7 : 5))
            )
            .slice(0, 10);

          // Watchlist items have gentle secondary influence
          const watchlistSeeds = savedItems
            .filter((item) => item.status === 'watchlist' && (item.personal_rating === '' || Number(item.personal_rating) < 7))
            .slice(0, 3);

          const seeds = [...watchedSeeds, ...watchlistSeeds];

          const moodGenres = MOOD_GENRES[preferences.mood] || [];
          const historyCredits = await mapLimit(seeds, 4, async (seed) => {
            try {
              const details = await fetchTmdbCached(
                `/${seed.media_type}/${seed.id}`,
                { append_to_response: 'credits' },
                ticket.signal
              );
              return {
                ...seed,
                cast: (details?.credits?.cast || []).slice(0, 8),
                crew: (details?.credits?.crew || []).filter(
                  (m: any) => m.job === 'Director' || m.job === 'Creator'
                ),
              };
            } catch {
              return { ...seed, cast: [], crew: [] };
            }
          });
          if (!requestGateRef.current.isCurrent(ticket.id)) return;

          const creditsByKey = new Map(
            historyCredits.map((entry) => [`${entry.media_type}:${entry.id}`, entry])
          );
          const tasteProfile = buildTasteProfile(
            savedItems.map((item) => creditsByKey.get(`${item.media_type}:${item.id}`) || item),
            {
              includeWatchlist: true,
              completedMultiplier: 2.5, // Watched items have 2.5x higher contribution
              watchingMultiplier: 1.6,  // Watching items have 1.6x contribution
              watchlistMultiplier: 0.35, // Watchlist items have gentle 0.35x contribution
            }
          );

          const pool = createCandidatePool();
          const isSaved = (item: any, type: string) =>
            savedItems.some((s) => s.id === item.id && s.media_type === type);

          const candidateRequests: any[] = [];
          for (const seed of watchedSeeds) {
            candidateRequests.push({
              path: `/${seed.media_type}/${seed.id}/recommendations`,
              mediaType: seed.media_type,
              reason: `İzlediğin “${displayTitle(seed)}” yapımına benzer`,
              seedSourceType: seed.status === 'completed' ? 'completed' : 'watching',
            });
            candidateRequests.push({
              path: `/${seed.media_type}/${seed.id}/similar`,
              mediaType: seed.media_type,
              reason: `İzlediğin “${displayTitle(seed)}” yapımına benzer`,
              seedSourceType: seed.status === 'completed' ? 'completed' : 'watching',
            });
          }

          for (const seed of watchlistSeeds) {
            candidateRequests.push({
              path: `/${seed.media_type}/${seed.id}/recommendations`,
              mediaType: seed.media_type,
              reason: `İzleme listendeki “${displayTitle(seed)}” benzeri (Hafif etki)`,
              seedSourceType: 'watchlist',
            });
          }

          const likedGenreIds = Object.entries(tasteProfile.genres)
            .filter(([, score]) => score > 0)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 3)
            .map(([id]) => id);

          const allGenreIds = [...new Set([...likedGenreIds, ...moodGenres.map(String)])];
          for (const gid of allGenreIds) {
            const label = genresMap[Number(gid)] || '';
            const reason =
              moodGenres.includes(Number(gid)) && !likedGenreIds.includes(gid)
                ? `${MOOD_LABELS[preferences.mood] || ''} ruh hâline uygun seçkiler`.trim()
                : label
                ? `${label} türünü sevdiğin için`
                : 'Sevdiğin türlerden seçmeler';
            candidateRequests.push({
              path: '/discover/movie',
              params: { with_genres: gid, sort_by: 'popularity.desc', 'vote_count.gte': '100', 'vote_average.gte': '6' },
              mediaType: 'movie',
              reason,
              seedSourceType: 'completed',
            });
            candidateRequests.push({
              path: '/discover/tv',
              params: { with_genres: gid, sort_by: 'popularity.desc', 'vote_count.gte': '100', 'vote_average.gte': '6' },
              mediaType: 'tv',
              reason,
              seedSourceType: 'completed',
            });
          }

          await mapLimit(candidateRequests.slice(0, 18), 5, async (req) => {
            try {
              const res = await fetchTmdbCached(req.path, req.params || {}, ticket.signal);
              const acceptable = (res?.results || []).filter(
                (item: any) =>
                  !preferences.disliked.includes(`${req.mediaType}:${item.id}`) &&
                  !isSaved(item, req.mediaType)
              );
              pool.add(req.path, req.reason, req.mediaType, acceptable, req.seedSourceType || '');
            } catch {}
          });

          if (pool.size < 40) {
            const fallbacks = [
              { path: '/movie/popular', mediaType: 'movie', reason: 'Popüler filmler arasından' },
              { path: '/tv/popular', mediaType: 'tv', reason: 'Popüler diziler arasından' },
              { path: '/trending/all/day', mediaType: '', reason: 'Bugün trend olan yapımlar' },
            ];
            await mapLimit(fallbacks, 3, async (req) => {
              try {
                const res = await fetchTmdbCached(req.path, {}, ticket.signal);
                const acceptable = (res?.results || []).filter(
                  (item: any) =>
                    !preferences.disliked.includes(`${item.media_type || req.mediaType}:${item.id}`) &&
                    !isSaved(item, item.media_type || req.mediaType)
                );
                pool.add(req.path, req.reason, req.mediaType, acceptable);
              } catch {}
            });
          }
          if (!requestGateRef.current.isCurrent(ticket.id)) return;

          let scored = scoreCandidates(pool.list(), tasteProfile, {
            preferredProviders: preferences.providers,
            genreNames: genresMap,
          });
          scored.sort((a, b) => b.score - a.score);

          const shortlist = scored.slice(0, 40);
          await mapLimit(shortlist, 5, async (entry) => {
            try {
              const details = await fetchTmdbCached(
                `/${entry.candidate.media_type}/${entry.candidate.id}`,
                { append_to_response: 'credits' },
                ticket.signal
              );
              Object.assign(entry.candidate, {
                cast: (details?.credits?.cast || []).slice(0, 8),
                crew: (details?.credits?.crew || []).filter(
                  (m: any) => m.job === 'Director' || m.job === 'Creator'
                ),
              });
            } catch {}
          });
          if (!requestGateRef.current.isCurrent(ticket.id)) return;

          scored = scoreCandidates(
            shortlist.map((e) => e.candidate),
            tasteProfile,
            { preferredProviders: preferences.providers, genreNames: genresMap }
          );
          scored.sort((a, b) => b.score - a.score);
          const picked = diversifyList(scored, { limit: 24, maxPerGenre: 6 });

          const reasonsMap = new Map<string, string>();
          picked.forEach((entry) => {
            reasonsMap.set(`${entry.candidate.media_type}:${entry.candidate.id}`, entry.tags.join(' · '));
          });
          setRecommendationReasons(reasonsMap);
          setCatalogItems(picked.map((e) => e.candidate));
          setCatalogTotalPages(1);
          setCatalogPage(1);
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
          if (!append) setCatalogItems([]);
        }
      } finally {
        if (requestGateRef.current.isCurrent(ticket.id)) {
          setIsLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [savedItems, preferences, genresMap, query, selectedProvider]
  );

  useEffect(() => {
    if (tab === 'discover') {
      loadCategoryResults(category, 1, false, query, selectedProvider);
    }
  }, [tab, category, query, selectedProvider, loadCategoryResults]);

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
    const existingIndex = savedItems.findIndex(
      (entry) => entry.id === item.id && entry.media_type === item.media_type
    );
    const prev = existingIndex >= 0 ? savedItems[existingIndex] : null;
    const normalized = normalizeSavedItem({
      ...item,
      ...tracking,
      status,
      personal_rating: personalRating || '',
      personal_rating_cleared: Boolean(prev && !personalRating && prev.personal_rating !== ''),
      addedAt: prev ? prev.addedAt : new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    if (!normalized) return;

    if (existingIndex >= 0) {
      const next = [...savedItems];
      next[existingIndex] = normalized;
      setSavedItems(next);
    } else {
      setSavedItems([normalized, ...savedItems]);
    }

    // Auto-enrich TV show metadata if episode count or runtime is missing
    if (normalized.media_type === 'tv' && !normalized.custom && !normalized.number_of_episodes) {
      fetchTmdb(`/tv/${normalized.id}`)
        .then((tvDetails) => {
          if (tvDetails) {
            setSavedItems((currentList) =>
              currentList.map((entry) => {
                if (entry.id === normalized.id && entry.media_type === 'tv') {
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
    setSavedItems((prev) =>
      prev.filter((entry) => !(entry.id === item.id && entry.media_type === item.media_type))
    );
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
      const filtered = catalogItems.filter(
        (item) => !preferences.disliked.includes(`${item.media_type}:${item.id}`)
      );
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

  // Header and Catalog Section Titles
  const getCatalogTitles = () => {
    if (tab === 'list') {
      return {
        title: 'Kişisel takip listem',
        description: 'Kişisel izleme listen bu tarayıcıda saklanır',
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
        description: 'İzleme listen ve kişisel puanlarından oluşturulan öneriler',
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

  const todayStr = new Date().toISOString().slice(0, 10);
  const upcomingCount = savedItems.filter((item) => {
    const airDate = resolveAirDate(item);
    return airDate && airDate >= todayStr;
  }).length;

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
        getSaved={(item) =>
          savedItems.find((s) => s.id === item.id && s.media_type === item.media_type)
        }
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
          myListCount={savedItems.length}
          upcomingCount={upcomingCount}
          dislikedCount={preferences.disliked.length}
          favoriteActorsCount={favoriteActors.length}
          genres={genresMap}
          selectedGenre={selectedGenre}
          onGenreChange={setSelectedGenre}
          selectedType={selectedType}
          onTypeChange={setSelectedType}
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
          recommendationReasons={recommendationReasons}
          dislikedKeys={preferences.disliked}
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
        savedItem={
          detailItem
            ? savedItems.find(
                (s) => s.id === detailItem.id && s.media_type === detailItem.media_type
              )
            : undefined
        }
        isOpen={Boolean(detailItem)}
        genresMap={genresMap}
        isDisliked={
          detailItem
            ? preferences.disliked.includes(`${detailItem.media_type}:${detailItem.id}`)
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
        savedItem={
          quickSaveItem
            ? savedItems.find(
                (s) => s.id === quickSaveItem.id && s.media_type === quickSaveItem.media_type
              )
            : undefined
        }
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
