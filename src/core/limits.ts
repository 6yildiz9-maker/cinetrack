/**
 * CineTrack — Paylaşılan Veri Boyutu ve Koleksiyon Sınırları (Tek Kaynak)
 *
 * Seçim gerekçesi:
 * - Gerçek kullanıcı kütüphanesi (~1.250 film/dizi kaydı + zengin metaveri) yaklaşık 2.2 MB yer kaplar.
 * - Eski 2 MB sınırı gerçek yedek yüklemelerini engellediği için yetersizdir; 100 MB ise tek seferlik
 *   senkron JSON ayrıştırma belleği açısından gereksiz yük oluşturur.
 * - 25 MiB (26.214.400 bayt) sınırı ~15.000+ zengin öğeli çok profilli arşivleri rahatça desteklerken
 *   sunucu bellek tüketimini güvenli aralıkta tutar.
 */
export const DEFAULT_MAX_DATA_BYTES = 25 * 1024 * 1024; // 26_214_400 bayt (25 MiB)
export const DEFAULT_MAX_PROFILES = 20;
export const DEFAULT_MAX_ITEMS_PER_PROFILE = 25_000;
export const DEFAULT_MAX_SNAPSHOTS = 7;

/**
 * UTF-8 bayt uzunluğunu hesaplar (karakter sayısını bayt sayısı yerine kullanmaz).
 */
export function measureUtf8Bytes(input: string | Uint8Array): number {
  if (typeof input !== 'string') {
    return input.byteLength;
  }
  if (typeof Buffer !== 'undefined' && typeof Buffer.byteLength === 'function') {
    return Buffer.byteLength(input, 'utf8');
  }
  return new TextEncoder().encode(input).byteLength;
}

export function formatMaxDataLimitMb(bytes: number = DEFAULT_MAX_DATA_BYTES): string {
  const mib = bytes / (1024 * 1024);
  return Number.isInteger(mib) ? `${mib} MB` : `${mib.toFixed(1)} MB`;
}
