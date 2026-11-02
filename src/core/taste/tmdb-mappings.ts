// ===========================================================================
// CineTrack Taste Engine — TMDB Mappings (v1.0)
// Medya bazlı, ID tabanlı, sürümlü (TP-012)
// ===========================================================================

// === FİLM GENRE ID'LERİ ===
export const MOVIE_GENRE_IDS = {
  scifi: 878,
  fantasy: 14,
  thriller: 53,
  horror: 27,
  drama: 18,
  comedy: 35,
  crime: 80,
  animation: 16,
  documentary: 99,
  romance: 10749, // DİKKAT: 10751 = Aile!
} as const;

// === TV GENRE ID'LERİ ===
// TV'de bazı türler birleşik veya keyword'den türetilir
export const TV_GENRE_IDS = {
  scifi_fantasy: 10765, // Sci-Fi & Fantasy birleşik
  drama: 18,
  comedy: 35,
  crime: 80,
  animation: 16,
  documentary: 99,
  // TV'de ayrı horror/thriller/romance YOK → keyword'den türet
} as const;

// === KEYWORD ID → METRİK EŞLEMESİ ===
// Faz 0'ta TMDB API'den çekilip sayısal ID'lerle doldurulacak
// Şimdilik placeholder; gerçek ID'ler Faz 1'de doğrulanacak
export const KEYWORD_TO_METRIC: Record<number, string> = {
  // Mood
  // 1234: "mood.melancholic", // melancholy
  // 1235: "mood.melancholic", // grief
  // ...

  // Narrative
  // 2345: "narrative.non_linear", // nonlinear
  // ...

  // Concept
  // 3456: "concept.identity", // identity
  // ...

  // Character
  // 4567: "character.antihero", // antihero
  // ...

  // Style
  // 5678: "style.surreal", // surreal
  // ...

  // Setting
  // 6789: "setting.dystopia", // dystopia
  // ...
};

// === ORIGIN KURALLARI ===
export const ORIGIN_RULES = {
  asian_cinema: {
    languages: ["ko", "ja", "zh", "th"],
    countries: ["KR", "JP", "CN", "TH"],
  },
  european: {
    countries: ["FR", "DE", "SE", "NO", "DK", "UK", "IT", "ES"],
  },
  turkish: {
    languages: ["tr"],
    countries: ["TR"],
  },
} as const;

// === FORMAT KURALLARI (sadece TV) ===
export const FORMAT_RULES = {
  miniseries: {
    seasons: 1,
    minEpisodeRuntime: 40,
  },
  long_running: {
    minSeasons: 3,
  },
} as const;

// === Yardımcı fonksiyonlar ===
export function getMovieGenreId(metricId: string): number | undefined {
  const key = metricId.replace("genre.", "") as keyof typeof MOVIE_GENRE_IDS;
  return MOVIE_GENRE_IDS[key];
}

export function getTvGenreId(metricId: string): number | undefined {
  // TV'de scifi ve fantasy birleşik
  if (metricId === "genre.scifi" || metricId === "genre.fantasy") {
    return TV_GENRE_IDS.scifi_fantasy;
  }
  const key = metricId.replace("genre.", "") as keyof typeof TV_GENRE_IDS;
  return TV_GENRE_IDS[key];
}

export function getKeywordIdsForMetric(metricId: string): number[] {
  return Object.entries(KEYWORD_TO_METRIC)
    .filter(([, metric]) => metric === metricId)
    .map(([id]) => Number(id));
}
