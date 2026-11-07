/**
 * Kaynak motorları kayıt noktası.
 * Yeni bir kaynak eklemek = yeni bir motor yazmak + burada kaydetmek; tüketiciler
 * `contentSourceFor(item)` ile sorar, `item.source === 'tvdb'` dallanması yazmaz.
 */

import { registerContentSource } from './content-source.ts';
import { tmdbSourceEngine } from './tmdb-source.ts';
import { tvdbSourceEngine } from './tvdb-source.ts';

registerContentSource(tmdbSourceEngine);
registerContentSource(tvdbSourceEngine);

export { tmdbSourceEngine, tvdbSourceEngine };
export {
  contentSourceFor,
  getContentSource,
  listContentSources,
  registerContentSource,
  resetContentSourceRegistry,
  type ContentSourceEngine,
  type ContentSourceId,
} from './content-source.ts';
