/**
 * Kaynaklardan bağımsız kimlik anahtarları.
 * Kullanıcı listeleri ve stok havuzu aynı anahtar dilimini üretmek zorunda;
 * karşılaştırma noktaları (`movie:123`, `raw:123`, `başlık`, `başlık|yıl`)
 * burada tek kez tanımlanır.
 */

export type IdentityRecord = {
  id?: string | number | null;
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

const TURKISH_FOLD: Record<string, string> = {
  ç: 'c', ğ: 'g', ı: 'i', ö: 'o', ş: 's', ü: 'u',
  â: 'a', î: 'i', û: 'u', é: 'e', è: 'e',
};

/** Türkçe karakter katlaması + noktalama temizliği: "Şahsiyet" ≡ "sahsiyet". */
export function foldTitleKey(title: unknown): string {
  const text = String(title ?? '')
    .toLowerCase()
    .replace(/[çğıöşüâîûéè]/g, (ch) => TURKISH_FOLD[ch] ?? ch)
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  return text
    .replace(/[^\p{L}\p{N} ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Yıl bilgisi varsa başlık anahtarı `başlık|yıl` olur. */
export function buildTitleYearKey(title: unknown, year?: unknown): string {
  const folded = foldTitleKey(title);
  if (!folded) return '';
  const digits = String(year ?? '').match(/\d{4}/);
  return digits ? `${folded}|${digits[0]}` : folded;
}

/** Yalnızca tür önekleri temizlenir. */
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
