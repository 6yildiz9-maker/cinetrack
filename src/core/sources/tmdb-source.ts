/**
 * TMDB içerik kaynağı motoru.
 * Görsel adresi ve kimlik anahtarları üretimini tek yerde toplar; böylece başka bir
 * motor eklerken stok/liste hatlarında `source === 'tmdb'` dallanması aramaya gerek kalmaz.
 */

import { imageUrl } from '../../utils/helpers.ts';
import { resolvePoster } from '../media/poster.ts';
import { mediaDedupeKeys, mediaExclusionKeys, type IdentityRecord } from './media-identity.ts';
import type { ContentSourceEngine } from './content-source.ts';

export const tmdbSourceEngine: ContentSourceEngine = {
  id: 'tmdb',
  label: 'TMDB',

  owns(item) {
    if (!item) return false;
    // Etiket yoksa TMDB varsayılır.
    return !item.source || item.source === 'tmdb';
  },

  posterUrl(item, size = 'w500') {
    const resolved = resolvePoster(item);
    return resolved.kind === 'none' ? null : imageUrl(resolved.value, size);
  },

  dedupeKeys(item) {
    return mediaDedupeKeys(item as IdentityRecord);
  },

  exclusionKeys(item) {
    return mediaExclusionKeys(item as IdentityRecord);
  },
};
