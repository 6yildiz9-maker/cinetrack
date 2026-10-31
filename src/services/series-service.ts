import { fetchTmdb } from './api.ts';
import {
  SeriesCollection,
  SeriesCollectionPart,
  registerSeriesCollections,
  loadSeriesIndexIdb,
  isMediaInSeriesSync,
  getSeriesForMediaSync,
  getAllSeriesCollectionsSync,
} from './storage-idb.ts';
import type { SavedItem } from '../core/cinetrack-core.ts';
import type { TmdbItem } from '../types/tmdb.ts';

// Known TV Show franchise groupings (mapped by TV ID or keyword)
const KNOWN_TV_FRANCHISES: Record<string, { id: number; name: string; tvIds: number[] }> = {
  breaking_bad: {
    id: 90001,
    name: 'Breaking Bad Evreni',
    tvIds: [1396, 60059], // Breaking Bad, Better Call Saul
  },
  game_of_thrones: {
    id: 90002,
    name: 'Westeros & Game of Thrones Evreni',
    tvIds: [1399, 94997, 102220], // Game of Thrones, House of the Dragon, A Knight of the Seven Kingdoms
  },
  walking_dead: {
    id: 90003,
    name: 'The Walking Dead Evreni',
    tvIds: [1402, 62286, 94305, 127532, 211684], // TWD, Fear TWD, World Beyond, Dead City, The Ones Who Live
  },
  star_wars_tv: {
    id: 90004,
    name: 'Star Wars Dizi Evreni',
    tvIds: [82856, 92782, 83867, 105971, 114479, 4194, 94605], // Mandalorian, Andor, Obi-Wan, Boba Fett, Ahsoka, Clone Wars, Bad Batch
  },
  marvel_tv: {
    id: 90005,
    name: 'Marvel Televizyon Evreni',
    tvIds: [85271, 84958, 88396, 92749, 92783, 67178, 62285], // WandaVision, Loki, Falcon & Winter Soldier, Moon Knight, She-Hulk, Daredevil, Agents of SHIELD
  },
  star_trek_tv: {
    id: 90006,
    name: 'Star Trek Dizi Evreni',
    tvIds: [253, 655, 670, 199, 67198, 85949, 106393], // TOS, TNG, DS9, Voyager, Discovery, Picard, Strange New Worlds
  },
  the_boys: {
    id: 90007,
    name: 'The Boys Evreni',
    tvIds: [76479, 205715, 110488], // The Boys, Gen V, Diabolical
  },
  stranger_things: {
    id: 90008,
    name: 'Stranger Things Evreni',
    tvIds: [66732],
  },
};

const processedCollectionIds = new Set<number>();
const inFlightCollectionFetches = new Set<number>();

/**
 * Ensures series-index is loaded from IndexedDB
 */
export async function initSeriesService(): Promise<void> {
  await loadSeriesIndexIdb();
}

/**
 * Fetches TMDB /collection/{id} and indexes all parts
 */
export async function indexMovieCollection(collectionId: number): Promise<SeriesCollection | null> {
  if (!collectionId || processedCollectionIds.has(collectionId)) return null;
  if (inFlightCollectionFetches.has(collectionId)) return null;

  inFlightCollectionFetches.add(collectionId);
  try {
    const raw = await fetchTmdb(`/collection/${collectionId}`);
    if (!raw || !Array.isArray(raw.parts)) {
      inFlightCollectionFetches.delete(collectionId);
      return null;
    }

    const parts: SeriesCollectionPart[] = raw.parts.map((p: any) => ({
      id: p.id,
      media_type: 'movie',
      title: p.title || p.name || 'Başlıksız',
      name: p.name || p.title,
      release_date: p.release_date || '',
      first_air_date: p.release_date || '',
      poster_path: p.poster_path || null,
      backdrop_path: p.backdrop_path || null,
      vote_average: Number(p.vote_average || 0),
      overview: p.overview || '',
    }));

    // Sort parts by release date ascending
    parts.sort((a, b) => {
      const da = a.release_date || '9999';
      const db = b.release_date || '9999';
      return da.localeCompare(db);
    });

    const seriesCol: SeriesCollection = {
      id: collectionId,
      name: raw.name || 'Koleksiyon',
      media_type: 'movie',
      poster_path: raw.poster_path || null,
      backdrop_path: raw.backdrop_path || null,
      overview: raw.overview || '',
      parts,
      partKeys: parts.map((p) => `movie:${p.id}`),
    };

    processedCollectionIds.add(collectionId);
    await registerSeriesCollections([seriesCol]);
    return seriesCol;
  } catch (err) {
    console.warn(`[SeriesService] Koleksiyon çekilemedi (${collectionId}):`, err);
    return null;
  } finally {
    inFlightCollectionFetches.delete(collectionId);
  }
}

