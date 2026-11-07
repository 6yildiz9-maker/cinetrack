/**
 * TMDB içerik kaynağı motoru.
 * Görsel adresi ve kimlik anahtarları üretimini tek yerde toplar; böylece başka bir
 * motor eklerken stok/liste hatlarında `source === 'tmdb'` dallanması aramaya gerek kalmaz.
 */

import { imageUrl } from '../../utils/helpers.ts';
import { mediaDedupeKeys, mediaExclusionKeys, type IdentityRecord } from './media-identity.ts';
import type { ContentSourceEngine } from './content-source.ts';

export const tmdbSourceEngine: ContentSourceEngine = {
  id: 'tmdb',
  label: 'TMDB',

  owns(item) {
    if (!item) return false;
    if (item.source) return item.source === 'tmdb';
    // Etiket yoksa TMDB varsayılır: tvdb- öneki ve tvdb_id taşımayan kayıtlar TMDB'dir.
    const id = String(item.id ?? '');
    return !id.startsWith('tvdb-') && (item as IdentityRecord).tvdb_id == null;
  },

  posterUrl(item, size = 'w500') {
    const path = String(item.poster_path || item.poster_url || '');
    return path ? imageUrl(path, size) : null;
  },

  dedupeKeys(item) {
    return mediaDedupeKeys(item as IdentityRecord);
  },

  exclusionKeys(item) {
    return mediaExclusionKeys(item as IdentityRecord);
  },
};
