import { useState, useEffect, useRef, useCallback } from 'react';
import type { SavedItem } from '../core/cinetrack-core.ts';
import {
  buildCinemaKunyeCanonicalPayload,
  createEmptyCinemaKunyeDocument,
  extractCinemaKunyeEntryFromSavedItem,
  extractCinemaKunyeFromItems,
  findCinemaKunyeEntryForItem,
  isWatchedForCinemaKunye,
  mergeCinemaKunyeDocumentsLossless,
  normalizeCinemaKunyeDocument,
  type CinemaKunyeDocument,
  type CinemaKunyeEntry,
} from '../core/cinema-kunye.ts';
import {
  fetchServerCinemaKunye,
  fetchTmdbCached,
  saveServerCinemaKunye,
  type TmdbDataSource,
} from '../services/api.ts';
import { mapLimit } from '../utils/helpers.ts';

const CINEMA_KUNYE_STORAGE_KEY = 'ct:cinema-kunye';
const ENRICH_BATCH_SIZE = 6;
const ENRICH_CONCURRENCY = 2;

function loadCachedCinemaKunye(): CinemaKunyeDocument {
  try {
    const raw = localStorage.getItem(CINEMA_KUNYE_STORAGE_KEY);
    if (!raw) return createEmptyCinemaKunyeDocument();
    return normalizeCinemaKunyeDocument(JSON.parse(raw));
  } catch {
    return createEmptyCinemaKunyeDocument();
  }
}

function persistCachedCinemaKunye(doc: CinemaKunyeDocument): void {
  try {
    localStorage.setItem(CINEMA_KUNYE_STORAGE_KEY, JSON.stringify(doc));
  } catch {
    // Ignore storage quota warnings; full copy is persisted on server data/sinema-kunyesi.json
  }
}

function computeCanonicalSignature(doc: CinemaKunyeDocument): string {
  return JSON.stringify(buildCinemaKunyeCanonicalPayload(doc));
}

function parseNumericTmdbId(id: SavedItem['id']): number | null {
  if (typeof id === 'number' && Number.isSafeInteger(id) && id > 0) return id;
  if (typeof id === 'string' && /^\d+$/.test(id.trim())) {
    const num = Number(id.trim());
    if (Number.isSafeInteger(num) && num > 0) return num;
  }
  return null;
}

export interface UseCinemaKunyeParams {
  savedItems: SavedItem[];
  genresMap: Record<number, string>;
  isDemo?: boolean;
  tmdbSource?: TmdbDataSource;
}

export interface UseCinemaKunyeResult {
  cinemaKunye: CinemaKunyeDocument;
  mergeIncomingCinemaKunye: (incoming?: CinemaKunyeDocument | null) => CinemaKunyeDocument;
  replaceCinemaKunye: (incoming?: CinemaKunyeDocument | null) => CinemaKunyeDocument;
  flushCinemaKunyeToServer: () => Promise<void>;
  refreshCinemaKunyeFromServer: (mode?: 'merge' | 'overwrite') => Promise<void>;
}

