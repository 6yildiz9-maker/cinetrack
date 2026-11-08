/**
 * Mood & Atmosphere Affinity Engine (Cinethos Core)
 *
 * Evaluates candidate films and series against selected viewing moods
 * (e.g. 'dark', 'thoughtful', 'feel-good', 'mind-bending', 'cheerful', 'deep', 'thrilling', 'romantic')
 * using genuine multi-dimensional content features:
 * 1. Genre alignment & conflicting-genre penalties
 * 2. Story synopsis / overview tone-word tokens
 * 3. TMDB keyword taxonomy affinity
 * 4. Deterministic scoring with safe neutral (0.50) fallback
 */

export interface MoodAffinityResult {
  mood: string;
  normalizedMood: string;
  label: string;
  atmosphereScore: number;       // 0.00 .. 1.00 composite atmosphere affinity
  genreScore: number;            // 0.00 .. 1.00 genre alignment
  textScore: number;             // 0.00 .. 1.00 tone and synopsis alignment
  keywordScore: number;          // 0.00 .. 1.00 TMDB keyword alignment
  matchedFeatures: string[];     // Human-readable matches
  opposingFeatures: string[];    // Human-readable opposing factors
  isNeutralFallback: boolean;    // True when feature data is missing or mood unrecognized
}

interface MoodConfig {
  id: string;
  label: string;
  positiveGenres: number[];
  negativeGenres: number[];
  toneWords: Set<string>;
  opposingToneWords: Set<string>;
  positiveKeywordIds: Set<number>;
  opposingKeywordIds: Set<number>;
}

const STOP_WORDS = new Set([
  'bir', 've', 'ile', 'için', 'olan', 'olarak', 'gibi', 'bu', 'şu', 'o',
  'kendi', 'daha', 'çok', 'en', 'kadar', 'sonra', 'önce', 'ancak', 'fakat',
  'the', 'and', 'with', 'for', 'that', 'from', 'into', 'after', 'about',
]);

const GENERIC_WORDS = new Set([
  'film', 'dizi', 'hikaye', 'konu', 'anlatır', 'yaşar', 'başlar', 'karakter',
  'movie', 'series', 'story', 'about', 'follows', 'lives', 'begins', 'character',
]);

function tokenize(text: string): Set<string> {
  const normalized = String(text || '')
    .toLocaleLowerCase('tr-TR')
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}]+/gu, ' ');

  const tokens = new Set<string>();
  for (const raw of normalized.split(/\s+/u)) {
    const word = raw.trim();
    if (word.length >= 3 && !STOP_WORDS.has(word) && !GENERIC_WORDS.has(word) && !/^\d+$/.test(word)) {
      tokens.add(word);
    }
  }
  return tokens;
}

