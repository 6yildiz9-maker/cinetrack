/**
 * Kaynaklardan bağımsız kimlik anahtarları.
 * Kullanıcı listeleri (TMDB), stok havuzu ve TVDB akış kayıtları aynı anahtar dilimini
 * üretmek zorunda; karşılaştırma noktaları (`movie:123`, `raw:123`, `başlık`, `başlık|yıl`)
 * burada tek kez tanımlanır.
 */

import { buildTitleYearKey, foldTitleKey } from './tvdb-normalize.ts';

export type IdentityRecord = {
  id?: string | number | null;
  tvdb_id?: string | number | null;
  media_type?: string;
  title?: string;
  name?: string;
  original_title?: string;
  original_name?: string;
  release_date?: string;
  first_air_date?: string;
  year?: string | number;
  imdb_id?: string;
};

/**
 * Yalnızca tür önekleri temizlenir. `tvdb-` öneki BİLİNÇLİ olarak düşürülmez:
 * TVDB ve TMDB sayısal kimlikleri çakışabilir, havuz karışması yaşamak yerine
 * TVDB kimliği `tvdb_id` alanından ayrı bir anahtar olarak gelir.
 */
function rawIdOf(value: unknown): string {
  return String(value ?? '').replace(/^(movie|tv)[:-]/, '').trim().toLowerCase();
}

function titleOf(item: IdentityRecord, preferOriginal = false): string {
  if (preferOriginal) return String(item.original_title || item.original_name || '');
  return String(item.title || item.name || '');
}

/** Stok tekilleştirmesi için anahtarlar (kaynak-agnostik kısım). */
export function mediaDedupeKeys(item: IdentityRecord): string[] {
  if (!item) return [];
  const type = item.media_type === 'tv' ? 'tv' : 'movie';
  const keys: string[] = [];
  const id = rawIdOf(item.id);
  if (id) {
    keys.push(`${type}:${id}`, `raw:${id}`);
  }
  const tvdbId = rawIdOf(item.tvdb_id);
  if (tvdbId) keys.push(`${type}:${tvdbId}`);

  for (const title of [titleOf(item), titleOf(item, true)]) {
    const folded = foldTitleKey(title);
    if (folded) keys.push(folded);
  }
  return keys;
}

/** Kullanıcı listesi eleme anahtarları: dedupe + yayın yılı ve IMDB çapraz kimliği. */
export function mediaExclusionKeys(item: IdentityRecord): string[] {
  if (!item) return [];
  const keys = [...mediaDedupeKeys(item)];
  const released = item.release_date || item.first_air_date || item.year;
  for (const title of [titleOf(item), titleOf(item, true)]) {
    const titleYear = buildTitleYearKey(title, released);
    if (titleYear) keys.push(titleYear);
  }
  if (item.imdb_id) keys.push(`imdb:${String(item.imdb_id).toLowerCase()}`);
  return keys;
}