export function useCinemaKunye({
  savedItems,
  genresMap,
  isDemo = false,
  tmdbSource = 'unknown',
}: UseCinemaKunyeParams): UseCinemaKunyeResult {
  const [cinemaKunye, setCinemaKunye] = useState<CinemaKunyeDocument>(loadCachedCinemaKunye);

  const cinemaKunyeRef = useRef<CinemaKunyeDocument>(cinemaKunye);
  cinemaKunyeRef.current = cinemaKunye;

  const savedItemsRef = useRef<SavedItem[]>(savedItems);
  savedItemsRef.current = savedItems;

  const genresMapRef = useRef<Record<number, string>>(genresMap);
  genresMapRef.current = genresMap;

  const isDemoRef = useRef<boolean>(isDemo);
  isDemoRef.current = isDemo;

  const serverHydratedRef = useRef<boolean>(false);
  const lastServerCanonicalRef = useRef<string>('');
  const attemptedTmdbKeysRef = useRef<Set<string>>(new Set());
  const enrichInFlightRef = useRef<boolean>(false);
  const [enrichTick, setEnrichTick] = useState<number>(0);

  const applyNextDocument = useCallback((nextDoc: CinemaKunyeDocument): CinemaKunyeDocument => {
    const prevSig = computeCanonicalSignature(cinemaKunyeRef.current);
    const nextSig = computeCanonicalSignature(nextDoc);
    if (prevSig === nextSig) {
      return cinemaKunyeRef.current;
    }
    cinemaKunyeRef.current = nextDoc;
    persistCachedCinemaKunye(nextDoc);
    setCinemaKunye(nextDoc);
    return nextDoc;
  }, []);

  // 1. Initial hydration from server (data/sinema-kunyesi.json)
  useEffect(() => {
    let active = true;
    fetchServerCinemaKunye()
      .then((serverDoc) => {
        if (!active) return;
        const baseServer = serverDoc || createEmptyCinemaKunyeDocument();
        lastServerCanonicalRef.current = computeCanonicalSignature(baseServer);

        const localWatched = isDemoRef.current
          ? createEmptyCinemaKunyeDocument()
          : extractCinemaKunyeFromItems(savedItemsRef.current, genresMapRef.current);

        const merged = mergeCinemaKunyeDocumentsLossless(
          mergeCinemaKunyeDocumentsLossless(baseServer, cinemaKunyeRef.current),
          localWatched
        );
        applyNextDocument(merged);
      })
      .finally(() => {
        if (active) {
          serverHydratedRef.current = true;
        }
      });

    return () => {
      active = false;
    };
  }, [applyNextDocument]);

  // 2. Extract watched items metadata (genre / year / cast) whenever savedItems or genresMap updates
  useEffect(() => {
    if (isDemo) return;
    const extracted = extractCinemaKunyeFromItems(savedItems, genresMap);
    if (Object.keys(extracted.entries).length === 0) return;
    const merged = mergeCinemaKunyeDocumentsLossless(cinemaKunyeRef.current, extracted);
    applyNextDocument(merged);
  }, [savedItems, genresMap, isDemo, applyNextDocument]);

  // 3. Background TMDB enrichment for watched items missing actor/genre/year data
  useEffect(() => {
    if (isDemo || tmdbSource === 'demo' || tmdbSource === 'error') return;
    if (enrichInFlightRef.current) return;

    const candidatesToEnrich = savedItems.filter((item) => {
      if (!isWatchedForCinemaKunye(item) || item.custom) return false;
      const numericId = parseNumericTmdbId(item.id);
      if (numericId === null) return false;
      const mediaType = item.media_type === 'tv' ? 'tv' : 'movie';
      const attemptKey = `${mediaType}:${numericId}`;
      if (attemptedTmdbKeysRef.current.has(attemptKey)) return false;

      const existing = findCinemaKunyeEntryForItem(item, cinemaKunyeRef.current);
      if (!existing) return true;
      return (
        existing.actors.length === 0 ||
        existing.genreIds.length === 0 ||
        existing.year === null
      );
    });

    if (candidatesToEnrich.length === 0) return;

    const batch = candidatesToEnrich.slice(0, ENRICH_BATCH_SIZE);
    const hasRemaining = candidatesToEnrich.length > batch.length;
    for (const item of batch) {
      const numericId = parseNumericTmdbId(item.id);
      if (numericId !== null) {
        const mediaType = item.media_type === 'tv' ? 'tv' : 'movie';
        attemptedTmdbKeysRef.current.add(`${mediaType}:${numericId}`);
      }
    }

    let cancelled = false;
    let nextBatchTimer: ReturnType<typeof setTimeout> | null = null;
    enrichInFlightRef.current = true;

    void mapLimit(batch, ENRICH_CONCURRENCY, async (item): Promise<CinemaKunyeEntry | null> => {
      const numericId = parseNumericTmdbId(item.id);
      if (numericId === null) return null;
      const mediaType = item.media_type === 'tv' ? 'tv' : 'movie';
      try {
        const detail = await fetchTmdbCached(`/${mediaType}/${numericId}`, {
          append_to_response: 'credits',
        });
        if (!detail || typeof detail !== 'object') return null;
        const castList = Array.isArray(detail.credits?.cast)
          ? detail.credits.cast
          : Array.isArray(detail.cast)
            ? detail.cast
            : item.cast;
        const detailGenres = Array.isArray(detail.genres) ? detail.genres : undefined;
        const syntheticItem: SavedItem & Record<string, unknown> = {
          ...item,
          id: numericId,
          media_type: mediaType,
          title: item.title || detail.title || detail.name || '',
          name: item.name || detail.name || detail.title || '',
          release_date: detail.release_date || item.release_date || '',
          first_air_date: detail.first_air_date || item.first_air_date || '',
          genres: detailGenres,
          genre_ids:
            Array.isArray(detailGenres) && detailGenres.length > 0
              ? detailGenres
                  .map((g: { id?: number }) => Number(g?.id))
                  .filter((n: number) => Number.isInteger(n) && n > 0)
              : item.genre_ids,
          cast: castList,
        };
        return extractCinemaKunyeEntryFromSavedItem(syntheticItem, genresMapRef.current);
      } catch {
        return null;
      }
    })
      .then((entries) => {
        if (cancelled) return;
        const validEntries = entries.filter((e): e is CinemaKunyeEntry => e !== null);
        if (validEntries.length > 0) {
          const patchDoc: CinemaKunyeDocument = {
            ...createEmptyCinemaKunyeDocument(),
            entries: Object.fromEntries(validEntries.map((e) => [e.contentId, e])),
          };
          const merged = mergeCinemaKunyeDocumentsLossless(cinemaKunyeRef.current, patchDoc);
          applyNextDocument(merged);
        }
        if (hasRemaining && !cancelled) {
          nextBatchTimer = setTimeout(() => {
            setEnrichTick((t) => t + 1);
          }, 1200);
        }
      })
      .finally(() => {
        enrichInFlightRef.current = false;
      });

    return () => {
      cancelled = true;
      if (nextBatchTimer) clearTimeout(nextBatchTimer);
    };
  }, [savedItems, isDemo, tmdbSource, enrichTick, applyNextDocument]);

  // 4. Debounced persistence to server (data/sinema-kunyesi.json)
  useEffect(() => {
    if (isDemo || !serverHydratedRef.current) return;
    const currentSig = computeCanonicalSignature(cinemaKunye);
    if (currentSig === lastServerCanonicalRef.current) return;
    if (
      Object.keys(cinemaKunye.entries).length === 0 &&
      (!lastServerCanonicalRef.current ||
        lastServerCanonicalRef.current === computeCanonicalSignature(createEmptyCinemaKunyeDocument()))
    ) {
      return;
    }

    const timer = setTimeout(() => {
      const snapshot = cinemaKunyeRef.current;
      void saveServerCinemaKunye(snapshot, 'merge').then((savedOnServer) => {
        if (!savedOnServer) return;
        lastServerCanonicalRef.current = computeCanonicalSignature(savedOnServer);
        const merged = mergeCinemaKunyeDocumentsLossless(cinemaKunyeRef.current, savedOnServer);
        applyNextDocument(merged);
      });
    }, 650);

    return () => clearTimeout(timer);
  }, [cinemaKunye, isDemo, applyNextDocument]);

  const mergeIncomingCinemaKunye = useCallback(
    (incoming?: CinemaKunyeDocument | null): CinemaKunyeDocument => {
      if (!incoming || typeof incoming !== 'object') return cinemaKunyeRef.current;
      const merged = mergeCinemaKunyeDocumentsLossless(
        cinemaKunyeRef.current,
        normalizeCinemaKunyeDocument(incoming)
      );
      applyNextDocument(merged);
      if (!isDemoRef.current && Object.keys(merged.entries).length > 0) {
        void saveServerCinemaKunye(merged, 'merge').then((saved) => {
          if (saved) {
            lastServerCanonicalRef.current = computeCanonicalSignature(saved);
          }
        });
      }
      return merged;
    },
    [applyNextDocument]
  );

  const replaceCinemaKunye = useCallback(
    (incoming?: CinemaKunyeDocument | null): CinemaKunyeDocument => {
      const normalized = incoming
        ? normalizeCinemaKunyeDocument(incoming)
        : createEmptyCinemaKunyeDocument();
      cinemaKunyeRef.current = normalized;
      persistCachedCinemaKunye(normalized);
      setCinemaKunye(normalized);
      if (!isDemoRef.current) {
        void saveServerCinemaKunye(normalized, 'overwrite').then((saved) => {
          if (saved) {
            lastServerCanonicalRef.current = computeCanonicalSignature(saved);
          }
        });
      }
      return normalized;
    },
    []
  );

  const flushCinemaKunyeToServer = useCallback(async (): Promise<void> => {
    if (isDemoRef.current) return;
    const latestWatched = extractCinemaKunyeFromItems(savedItemsRef.current, genresMapRef.current);
    const merged = mergeCinemaKunyeDocumentsLossless(cinemaKunyeRef.current, latestWatched);
    applyNextDocument(merged);

    if (Object.keys(merged.entries).length === 0) return;
    const sig = computeCanonicalSignature(merged);
    if (sig === lastServerCanonicalRef.current) return;

    const saved = await saveServerCinemaKunye(merged, 'merge');
    if (saved) {
      lastServerCanonicalRef.current = computeCanonicalSignature(saved);
      const reconciled = mergeCinemaKunyeDocumentsLossless(cinemaKunyeRef.current, saved);
      applyNextDocument(reconciled);
    }
  }, [applyNextDocument]);

  const refreshCinemaKunyeFromServer = useCallback(
    async (mode: 'merge' | 'overwrite' = 'merge'): Promise<void> => {
      const serverDoc = await fetchServerCinemaKunye();
      if (!serverDoc) return;
      lastServerCanonicalRef.current = computeCanonicalSignature(serverDoc);
      if (mode === 'overwrite') {
        cinemaKunyeRef.current = serverDoc;
        persistCachedCinemaKunye(serverDoc);
        setCinemaKunye(serverDoc);
        return;
      }
      const merged = mergeCinemaKunyeDocumentsLossless(cinemaKunyeRef.current, serverDoc);
      applyNextDocument(merged);
    },
    [applyNextDocument]
  );

  return {
    cinemaKunye,
    mergeIncomingCinemaKunye,
    replaceCinemaKunye,
    flushCinemaKunyeToServer,
    refreshCinemaKunyeFromServer,
  };
}
