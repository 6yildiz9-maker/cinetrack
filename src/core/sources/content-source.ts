/**
 * İçerik kaynak motorlarının ortak sözleşmesi.
 * Kaynak-özgün bilgi — görsel adresi, tekilleştirme anahtarı, eleme anahtarları —
 * yalnızca ilgili motorda yaşar; stok/liste hatları kaynak etiketine göre dallanmaz.
 * Saf sözleşme: ağ erişimi ve depolama yok.
 */

import type { TmdbItem } from '../../types/tmdb.ts';

export type ContentSourceId = string;

export interface ContentSourceEngine {
  /** Kayıt üzerinde tutulan kaynak etiketi ('tmdb' | ...). */
  readonly id: ContentSourceId;
  /** Kullanıcıya gösterilebilir ad. */
  readonly label: string;

  /** Bu motor kayda ait mi? (etiket yoksa ipuçlarından da karar verebilir) */
  owns(item: Partial<TmdbItem> | null | undefined): boolean;

  /** Kartın basabileceği mutlak görsel adresi; yoksa null. */
  posterUrl(item: Partial<TmdbItem>, size?: string): string | null;

  /** Stok/liste tekilleştirmesinde kullanılan kaynak-özgün anahtarlar. */
  dedupeKeys(item: Partial<TmdbItem>): string[];

  /** Kullanıcı listeleriyle eleme karşılaştırmasında kullanılan anahtarlar. */
  exclusionKeys(item: Partial<TmdbItem>): string[];
}

const engines = new Map<ContentSourceId, ContentSourceEngine>();

export function registerContentSource(engine: ContentSourceEngine): void {
  engines.set(engine.id, engine);
}

export function getContentSource(id: ContentSourceId): ContentSourceEngine | undefined {
  return engines.get(id);
}

export function listContentSources(): ContentSourceEngine[] {
  return Array.from(engines.values());
}

/** Kaynağı olmayan (eski/etiketsiz) kayıtlar TMDB motoruna düşer. */
export function contentSourceFor(item: Partial<TmdbItem> | null | undefined): ContentSourceEngine | undefined {
  if (!item) return undefined;
  const direct = item.source ? engines.get(item.source) : undefined;
  if (direct) return direct;
  for (const engine of engines.values()) {
    if (engine.owns(item)) return engine;
  }
  return undefined;
}

export function resetContentSourceRegistry(): void {
  engines.clear();
}
