/**
 * TheTVDB içerik kaynağı motoru.
 * Poster onarımı ve çapraz kimlik (TMDB/IMDB) anahtarları TVDB'ye özgüdür; çağrıların
 * `tvdb_remote_ids` gibi alanları elle okuması yerine bu motora sorulur.
 */

import { mediaDedupeKeys, mediaExclusionKeys, type IdentityRecord } from './media-identity.ts';
import { normalizeTvdbPoster, repairTvdbPosterUrl, extractTvdbCrossIds } from './tvdb-normalize.ts';
import type { ContentSourceEngine } from './content-source.ts';

type TvdbRecord = IdentityRecord & {
  poster_url?: string;
  tvdb_remote_ids?: { tmdb?: string; imdb?: string };
  remoteIds?: unknown[];
};

export const tvdbSourceEngine: ContentSourceEngine = {
  id: 'tvdb',
  label: 'TheTVDB',

  owns(item) {
    if (!item) return false;
    if (item.source) return item.source === 'tvdb';
    return String(item.id ?? '').startsWith('tvdb-') || (item as IdentityRecord).tvdb_id != null;
  },

  posterUrl(item) {
    const direct = normalizeTvdbPoster(item as TvdbRecord);
    if (direct) return direct;
    return repairTvdbPosterUrl((item as TvdbRecord).poster_url || item.poster_path);
  },

  dedupeKeys(item) {
    return [...mediaDedupeKeys(item as TvdbRecord), ...tvdbCrossKeys(item as TvdbRecord)];
  },

  exclusionKeys(item) {
    return [...mediaExclusionKeys(item as TvdbRecord), ...tvdbCrossKeys(item as TvdbRecord)];
  },
};

/** TMDB/IMDB çapraz kimlikleri: liste eşleşmesi TVDB kaydının kendi kimliğiyle de bulunabilir. */
function tvdbCrossKeys(item: TvdbRecord): string[] {
  const cross =
    item.tvdb_remote_ids && (item.tvdb_remote_ids.tmdb || item.tvdb_remote_ids.imdb)
      ? item.tvdb_remote_ids
      : extractTvdbCrossIds(item.remoteIds as any);
  const keys: string[] = [];
  if (cross?.tmdb) keys.push(`raw:${String(cross.tmdb).toLowerCase()}`);
  if (cross?.imdb) keys.push(`imdb:${String(cross.imdb).toLowerCase()}`);
  return keys;
}
