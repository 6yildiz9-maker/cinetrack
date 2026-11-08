/**
 * Tek marka kaynağı. Görünen ad, PWA başlığı, dışa aktarma dosya adları ve
 * sunucu User-Agent değerleri buradan türetilir.
 */
export const BRAND_NAME = 'Cinethos';
export const BRAND_TAGLINE = 'TMDB destekli kişisel film ve dizi izleme kataloğu';
export const BRAND_APP_TITLE = `${BRAND_NAME} — Kişisel Film & Dizi Kataloğu`;
export const BRAND_PROFILE_BASENAME = `${BRAND_NAME}_Profile`;
export const BRAND_SYNC_USER_AGENT = `${BRAND_NAME}-Sync-Agent`;
export const BRAND_BACKUP_USER_AGENT = `${BRAND_NAME}-Backup-Exporter/1.0`;
export const BRAND_CALENDAR_NAME = `${BRAND_NAME} Yayın Takvimi`;

export function brandProfileFileName(extension: string): string {
  return `${BRAND_PROFILE_BASENAME}.${extension}`;
}
