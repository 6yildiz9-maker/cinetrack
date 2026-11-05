// ===========================================================================
// Cinethos Taste Engine — TMDB Mappings (v1.0)
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

// === KEYWORD ID → METRİK EŞLEMESİ (Faz 6.5 — 25 metrik, 216 doğrulanmış TMDB ID) ===
export const KEYWORD_TO_METRIC: Record<number, string> = {
  // === MOOD (6) ===
  // mood.melancholic
  4232: "mood.melancholic", // melancholy
  9872: "mood.melancholic", // grief
  10752: "mood.melancholic", // sorrow
  1647: "mood.melancholic", // sadness
  159103: "mood.melancholic", // mourning
  697: "mood.melancholic", // loss of loved one
  34265: "mood.melancholic", // heartbreak
  9928: "mood.melancholic", // bereavement

  // mood.dark
  259094: "mood.dark", // dark
  230747: "mood.dark", // bleak
  210162: "mood.dark", // grim
  3762: "mood.dark", // darkness
  325822: "mood.dark", // gloomy
  2300: "mood.dark", // despair
  10614: "mood.dark", // tragedy
  1541: "mood.dark", // nihilism
  379729: "mood.dark", // noir

  // mood.hopeful
  3929: "mood.hopeful", // hope
  11436: "mood.hopeful", // redemption
  334465: "mood.hopeful", // uplifting
  383896: "mood.hopeful", // feel good
  325824: "mood.hopeful", // hopeful
  191446: "mood.hopeful", // inspiring
  281585: "mood.hopeful", // inspirational
  34004: "mood.hopeful", // second chance
  240: "mood.hopeful", // underdog

  // mood.tense
  10481: "mood.tense", // tension
  288394: "mood.tense", // suspense
  280263: "mood.tense", // anxiety
  325425: "mood.tense", // edge-of-your-seat
  2340: "mood.tense", // paranoia
  1562: "mood.tense", // hostage
  4776: "mood.tense", // race against time
  2147: "mood.tense", // claustrophobia
  15076: "mood.tense", // cat and mouse

  // mood.cozy
  319357: "mood.cozy", // heartwarming
  9914: "mood.cozy", // slice of life
  325784: "mood.cozy", // comforting
  326774: "mood.cozy", // cozy
  379058: "mood.cozy", // warm
  6054: "mood.cozy", // friendship
  10683: "mood.cozy", // coming of age
  1415: "mood.cozy", // small town
  7312: "mood.cozy", // road trip

  // mood.unsettling
  361070: "mood.unsettling", // disturbing
  210458: "mood.unsettling", // creepy
  272553: "mood.unsettling", // psychological
  357022: "mood.unsettling", // eerie
  345792: "mood.unsettling", // uneasy
  360104: "mood.unsettling", // uncomfortable
  3030: "mood.unsettling", // nightmare
  41410: "mood.unsettling", // madness
  1523: "mood.unsettling", // obsession
  6158: "mood.unsettling", // cult

  // === NARRATIVE (3 aktif) ===
  // narrative.non_linear
  157171: "narrative.non_linear", // nonlinear timeline
  4379: "narrative.non_linear", // time travel
  9856: "narrative.non_linear", // flashback
  334469: "narrative.non_linear", // multiple timelines
  262522: "narrative.non_linear", // non linear
  10854: "narrative.non_linear", // time loop

  // narrative.open_ending
  325763: "narrative.open_ending", // ambiguous
  384012: "narrative.open_ending", // open ended
  181324: "narrative.open_ending", // existentialism
  212737: "narrative.open_ending", // philosophical
  193294: "narrative.open_ending", // enigmatic

  // narrative.twist
  326438: "narrative.twist", // twist ending
  275311: "narrative.twist", // plot twist
  335567: "narrative.twist", // surprise ending
  3874: "narrative.twist", // twist
  10085: "narrative.twist", // betrayal
  9758: "narrative.twist", // deception
  12570: "narrative.twist", // whodunit
  33456: "narrative.twist", // double cross

  // === CONCEPT (6) ===
  // concept.identity
  1284: "concept.identity", // identity
  402: "concept.identity", // clone
  376610: "concept.identity", // doppelganger
  11469: "concept.identity", // memory loss
  1453: "concept.identity", // amnesia
  3394: "concept.identity", // identity crisis
  1308: "concept.identity", // secret identity
  156761: "concept.identity", // split personality

  // concept.mortality
  34079: "concept.mortality", // death
  4995: "concept.mortality", // aging
  6564: "concept.mortality", // terminal illness
  6155: "concept.mortality", // afterlife
  211431: "concept.mortality", // mortality
  41589: "concept.mortality", // dying
  236: "concept.mortality", // suicide
  4978: "concept.mortality", // immortality

  // concept.technology
  310: "concept.technology", // artificial intelligence (a.i.)
  14544: "concept.technology", // robot
  10919: "concept.technology", // cyber
  12361: "concept.technology", // hacking
  385630: "concept.technology", // ai
  1576: "concept.technology", // technology
  803: "concept.technology", // android
  4563: "concept.technology", // virtual reality
  679: "concept.technology", // cyborg
  18420: "concept.technology", // surveillance

  // concept.freedom
  158455: "concept.freedom", // oppression
  11196: "concept.freedom", // rebellion
  2020: "concept.freedom", // revolution
  10685: "concept.freedom", // escape
  6089: "concept.freedom", // freedom
  2434: "concept.freedom", // liberation
  378: "concept.freedom", // prison
  2831: "concept.freedom", // slavery
  836: "concept.freedom", // resistance

  // concept.love
  9673: "concept.love", // love
  14534: "concept.love", // relationship
  328555: "concept.love", // family bonds
  215295: "concept.love", // love story
  6038: "concept.love", // marriage
  13072: "concept.love", // falling in love
  10048: "concept.love", // unrequited love
  3691: "concept.love", // forbidden love
  240119: "concept.love", // father son relationship
  240315: "concept.love", // mother daughter relationship

  // concept.power
  6078: "concept.power", // politics
  417: "concept.power", // corruption
  11195: "concept.power", // empire
  7606: "concept.power", // dictatorship
  288793: "concept.power", // power
  264792: "concept.power", // political
  4833: "concept.power", // royal family
  2471: "concept.power", // monarchy

  // === CHARACTER (2 aktif) ===
  // character.antihero
  2095: "character.antihero", // anti hero
  15002: "character.antihero", // dark hero
  7002: "character.antihero", // vigilante
  9503: "character.antihero", // outlaw
  2708: "character.antihero", // hitman
  9748: "character.antihero", // revenge
  10051: "character.antihero", // heist
  3149: "character.antihero", // gangster
  782: "character.antihero", // assassin

  // character.solitary
  1533: "character.solitary", // isolation
  9957: "character.solitary", // loneliness
  3568: "character.solitary", // lone wolf
  10349: "character.solitary", // survival
  197573: "character.solitary", // solitary
  6511: "character.solitary", // alone
  9743: "character.solitary", // stranded
  4271: "character.solitary", // hermit

  // === STYLE (2 aktif) ===
  // style.surreal
  3307: "style.surreal", // surreal
  232997: "style.surreal", // dreamlike
  3298: "style.surreal", // hallucination
  213891: "style.surreal", // abstract
  9887: "style.surreal", // surrealism
  346773: "style.surreal", // dream
  333529: "style.surreal", // magical realism
  291176: "style.surreal", // alternate reality game
  184392: "style.surreal", // psychedelic

  // style.stylized
  9822: "style.stylized", // neon
  237867: "style.stylized", // stylized
  385072: "style.stylized", // visually striking
  12190: "style.stylized", // cyberpunk
  207268: "style.stylized", // neo-noir
  210024: "style.stylized", // anime
  10028: "style.stylized", // steampunk
  779: "style.stylized", // martial arts
  9715: "style.stylized", // superhero

  // === SETTING (3 aktif) ===
  // setting.dystopia
  4565: "setting.dystopia", // dystopia
  359337: "setting.dystopia", // post-apocalyptic
  4458: "setting.dystopia", // post-apocalyptic future
  10689: "setting.dystopia", // wasteland
  180440: "setting.dystopia", // totalitarian
  386351: "setting.dystopia", // dystopian
  12332: "setting.dystopia", // apocalypse
  318: "setting.dystopia", // police state

  // setting.space
  9882: "setting.space", // space
  252937: "setting.space", // spaceship
  14626: "setting.space", // astronaut
  10158: "setting.space", // alien planet
  252634: "setting.space", // outer space
  3801: "setting.space", // space travel
  156039: "setting.space", // space station
  9951: "setting.space", // alien
  161176: "setting.space", // space opera

  // setting.historical
  15126: "setting.historical", // historical
  243594: "setting.historical", // period
  207928: "setting.historical", // 19th century
  161257: "setting.historical", // medieval
  273967: "setting.historical", // war
  15060: "setting.historical", // period drama
  1956: "setting.historical", // world war ii
  2504: "setting.historical", // world war i
  5049: "setting.historical", // ancient rome
  2106: "setting.historical", // cold war
  9672: "setting.historical", // based on true story
  5565: "setting.historical", // biography

  // === TV'de keyword'den türetilen genre'lar (3) ===
  // genre.thriller
  316362: "genre.thriller", // thriller
  12565: "genre.thriller", // psychological thriller
  10410: "genre.thriller", // conspiracy
  10714: "genre.thriller", // serial killer
  5265: "genre.thriller", // espionage
  1930: "genre.thriller", // kidnapping
  9826: "genre.thriller", // murder
  703: "genre.thriller", // detective
  5340: "genre.thriller", // investigation

  // genre.horror
  315058: "genre.horror", // horror
  385522: "genre.horror", // scary
  270308: "genre.horror", // terror
  319857: "genre.horror", // frightening
  6152: "genre.horror", // supernatural
  162846: "genre.horror", // ghost
  12339: "genre.horror", // slasher
  12377: "genre.horror", // zombie
  3133: "genre.horror", // vampire
  1299: "genre.horror", // monster
  15001: "genre.horror", // demon

  // genre.romance
  9840: "genre.romance", // romance
  324429: "genre.romance", // romantic
  386551: "genre.romance", // romantic comedy
  4663: "genre.romance", // lovers
  9986: "genre.romance", // crush
  13043: "genre.romance", // dating
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