const MOOD_CONFIGS: Record<string, MoodConfig> = {
  dark: {
    id: 'dark',
    label: 'Karanlık / Psikolojik',
    positiveGenres: [53, 27, 80, 9648, 878], // Gerilim, Korku, Suç, Gizem, Bilim Kurgu
    negativeGenres: [10751, 10762, 35, 10402], // Aile, Çocuk, Komedi, Müzik
    toneWords: new Set([
      'karanlık', 'distopya', 'distopik', 'gizem', 'gizemli', 'psikolojik', 'gerilim', 'cinayet',
      'noir', 'tekinsiz', 'ölüm', 'katil', 'kabus', 'korku', 'paranoya', 'sır', 'izolasyon',
      'suç', 'klostrofobik', 'kıyamet', 'kötülük', 'cehennem', 'kurban', 'çete', 'soruşturma',
      'dark', 'dystopia', 'dystopian', 'mystery', 'psychological', 'thriller', 'noir', 'murder',
      'killer', 'horror', 'crime', 'creepy', 'unsettling', 'paranoia', 'nightmare', 'bleak', 'grim',
    ]),
    opposingToneWords: new Set([
      'neşeli', 'komik', 'kahkaha', 'eğlence', 'eğlenceli', 'çocuk', 'şaka', 'romantik', 'sıcak',
      'sevimli', 'oyuncaklar', 'funny', 'cheerful', 'wholesome', 'comedy', 'family', 'sweet', 'joyful',
    ]),
    positiveKeywordIds: new Set([
      259094, 230747, 210162, 3762, 325822, 2300, 10614, 1541, 379729, // mood.dark
      361070, 210458, 272553, 357022, 345792, 360104, 3030, 41410, 1523, 6158, // mood.unsettling
      10481, 288394, 280263, 325425, 2340, 1562, 4776, 2147, 15076, // mood.tense
      9748, 158455, // revenge, oppression
    ]),
    opposingKeywordIds: new Set([
      319357, 325784, 326774, 379058, 6054, // cozy/warm
      3929, 383896, 334465, // feel good / uplifting
    ]),
  },
  thoughtful: {
    id: 'thoughtful',
    label: 'Düşündür / Felsefi',
    positiveGenres: [18, 878, 99, 36, 9648, 10765], // Dram, Bilim Kurgu, Belgesel, Tarih, Gizem
    negativeGenres: [10762], // Çocuk
    toneWords: new Set([
      'felsefe', 'felsefi', 'zihin', 'hafıza', 'varoluş', 'varoluşsal', 'simülasyon', 'düşünce',
      'anlam', 'evren', 'insanlık', 'bilinç', 'sorgulama', 'hakikat', 'paradoks', 'derin', 'etik',
      'philosophical', 'existential', 'mind', 'memory', 'identity', 'universe', 'consciousness',
      'humanity', 'simulation', 'ethics', 'truth', 'paradox', 'thought',
    ]),
    opposingToneWords: new Set([
      'aptalca', 'ucuz', 'gırgır', 'slapstick', 'silly', 'mindless',
    ]),
    positiveKeywordIds: new Set([
      325763, 384012, 181324, 212737, 193294, // open ending / existentialism / philosophical
      1284, 402, 376610, 11469, 1453, 3394, 1308, 156761, // concept.identity
      310, 14544, 10919, 12361, 385630, 1576, 803, 4563, 679, 18420, // concept.technology
    ]),
    opposingKeywordIds: new Set([]),
  },
  'feel-good': {
    id: 'feel-good',
    label: 'Rahatlat / Huzur',
    positiveGenres: [35, 10751, 16, 10749, 10402, 12], // Komedi, Aile, Animasyon, Romantik, Müzik, Macera
    negativeGenres: [27, 53, 80, 10752], // Korku, Gerilim, Suç, Savaş
    toneWords: new Set([
      'huzur', 'sıcak', 'tatlı', 'dostluk', 'umut', 'mutluluk', 'aile', 'arkadaşlık', 'romantik',
      'neşeli', 'birliktelik', 'sakin', 'konfor', 'iyilik', 'samimi', 'şefkat', 'rahatlatıcı',
      'cozy', 'warm', 'heartwarming', 'friendship', 'wholesome', 'gentle', 'hope', 'kindness',
      'uplifting', 'peaceful', 'comfort', 'family', 'sweet',
    ]),
    opposingToneWords: new Set([
      'korku', 'vahşet', 'cinayet', 'kan', 'işkence', 'dehşet', 'kabus', 'katliam',
      'horror', 'brutal', 'murder', 'gore', 'torture', 'terror', 'bloody',
    ]),
    positiveKeywordIds: new Set([
      319357, 9914, 325784, 326774, 379058, 6054, 10683, 1415, 7312, // mood.cozy
      3929, 11436, 334465, 383896, 325824, 191446, 281585, 34004, 240, // mood.hopeful
      9673, 14534, 328555, 215295, 6038, 13072, // concept.love
    ]),
    opposingKeywordIds: new Set([
      259094, 230747, 210162, 3762, 361070, 210458, 3030, // dark/unsettling
    ]),
  },
  'mind-bending': {
    id: 'mind-bending',
    label: 'Şaşırt / Zihin Bükücü',
    positiveGenres: [878, 9648, 53, 14, 10765], // Bilim Kurgu, Gizem, Gerilim, Fantastik
    negativeGenres: [10751, 10762], // Aile, Çocuk
    toneWords: new Set([
      'ters', 'köşe', 'paradoks', 'zaman', 'yolculuğu', 'twist', 'rüya', 'simülasyon',
      'sürpriz', 'kurgu', 'bilinçaltı', 'labirent', 'yanılsama', 'hafıza', 'manipülasyon',
      'paralel', 'illüzyon', 'gizem', 'gizemli', 'şok', 'şaşırtıcı', 'akıl',
      'mind', 'bending', 'time', 'travel', 'twist', 'loop', 'illusion', 'puzzle',
      'reality', 'multiverse', 'subconscious', 'maze', 'paradox', 'shocking',
    ]),
    opposingToneWords: new Set([
      'tahmin', 'edilebilir', 'basit', 'düz', 'standart', 'predictable', 'simple',
    ]),
    positiveKeywordIds: new Set([
      326438, 275311, 335567, 3874, 10085, 9758, 12570, 33456, // narrative.twist
      157171, 4379, 9856, 334469, 262522, 10854, // narrative.non_linear
      310, 4563, 1576, // technology / vr
    ]),
    opposingKeywordIds: new Set([]),
  },
  cheerful: {
    id: 'cheerful',
    label: 'Moral Yükselt / Neşeli',
    positiveGenres: [35, 10751, 16, 12, 10402], // Komedi, Aile, Animasyon, Macera, Müzik
    negativeGenres: [27, 10752, 53], // Korku, Savaş, Gerilim
    toneWords: new Set([
      'kahkaha', 'eğlence', 'komik', 'neşeli', 'moral', 'enerji', 'macera', 'gülümseme',
      'şaka', 'keyifli', 'eğlenceli', 'coşku', 'mizah', 'kahkahalarla', 'şenlik',
      'comedy', 'funny', 'joy', 'humor', 'adventure', 'cheerful', 'laughter',
      'hilarious', 'fun', 'amusing', 'entertaining', 'celebration',
    ]),
    opposingToneWords: new Set([
      'trajedi', 'yas', 'keder', 'katliam', 'ölüm', 'karanlık', 'tragedy', 'grief', 'sorrow',
    ]),
    positiveKeywordIds: new Set([
      319357, 383896, 334465, 325824, 6054, // feel good, uplifting, friendship
    ]),
    opposingKeywordIds: new Set([
      4232, 9872, 10752, 1647, // melancholic / grief
      259094, 210162, 3762, // dark
    ]),
  },
  deep: {
    id: 'deep',
    label: 'Ağır / Derin Dram',
    positiveGenres: [18, 36, 10752, 99, 10768], // Dram, Tarih, Savaş, Belgesel, Savaş & Politik
    negativeGenres: [10751, 10762], // Aile, Çocuk
    toneWords: new Set([
      'trajedi', 'savaş', 'yıkım', 'vicdan', 'acı', 'derin', 'ağır', 'kayıp', 'yüzleşme',
      'yalnızlık', 'yas', 'melankoli', 'dramatik', 'tarihsel', 'bunalım', 'hüzün', 'pişmanlık',
      'drama', 'historical', 'tragedy', 'grief', 'suffering', 'moral', 'loss', 'war',
      'sorrow', 'heavy', 'devastating', 'melancholy', 'regret',
    ]),
    opposingToneWords: new Set([
      'hafif', 'şaka', 'slapstick', 'parodi', 'silly', 'lighthearted',
    ]),
    positiveKeywordIds: new Set([
      4232, 9872, 10752, 1647, 159103, 697, 34265, 9928, // mood.melancholic
      34079, 4995, 6564, 6155, 211431, 41589, 236, 4978, // concept.mortality
      158455, 11196, 2020, 10685, 6089, 2434, 378, 2831, 836, // concept.freedom
    ]),
    opposingKeywordIds: new Set([
      383896, 334465, // feel good / uplifting
    ]),
  },
  thrilling: {
    id: 'thrilling',
    label: 'Gerilimli / Adrenalin',
    positiveGenres: [53, 28, 80, 9648, 12, 10759], // Gerilim, Aksiyon, Suç, Gizem, Macera
    negativeGenres: [10751, 10762], // Aile, Çocuk
    toneWords: new Set([
      'gerilim', 'adrenalin', 'aksiyon', 'kovalamaca', 'tehlike', 'suç', 'tempo', 'kaçış',
      'rehin', 'baskın', 'patlama', 'çatışma', 'heyecan', 'yarış', 'operasyon',
      'thriller', 'action', 'chase', 'suspense', 'danger', 'hostage', 'escape',
      'high octane', 'explosive', 'race', 'operation', 'tense',
    ]),
    opposingToneWords: new Set([
      'sakin', 'durgun', 'ağırkanlı', 'slow burn', 'peaceful', 'static',
    ]),
    positiveKeywordIds: new Set([
      10481, 288394, 280263, 325425, 2340, 1562, 4776, 2147, 15076, // mood.tense
      9748, 10685, // revenge, escape
    ]),
    opposingKeywordIds: new Set([]),
  },
  romantic: {
    id: 'romantic',
    label: 'Romantik / Duygusal',
    positiveGenres: [10749, 35, 18], // Romantik, Komedi, Dram
    negativeGenres: [27, 10752], // Korku, Savaş
    toneWords: new Set([
      'aşk', 'romantik', 'sevgili', 'ilişki', 'tutku', 'evlilik', 'kavuşma', 'flört',
      'bağlılık', 'sevgi', 'kalp', 'çekim', 'ayrılık', 'romantizm',
      'romance', 'love', 'passion', 'relationship', 'dating', 'marriage', 'romantic',
      'lovers', 'attraction', 'soulmate',
    ]),
    opposingToneWords: new Set([
      'vahşet', 'katliam', 'işkence', 'soğuk', 'horror', 'brutal', 'slaughter',
    ]),
    positiveKeywordIds: new Set([
      9673, 14534, 328555, 215295, 6038, 13072, 10048, 3691, 240119, // concept.love
    ]),
    opposingKeywordIds: new Set([]),
  },
};

