import type { RelationshipType } from './relationship-explorer.ts';

export const STOP_WORDS = new Set([
  'acaba', 'ama', 'ancak', 'artık', 'aslında', 'bile', 'bir', 'birçok', 'bu',
  'bunun', 'daha', 'dahi', 'de', 'defa', 'diye', 'çok', 'en', 'gibi', 'hem',
  'hep', 'her', 'herhangi', 'için', 'ile', 'ise', 'kadar', 'karşı', 'kez',
  'ki', 'kim', 'mı', 'mi', 'mu', 'mü', 'nasıl', 'ne', 'neden', 'nerede',
  'neredeyse', 'niçin', 'o', 'olan', 'olarak', 'oldu', 'olduğu', 'olur',
  'onun', 've', 'veya', 'ya', 'yani', 'yeni', 'yine', 'yok', 'sonra',
  'önce', 'the', 'and', 'for', 'from', 'with', 'that', 'this', 'their',
  'they', 'then', 'when', 'where', 'who', 'what', 'into', 'about', 'have',
  'has', 'his', 'her', 'its', 'are', 'was', 'were', 'will', 'would',
]);

export const GENERIC_PLOT_WORDS = new Set([
  'hikaye', 'hikâye', 'konu', 'film', 'dizi', 'hayat', 'zaman',
  'birlikte', 'karşısında', 'mücadele', 'yolculuk', 'gerçek',
  'başlar', 'başlayan', 'olaylar', 'yaşanan', 'yaşayan',
  'dünyada', 'dünyanın', 'insanlar', 'kişiler', 'karakter',
]);

export const ATMOSPHERIC_TONE_WORDS = new Set([
  'karanlık', 'distopya', 'distopik', 'gizem', 'gizemli', 'psikolojik', 'uzay',
  'rüya', 'gerilim', 'sır', 'kabus', 'yalnızlık', 'melankoli', 'noir', 'atmosfer',
  'klostrofobik', 'tekinsiz', 'kıyamet', 'simülasyon', 'zihin', 'hafıza',
  'dark', 'dystopia', 'mystery', 'psychological', 'dream', 'isolation', 'tension', 'noir',
]);

export const DARK_ATMOSPHERE_GENRES = new Set([878, 9648, 53, 27, 80, 10765]);
export const IMAGINATIVE_ATMOSPHERE_GENRES = new Set([16, 14, 12, 10751]);
export const LIGHT_TONE_GENRES = new Set([35, 10751, 10749, 10402]);

export const TYPE_LABELS: Record<RelationshipType, string> = {
  semantic: 'Anlamsal benzerlik',
  person: 'Kişi bağlantısı',
  universe: 'Seri / evren bağlantısı',
  atmosphere: 'Atmosferik / duygusal yakınlık',
  contrast: 'Karşıt ton / tamamlayıcı deneyim',
  personal: 'Kişisel uyum',
};

export function getRelationshipTypeLabel(type: RelationshipType): string {
  return TYPE_LABELS[type] || 'İlişki';
}

export function getRelationshipNodeColor(node: { kind: string; personalScore: number }): string {
  if (node.kind === 'profile') return '#63b8ab';
  if (node.kind === 'source') return '#c98bab';
  if (node.kind === 'saved') return '#d3b579';
  if (node.personalScore >= 80) return '#6fbf8a';
  if (node.personalScore >= 60) return '#a58fd0';
  return '#94a3b8';
}

export function getRelationshipLinkColor(type: RelationshipType): string {
  switch (type) {
    case 'semantic':
      return '#d3b579';
    case 'person':
      return '#a58fd0';
    case 'universe':
      return '#6fbf8a';
    case 'atmosphere':
      return '#63b8ab';
    case 'contrast':
      return '#e0a064';
    case 'personal':
      return '#7b808b';
  }
}