/**
 * Checks an item (movie or TV) and indexes its collection/franchise if present.
 */
export async function indexItemForSeries(item: TmdbItem | SavedItem | any): Promise<void> {
  if (!item || !item.id) return;
  const isMovie = item.media_type === 'movie' || (!item.media_type && item.title);

  // Movie collection check
  if (isMovie) {
    const collectionId =
      item.belongs_to_collection?.id ||
      (typeof item.belongs_to_collection === 'number' ? item.belongs_to_collection : null);

    if (collectionId) {
      await indexMovieCollection(collectionId);
    }
  } else {
    // TV Franchise check
    const tvId = Number(item.id);
    for (const franchise of Object.values(KNOWN_TV_FRANCHISES)) {
      if (franchise.tvIds.includes(tvId)) {
        const parts: SeriesCollectionPart[] = franchise.tvIds.map((id) => ({
          id,
          media_type: 'tv',
          title: id === tvId ? (item.name || item.title || 'Dizi') : `Dizi #${id}`,
          name: id === tvId ? (item.name || item.title || 'Dizi') : `Dizi #${id}`,
          poster_path: id === tvId ? item.poster_path : null,
          vote_average: id === tvId ? item.vote_average : 0,
        }));

        const seriesCol: SeriesCollection = {
          id: franchise.id,
          name: franchise.name,
          media_type: 'tv',
          parts,
          partKeys: franchise.tvIds.map((id) => `tv:${id}`),
        };
        await registerSeriesCollections([seriesCol]);
        break;
      }
    }
  }
}

/**
 * Batch indexing for a list of items (e.g. stock or user-lists)
 */
export async function indexItemsForSeriesBatch(items: any[]): Promise<void> {
  for (const it of items) {
    await indexItemForSeries(it);
  }
}

/**
 * Returns whether a given item is part of a series (sync check for MediaCard badge)
 */
export function isItemInSeries(item: any): boolean {
  if (!item || !item.id) return false;
  const mType = item.media_type === 'tv' ? 'tv' : 'movie';
  const key = `${mType}:${item.id}`;
  if (isMediaInSeriesSync(key)) return true;
  if (item.belongs_to_collection) return true;
  return false;
}

/**
 * Finds all parts of franchises that user has in their list, for the "Seriler" tab.
 */
export interface UserSeriesUniverse {
  collection: SeriesCollection;
  userOwnedParts: SeriesCollectionPart[];
  userMissingParts: SeriesCollectionPart[];
}

export function computeUserSeriesUniverses(savedItems: SavedItem[]): UserSeriesUniverse[] {
  const savedKeys = new Set(
    savedItems.map((it) => `${it.media_type === 'tv' ? 'tv' : 'movie'}:${it.id}`)
  );

  const allCollections = getAllSeriesCollectionsSync();
  const universes: UserSeriesUniverse[] = [];

  for (const col of allCollections) {
    const ownedParts: SeriesCollectionPart[] = [];
    const missingParts: SeriesCollectionPart[] = [];

    for (const part of col.parts) {
      const partKey = `${part.media_type}:${part.id}`;
      if (savedKeys.has(partKey)) {
        ownedParts.push(part);
      } else {
        missingParts.push(part);
      }
    }

    // Only include in "Seriler" tab if user has at least 1 piece of this collection in their list
    if (ownedParts.length > 0) {
      universes.push({
        collection: col,
        userOwnedParts: ownedParts,
        userMissingParts: missingParts,
      });
    }
  }

  return universes;
}