/**
 * Normalizes user-entered or UI-selected mood string to a canonical mood ID.
 */
export function normalizeMoodKey(rawMood: string): string {
  const normalized = String(rawMood || '')
    .trim()
    .toLocaleLowerCase('tr-TR')
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

  if (!normalized) return '';

  if (
    normalized.includes('karanl') ||
    normalized.includes('dark') ||
    normalized.includes('psiko') ||
    normalized.includes('noir') ||
    normalized.includes('tekinsiz')
  ) {
    return 'dark';
  }
  if (
    normalized.includes('şaşır') ||
    normalized.includes('mind') ||
    normalized.includes('bend') ||
    normalized.includes('ters k') ||
    normalized.includes('paradoks')
  ) {
    return 'mind-bending';
  }
  if (
    normalized.includes('düşün') ||
    normalized.includes('thought') ||
    normalized.includes('felsef') ||
    normalized.includes('zihin')
  ) {
    return 'thoughtful';
  }
  if (
    normalized.includes('rahat') ||
    normalized.includes('feel good') ||
    normalized.includes('feelgood') ||
    normalized.includes('sakin') ||
    normalized.includes('huzur') ||
    normalized.includes('konfor')
  ) {
    return 'feel-good';
  }
  if (
    normalized.includes('moral') ||
    normalized.includes('cheer') ||
    normalized.includes('eğlen') ||
    normalized.includes('komik') ||
    normalized.includes('neşeli')
  ) {
    return 'cheerful';
  }
  if (
    normalized.includes('ağır') ||
    normalized.includes('deep') ||
    normalized.includes('derin') ||
    normalized.includes('yoğun dram')
  ) {
    return 'deep';
  }
  if (
    normalized.includes('gerilim') ||
    normalized.includes('thrill') ||
    normalized.includes('adrenalin') ||
    normalized.includes('enerj')
  ) {
    return 'thrilling';
  }
  if (normalized.includes('roman') || normalized.includes('aşk') || normalized.includes('duygusal')) {
    return 'romantic';
  }

  // Exact fallback if exists in configs
  if (MOOD_CONFIGS[normalized]) {
    return normalized;
  }

  return normalized;
}

