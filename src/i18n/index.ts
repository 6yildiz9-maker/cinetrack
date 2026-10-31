export type SupportedLocale = 'tr';

export interface TranslationDictionary {
  appName: string;
  searchPlaceholder: string;
  installApp: string;
  installIos: string;
  offlineBanner: string;
  offlinePendingSync: string;
  offlineQuotaWarning: string;
  matchLabel: (score: number) => string;
  conflictTitle: string;
  keepLocalButton: string;
  useServerButton: string;
  seasonCalendarTitle: string;
  downloadIcsButton: string;
  tasteDnaTitle: string;
  csvImportExportTitle: string;
  jointWatchTitle: string;
  journeyTimelineTitle: string;
  backupsTitle: string;
}

const trDictionary: TranslationDictionary = {
  appName: 'CineTrack',
  searchPlaceholder: "Film veya dizi ara… (Kısayol: '/')",
  installApp: 'Uygulamayı Yükle',
  installIos: 'Ana Ekrana Ekle',
  offlineBanner: 'Çevrimdışı mod — önbellekteki veriler kullanılıyor.',
  offlinePendingSync: 'Bağlantı geldiğinde bekleyen değişiklikler eşitlenecek.',
  offlineQuotaWarning:
    'Tarayıcı depolama alanı dolu — bekleyen çevrimdışı değişiklikler yalnızca bu sekmede bellekte tutuluyor; sayfayı kapatmadan bağlantıyı kontrol edin veya JSON yedeği indirin.',
  matchLabel: (score: number) => `Uyum: ${Math.max(1, Math.min(100, Math.round(score)))}/100`,
  conflictTitle: 'Veri Eşitleme Uyarısı',
  keepLocalButton: 'Bu Cihazdaki Veriyi Koru',
  useServerButton: 'Sunucudaki Veriyi Yükle',
  seasonCalendarTitle: 'Yaklaşan Bölüm & Yayın Takvimi',
  downloadIcsButton: 'Takvime Aktar (.ics)',
  tasteDnaTitle: 'Zevk DNA Özeti',
  csvImportExportTitle: 'CSV İçe / Dışa Aktar (Letterboxd & IMDb)',
  jointWatchTitle: 'Birlikte Ne İzlesek?',
  journeyTimelineTitle: 'İzleme Yolculuğu Zaman Çizelgesi',
  backupsTitle: 'Sunucu Yedekleri ve Geri Yükleme',
};

export function getLocale(): SupportedLocale {
  return 'tr';
}

export function t(key?: keyof TranslationDictionary): any {
  if (key && key in trDictionary) {
    return trDictionary[key];
  }
  return trDictionary;
}

export function formatMatchBadge(score: number): string {
  return trDictionary.matchLabel(score);
}
