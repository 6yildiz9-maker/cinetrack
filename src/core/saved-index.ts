/**
 * Kaydedilmiş listelerde O(1) arama indeksi.
 * `cinetrack-core.findSavedItem` aynı öncelik kurallarını buradan uygular;
 * MediaGrid gibi yüzlerce kart üreten çağıranlar indeksi bir kez kurup her kartta
 * tekrar tekrar 2000+ kayıt taramaktan kurtulur.
 */

export type SavedIndexRecord = {
  id?: string | number | null;
  media_type?: string;
  title?: string;
  name?: string;
};

export type SavedIndex = {
  byTypeAndId: Map<string, SavedIndexRecord>;
  byId: Map<string, SavedIndexRecord>;
  byTitle: Map<string, SavedIndexRecord>;
  entries: ReadonlyArray<SavedIndexRecord>;
  size: number;
};

function typeKey(type: string | undefined, id: string): string {
  return `${type}:${id}`;
}

function normalizedTitle(value: unknown): string {
  return String(value ?? '').trim().toLowerCase();
}

function putFirst<T>(map: Map<string, T>, key: string, value: T): void {
  if (!key || map.has(key)) return;
  map.set(key, value);
}

/** Buluşma önceliği bulma sırasında korunur: aynı anahtaki ilk kayıt kazanır. */
export function buildSavedIndex(savedItems: ReadonlyArray<SavedIndexRecord> | undefined | null): SavedIndex {
  const byTypeAndId = new Map<string, SavedIndexRecord>();
  const byId = new Map<string, SavedIndexRecord>();
  const byTitle = new Map<string, SavedIndexRecord>();
  const list = Array.isArray(savedItems) ? savedItems : [];

  for (const entry of list) {
    if (!entry || entry.id == null) continue;
    const id = String(entry.id);
    putFirst(byTypeAndId, typeKey(entry.media_type, id), entry);
    putFirst(byId, id, entry);
    // Yalnızca `title` tarafı: eski bulma kuralıyla birebir aynı öncelik için
    const title = normalizedTitle(entry.title);
    if (title) putFirst(byTitle, title, entry);
  }

  return { byTypeAndId, byId, byTitle, entries: list, size: list.length };
}

export type SavedLookupTarget = {
  id?: string | number | null;
  media_type?: string;
  title?: string;
  name?: string;
};

/**
 * `SavedIndex` üzerinde bulur. `index` verilmezse (tekil kullanım çağrıları için)
 * ham diziden indeks kurulur.
 */
export function findSaved(
  savedItems: ReadonlyArray<SavedIndexRecord> | undefined | null,
  item: SavedLookupTarget | null | undefined,
  index?: SavedIndex
): SavedIndexRecord | undefined {
  if (!item || item.id == null) return undefined;
  const source = Array.isArray(savedItems) ? savedItems : [];
  const cache = index || buildSavedIndex(source);
  const targetId = String(item.id);
  const targetType = item.media_type || (item.title ? 'movie' : item.name ? 'tv' : undefined);

  if (targetType) {
    const exact = cache.byTypeAndId.get(typeKey(targetType, targetId));
    if (exact) return exact;
  } else {
    const byId = cache.byId.get(targetId);
    if (byId) return byId;
  }

  // 3. yedek: başlık eşleşmesi (tür biliniyorsa türle sınırlı)
  const rawTitle = normalizedTitle(item.title || item.name);
  if (!rawTitle) return undefined;
  const byTitle = cache.byTitle.get(rawTitle);
  if (!byTitle) return undefined;
  if (!targetType || byTitle.media_type === targetType) return byTitle;
  return source.find(
    (entry) =>
      normalizedTitle(entry.title) === rawTitle && entry.media_type === targetType
  );
}