function extractGenreIds(candidate: any): number[] {
  if (!candidate || typeof candidate !== 'object') return [];
  const list: number[] = [];
  if (Array.isArray(candidate.genre_ids)) {
    for (const gid of candidate.genre_ids) {
      const n = Number(gid);
      if (Number.isFinite(n) && n > 0) list.push(n);
    }
  } else if (Array.isArray(candidate.genres)) {
    for (const g of candidate.genres) {
      const n = typeof g === 'object' && g !== null ? Number(g.id) : Number(g);
      if (Number.isFinite(n) && n > 0) list.push(n);
    }
  }
  return [...new Set(list)];
}

function extractKeywordIds(candidate: any): number[] {
  if (!candidate || typeof candidate !== 'object') return [];
  const list: number[] = [];
  const rawList = Array.isArray(candidate.keywords)
    ? candidate.keywords
    : Array.isArray(candidate.keyword_ids)
    ? candidate.keyword_ids
    : [];

  for (const item of rawList) {
    if (typeof item === 'object' && item !== null && 'id' in item) {
      const n = Number(item.id);
      if (Number.isFinite(n)) list.push(n);
    } else {
      const n = Number(item);
      if (Number.isFinite(n)) list.push(n);
    }
  }
  return [...new Set(list)];
}

/**
 * Calculates genuine multi-dimensional mood and atmosphere affinity for a candidate.
 * Returns 0.50 neutral fallback if mood is unmapped or candidate has no feature data.
 */
