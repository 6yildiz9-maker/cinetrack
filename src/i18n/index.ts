export type SupportedLocale = 'tr' | 'en';

export interface TranslationDictionary {
  appName: string;
  searchPlaceholder: string;
  installApp: string;
  installIos: string;
  offlineBanner: string;
  offlinePendingSync: string;
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

const dictionaries: Record<SupportedLocale, TranslationDictionary> = {
  tr: {
    appName: 'CineTrack',
    searchPlaceholder: "Film veya dizi ara… (Kısayol: '/')",
    installApp: 'Uygulamayı Yükle',
    installIos: 'Ana Ekrana Ekle',
    offlineBanner: 'Çevrimdışı mod — önbellekteki veriler kullanılıyor.',
    offlinePendingSync: 'Bağlantı geldiğinde bekleyen değişiklikler eşitlenecek.',
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
  },
  en: {
    appName: 'CineTrack',
    searchPlaceholder: "Search movies or series… (Shortcut: '/')",
    installApp: 'Install App',
    installIos: 'Add to Home Screen',
    offlineBanner: 'Offline mode — showing cached catalog & library.',
    offlinePendingSync: 'Pending updates will sync automatically once online.',
    matchLabel: (score: number) => `Match: ${Math.max(1, Math.min(100, Math.round(score)))}/100`,
    conflictTitle: 'Data Sync Conflict',
    keepLocalButton: 'Keep Local Changes',
    useServerButton: 'Load Server Version',
    seasonCalendarTitle: 'Upcoming Episodes & Release Calendar',
    downloadIcsButton: 'Export Calendar (.ics)',
    tasteDnaTitle: 'Taste DNA Summary',
    csvImportExportTitle: 'CSV Import / Export (Letterboxd & IMDb)',
    jointWatchTitle: 'What Should We Watch Together?',
    journeyTimelineTitle: 'Watching Journey Timeline',
    backupsTitle: 'Server Snapshots & Restore',
  },
};

let activeLocale: SupportedLocale = 'tr';

export function getLocale(): SupportedLocale {
  return activeLocale;
}

export function setLocale(locale: SupportedLocale): void {
  activeLocale = locale === 'en' ? 'en' : 'tr';
}

export function t(): TranslationDictionary {
  return dictionaries[activeLocale];
}

export function formatMatchBadge(score: number): string {
  return dictionaries[activeLocale].matchLabel(score);
}