export function calculateMoodAffinity(candidate: any, rawMood: string): MoodAffinityResult {
  const normKey = normalizeMoodKey(rawMood);
  const config = MOOD_CONFIGS[normKey];

  if (!config) {
    return {
      mood: rawMood,
      normalizedMood: normKey,
      label: rawMood || 'Belirtilmemiş',
      atmosphereScore: 0.5,
      genreScore: 0.5,
      textScore: 0.5,
      keywordScore: 0.5,
      matchedFeatures: [],
      opposingFeatures: [],
      isNeutralFallback: true,
    };
  }

  const candidateGenres = extractGenreIds(candidate);
  const candidateKeywords = extractKeywordIds(candidate);
  const synopsisText = `${candidate?.title || candidate?.name || ''} ${candidate?.overview || ''}`;
  const candidateTokens = tokenize(synopsisText);

  const matchedFeatures: string[] = [];
  const opposingFeatures: string[] = [];

  // 1. GENRE AFFINITY
  let genreScore = 0.5;
  const hasGenreData = candidateGenres.length > 0;
  if (hasGenreData) {
    const posMatches = candidateGenres.filter((id) => config.positiveGenres.includes(id));
    const negMatches = candidateGenres.filter((id) => config.negativeGenres.includes(id));

    if (posMatches.length > 0) {
      matchedFeatures.push(...posMatches.map((id) => `Tür: #${id}`));
    }
    if (negMatches.length > 0) {
      opposingFeatures.push(...negMatches.map((id) => `Çelişen tür: #${id}`));
    }

    if (posMatches.length > 0 && negMatches.length === 0) {
      // Strong genre fit: 0.82 to 0.96 based on match density
      const ratio = posMatches.length / Math.min(candidateGenres.length, 3);
      genreScore = Math.min(0.96, 0.80 + ratio * 0.16);
    } else if (posMatches.length > 0 && negMatches.length > 0) {
      // Mixed genres (e.g. Action-Comedy or Dark Comedy)
      genreScore = Math.max(0.40, Math.min(0.70, 0.55 + (posMatches.length - negMatches.length) * 0.10));
    } else if (negMatches.length > 0) {
      // Purely opposing genres (e.g. Children's cartoon when Dark is selected)
      const ratio = negMatches.length / candidateGenres.length;
      genreScore = Math.max(0.12, 0.28 - ratio * 0.16);
    } else {
      // Neutral genres (e.g. general documentary)
      genreScore = 0.50;
    }
  }

  // 2. TEXT / SYNOPSIS TONE AFFINITY
  let textScore = 0.5;
  const hasTextData = candidateTokens.size > 0;
  if (hasTextData) {
    let posCount = 0;
    let negCount = 0;
    for (const tok of candidateTokens) {
      if (config.toneWords.has(tok)) {
        posCount++;
        matchedFeatures.push(`Ton: "${tok}"`);
      } else if (config.opposingToneWords.has(tok)) {
        negCount++;
        opposingFeatures.push(`Zıt ton: "${tok}"`);
      }
    }

    if (posCount > 0 && negCount === 0) {
      // 1 match -> 0.72, 2 -> 0.85, 3+ -> 0.95
      textScore = Math.min(0.96, 0.65 + posCount * 0.10);
    } else if (posCount > 0 && negCount > 0) {
      textScore = Math.max(0.35, Math.min(0.75, 0.50 + (posCount - negCount) * 0.10));
    } else if (negCount > 0) {
      textScore = Math.max(0.15, 0.35 - negCount * 0.08);
    } else {
      textScore = 0.48; // No matching or opposing tone words
    }
  }

  // 3. TMDB KEYWORD TAXONOMY AFFINITY
  let keywordScore = 0.5;
  const hasKeywordData = candidateKeywords.length > 0;
  if (hasKeywordData) {
    let posCount = 0;
    let negCount = 0;
    for (const kid of candidateKeywords) {
      if (config.positiveKeywordIds.has(kid)) {
        posCount++;
        matchedFeatures.push(`Keyword #${kid}`);
      } else if (config.opposingKeywordIds.has(kid)) {
        negCount++;
        opposingFeatures.push(`Zıt keyword #${kid}`);
      }
    }

    if (posCount > 0 && negCount === 0) {
      keywordScore = Math.min(0.96, 0.75 + posCount * 0.10);
    } else if (posCount > 0 && negCount > 0) {
      keywordScore = 0.55;
    } else if (negCount > 0) {
      keywordScore = 0.20;
    } else {
      keywordScore = 0.50;
    }
  }

  // 4. COMPOSITE ATMOSPHERE SCORE
  // Weight dynamically depending on available feature fields
  let compositeScore = 0.5;
  const isNeutralFallback = !hasGenreData && !hasTextData && !hasKeywordData;

  if (isNeutralFallback) {
    compositeScore = 0.5;
  } else if (hasGenreData && hasTextData && hasKeywordData) {
    compositeScore = 0.45 * genreScore + 0.35 * textScore + 0.20 * keywordScore;
  } else if (hasGenreData && hasTextData) {
    compositeScore = 0.55 * genreScore + 0.45 * textScore;
  } else if (hasGenreData && hasKeywordData) {
    compositeScore = 0.60 * genreScore + 0.40 * keywordScore;
  } else if (hasGenreData) {
    compositeScore = genreScore;
  } else if (hasTextData) {
    compositeScore = textScore;
  } else {
    compositeScore = keywordScore;
  }

  // Bound to 2 decimal places [0.05 .. 0.98]
  const roundedAtmosphere = Math.round(Math.max(0.05, Math.min(0.98, compositeScore)) * 100) / 100;

  return {
    mood: rawMood,
    normalizedMood: normKey,
    label: config.label,
    atmosphereScore: roundedAtmosphere,
    genreScore: Math.round(genreScore * 100) / 100,
    textScore: Math.round(textScore * 100) / 100,
    keywordScore: Math.round(keywordScore * 100) / 100,
    matchedFeatures: [...new Set(matchedFeatures)].slice(0, 5),
    opposingFeatures: [...new Set(opposingFeatures)].slice(0, 3),
    isNeutralFallback,
  };
}
