#!/usr/bin/env node
// ===========================================================================
// Cinethos Taste Engine — Keyword ID Fetcher (Faz 6.5)
//
// 42 metriğin keyword eşleşmelerini TMDB API'den otomatik çeker.
// Sonuçları:
// 1. data/taste/keyword-mappings.json (validate-real-data.mjs'in kullanacağı dosya)
// 2. scripts/keyword-verification.csv (manuel doğrulama için)
//
// MUTLAK KURALLAR:
// 1. data/cinetrack-data.json ASLA yazılmaz.
// 2. TMDB API Key hardcode edilmez; process.env.TMDB_API_KEY, .env.local veya .env'den okunur.
// 3. Rate-limit koruması: 300ms delay + 429 handling.
// 4. Çakışan keyword'ler raporlanır, sessizce atlanmaz.
// 5. Tüm JSON yazımları atomiktir (.tmp -> doğrula -> fs.renameSync).
// ===========================================================================

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");

const TMDB_BASE = "https://api.themoviedb.org/3";
const DELAY_MS = 250; // Rate-limit koruması (250ms delay + 429 handling)

// ===========================================================================
// METRİK → KEYWORD ADAYLARI EŞLEMESİ
// Bu liste, taksonomideki "evidenceRequirement" alanından türetilmiş ve
// ADIM 3 CSV doğrulamasıyla CONFLICT / NOT_FOUND satırlarından arındırılmıştır.
// ===========================================================================
const METRIC_KEYWORD_CANDIDATES = {
  // === MOOD (6) ===
  "mood.melancholic": [
    "melancholy",
    "grief",
    "sorrow",
    "sadness",
    "mourning",
    "loss of loved one",
    "heartbreak",
    "bereavement",
  ],
  "mood.dark": [
    "dark",
    "bleak",
    "grim",
    "darkness",
    "gloomy",
    "despair",
    "tragedy",
    "nihilism",
    "noir",
  ],
  "mood.hopeful": [
    "hope",
    "redemption",
    "uplifting",
    "feel-good",
    "hopeful",
    "inspiring",
    "inspirational",
    "second chance",
    "underdog",
  ],
  "mood.tense": [
    "tension",
    "suspense",
    "anxiety",
    "edge of seat",
    "paranoia",
    "hostage",
    "race against time",
    "claustrophobia",
    "cat and mouse",
  ],
  "mood.cozy": [
    "heartwarming",
    "slice of life",
    "comforting",
    "cozy",
    "warm",
    "friendship",
    "coming of age",
    "small town",
    "road trip",
  ],
  "mood.unsettling": [
    "disturbing",
    "creepy",
    "psychological",
    "eerie",
    "uneasy",
    "uncomfortable",
    "nightmare",
    "madness",
    "obsession",
    "cult",
  ],

  // === NARRATIVE (3 aktif) ===
  "narrative.non_linear": [
    "nonlinear",
    "time travel",
    "flashback",
    "multiple timelines",
    "non-linear",
    "time loop",
  ],
  "narrative.open_ending": [
    "ambiguous",
    "open-ended",
    "existentialism",
    "philosophical",
    "enigmatic",
  ],
  "narrative.twist": [
    "twist ending",
    "plot twist",
    "surprise ending",
    "twist",
    "betrayal",
    "deception",
    "whodunit",
    "double cross",
  ],

  // === CONCEPT (6) ===
  "concept.identity": [
    "identity",
    "clone",
    "doppelganger",
    "memory loss",
    "amnesia",
    "identity crisis",
    "secret identity",
    "split personality",
  ],
  "concept.mortality": [
    "death",
    "aging",
    "terminal illness",
    "afterlife",
    "mortality",
    "dying",
    "suicide",
    "immortality",
  ],
  "concept.technology": [
    "artificial intelligence",
    "robot",
    "cyber",
    "hacking",
    "ai",
    "technology",
    "android",
    "virtual reality",
    "cyborg",
    "surveillance",
  ],
  "concept.freedom": [
    "oppression",
    "rebellion",
    "revolution",
    "escape",
    "freedom",
    "liberation",
    "prison",
    "slavery",
    "resistance",
  ],
  "concept.love": [
    "love",
    "relationship",
    "family bonds",
    "love story",
    "marriage",
    "falling in love",
    "unrequited love",
    "forbidden love",
    "father son relationship",
    "mother daughter relationship",
  ],
  "concept.power": [
    "politics",
    "corruption",
    "empire",
    "dictatorship",
    "power",
    "political",
    "royal family",
    "monarchy",
  ],

  // === CHARACTER (2 aktif) ===
  "character.antihero": [
    "anti-hero",
    "dark hero",
    "vigilante",
    "outlaw",
    "hitman",
    "revenge",
    "heist",
    "gangster",
    "assassin",
  ],
  "character.solitary": [
    "isolation",
    "loneliness",
    "lone wolf",
    "survival",
    "solitary",
    "alone",
    "stranded",
    "hermit",
  ],

  // === STYLE (2 aktif) ===
  "style.surreal": [
    "surreal",
    "dreamlike",
    "hallucination",
    "abstract",
    "surrealism",
    "dream",
    "magical realism",
    "alternate reality",
    "psychedelic",
  ],
  "style.stylized": [
    "neon",
    "stylized",
    "visually striking",
    "cyberpunk",
    "neo-noir",
    "anime",
    "steampunk",
    "martial arts",
    "superhero",
  ],

  // === SETTING (3 aktif) ===
  "setting.dystopia": [
    "dystopia",
    "post-apocalyptic",
    "post-apocalyptic future",
    "wasteland",
    "totalitarian",
    "dystopian",
    "apocalypse",
    "police state",
  ],
  "setting.space": [
    "space",
    "spaceship",
    "astronaut",
    "alien planet",
    "outer space",
    "space travel",
    "space station",
    "alien",
    "space opera",
  ],
  "setting.historical": [
    "historical",
    "period",
    "19th century",
    "medieval",
    "war",
    "period drama",
    "world war ii",
    "world war i",
    "ancient rome",
    "cold war",
    "based on true story",
    "biography",
  ],

  // === TV'de keyword'den türetilen genre'lar (3) ===
  "genre.thriller": [
    "thriller",
    "psychological thriller",
    "conspiracy",
    "serial killer",
    "espionage",
    "kidnapping",
    "murder",
    "detective",
    "investigation",
  ],
  "genre.horror": [
    "horror",
    "scary",
    "terror",
    "frightening",
    "supernatural",
    "ghost",
    "slasher",
    "zombie",
    "vampire",
    "monster",
    "demon",
  ],
  "genre.romance": [
    "romance",
    "romantic",
    "romantic comedy",
    "lovers",
    "crush",
    "dating",
  ],
};

// ===========================================================================
// ATOMİK JSON YAZIMI (.tmp -> JSON.parse doğrula -> fs.renameSync)
// ===========================================================================
function writeJsonAtomicSync(targetPath, data) {
  const dir = path.dirname(targetPath);
  fs.mkdirSync(dir, { recursive: true });
  const serialized = JSON.stringify(data, null, 2) + "\n";
  const tmpPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, serialized, "utf8");
  JSON.parse(fs.readFileSync(tmpPath, "utf8"));
  fs.renameSync(tmpPath, targetPath);
}

// ===========================================================================
// ORTAM / API KEY
// ===========================================================================
function loadEnvFile(envPath) {
  if (!fs.existsSync(envPath)) return {};
  const out = {};
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const withoutExport = trimmed.startsWith("export ")
      ? trimmed.slice("export ".length).trimStart()
      : trimmed;
    const eq = withoutExport.indexOf("=");
    if (eq === -1) continue;
    const key = withoutExport.slice(0, eq).trim();
    let value = withoutExport.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function resolveApiKey() {
  if (process.env.TMDB_API_KEY?.trim()) return process.env.TMDB_API_KEY.trim();
  const envLocalPath = path.join(PROJECT_ROOT, ".env.local");
  const fromLocal = loadEnvFile(envLocalPath).TMDB_API_KEY?.trim();
  if (fromLocal) return fromLocal;
  const envPath = path.join(PROJECT_ROOT, ".env");
  const fromFile = loadEnvFile(envPath).TMDB_API_KEY?.trim();
  if (fromFile) return fromFile;
  console.error(
    "HATA: TMDB_API_KEY bulunamadı.\n" +
      "  a) node --env-file=.env scripts/fetch-keyword-ids.mjs ile çalıştırın, veya\n" +
      "  b) .env / .env.local dosyasında TMDB_API_KEY satırı olduğundan emin olun."
  );
  process.exit(1);
}

// ===========================================================================
// TMDB İSTEMCİSİ
// ===========================================================================
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchTmdb(endpoint, apiKey) {
  const url = new URL(`${TMDB_BASE}${endpoint}`);
  const headers = { Accept: "application/json" };
  if (apiKey.startsWith("eyJ")) {
    headers.Authorization = `Bearer ${apiKey}`;
  } else {
    url.searchParams.set("api_key", apiKey);
  }

  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(15000),
      });

      if (res.status === 429) {
        const retryAfter = Number(res.headers.get("retry-after")) || 2;
        console.log(`  ⏳ Rate limit, ${retryAfter}s bekleniyor...`);
        await sleep(retryAfter * 1000);
        continue;
      }

      if (res.status === 401 || res.status === 403) {
        console.error(`HATA: TMDB yetkilendirme hatası (HTTP ${res.status}).`);
        process.exit(1);
      }

      if (res.status === 404) return { status: 404, data: null };
      if (!res.ok) {
        await sleep(attempt * 500);
        continue;
      }

      const data = await res.json();
      return { status: 200, data };
    } catch {
      await sleep(attempt * 500);
    }
  }
  return { status: 0, data: null };
}

async function searchKeyword(query, apiKey) {
  const res = await fetchTmdb(
    `/search/keyword?query=${encodeURIComponent(query)}&page=1`,
    apiKey
  );
  await sleep(DELAY_MS);

  if (res.status !== 200 || !res.data?.results?.length) {
    return null;
  }

  // En yakın eşleşmeyi bul (tam eşleşme öncelikli)
  const results = res.data.results;
  const exact = results.find((r) => r.name.toLowerCase() === query.toLowerCase());
  if (exact) return exact;

  // Yoksa ilk sonucu döndür
  return results[0];
}

// ===========================================================================
// ANA AKIŞ
// ===========================================================================
async function main() {
  const apiKey = resolveApiKey();
  console.log("🔑 TMDB API Key yüklendi.");

  // 1) Taksonomiyi oku
  const taxonomyPath = path.join(
    PROJECT_ROOT,
    "data",
    "taste",
    "cinetrack-taste-taxonomy.json"
  );
  if (!fs.existsSync(taxonomyPath)) {
    console.error(`HATA: Taksonomi dosyası bulunamadı: ${taxonomyPath}`);
    process.exit(1);
  }
  const taxonomyDoc = JSON.parse(fs.readFileSync(taxonomyPath, "utf8"));
  const metrics = taxonomyDoc.metrics || [];
  console.log(`📚 Taksonomi yüklendi: ${metrics.length} metrik`);

  // 2) Her metrik için keyword ara
  const keywordToMetric = {}; // keywordId -> metricId
  const metricToKeywords = {}; // metricId -> [{keywordId, keywordName, query}]
  const conflicts = []; // Aynı keyword birden fazla metriğe eşleşirse
  const notFound = []; // Keyword bulunamayan metrikler
  const csvRows = [["metricId", "keywordId", "keywordName", "query", "status", "notes"]];

  let totalCalls = 0;
  let totalFound = 0;

  console.log(
    `\n🔍 ${Object.keys(METRIC_KEYWORD_CANDIDATES).length} metrik için keyword aranıyor...\n`
  );

  for (const [metricId, candidates] of Object.entries(METRIC_KEYWORD_CANDIDATES)) {
    console.log(`[${metricId}] ${candidates.length} aday aranıyor...`);

    if (!metricToKeywords[metricId]) metricToKeywords[metricId] = [];
    let foundForMetric = 0;

    for (const query of candidates) {
      totalCalls++;
      const result = await searchKeyword(query, apiKey);

      if (!result) {
        csvRows.push([metricId, "", "", query, "NOT_FOUND", ""]);
        continue;
      }

      const keywordId = result.id;
      const keywordName = result.name;

      // Çakışma kontrolü
      if (keywordToMetric[keywordId]) {
        const existingMetric = keywordToMetric[keywordId];
        if (existingMetric !== metricId) {
          conflicts.push({
            keywordId,
            keywordName,
            metrics: [existingMetric, metricId],
          });
          csvRows.push([
            metricId,
            keywordId,
            keywordName,
            query,
            "CONFLICT",
            `Aynı keyword ${existingMetric} ile de eşleşiyor`,
          ]);
          continue;
        } else {
          // Aynı metrik içinde mükerrer keyword ID üretildiyse iki kez ekleme
          csvRows.push([
            metricId,
            keywordId,
            keywordName,
            query,
            "DUPLICATE_SAME_METRIC",
            "Aynı metrik altında zaten eklendi",
          ]);
          continue;
        }
      }

      // Kaydet
      keywordToMetric[keywordId] = metricId;
      metricToKeywords[metricId].push({
        keywordId,
        keywordName,
        query,
      });
      foundForMetric++;
      totalFound++;

      csvRows.push([metricId, keywordId, keywordName, query, "OK", ""]);
      console.log(`  ✓ "${query}" → ID ${keywordId} (${keywordName})`);
    }

    if (foundForMetric === 0) {
      notFound.push(metricId);
      console.log(`  ✗ Hiçbir aday bulunamadı\n`);
    } else {
      console.log(`  → ${foundForMetric}/${candidates.length} bulundu\n`);
    }
  }

  // 3) JSON çıktısı üret (validate-real-data.mjs'in kullanacağı format — atomik yazım)
  const outputPath = path.join(PROJECT_ROOT, "data", "taste", "keyword-mappings.json");
  const outputDoc = {
    schemaVersion: "1.0.0",
    generatedAt: new Date().toISOString(),
    tmdbMappingVersion: "tmdb-2026-11-v2",
    taxonomyVersion: taxonomyDoc.taxonomyVersion,
    totalMetrics: Object.keys(METRIC_KEYWORD_CANDIDATES).length,
    totalKeywordsFound: totalFound,
    totalCalls,
    conflicts: conflicts.length,
    notFoundMetrics: notFound,
    KEYWORD_TO_METRIC: keywordToMetric, // { "1234": "mood.melancholic" }
    METRIC_TO_KEYWORDS: metricToKeywords, // { "mood.melancholic": [{keywordId, keywordName, query}] }
  };

  writeJsonAtomicSync(outputPath, outputDoc);
  console.log(`\n✅ JSON kaydedildi: ${outputPath}`);

  // 4) CSV raporu üret (manuel doğrulama için)
  const csvPath = path.join(PROJECT_ROOT, "scripts", "keyword-verification.csv");
  const csvContent = csvRows
    .map((row) => row.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(","))
    .join("\n");
  fs.writeFileSync(csvPath, csvContent, "utf8");
  console.log(`✅ CSV raporu kaydedildi: ${csvPath}`);

  // 5) Özet rapor
  console.log(`\n${"=".repeat(70)}`);
  console.log("ÖZET RAPOR");
  console.log("=".repeat(70));
  console.log(`  Toplam TMDB çağrısı: ${totalCalls}`);
  console.log(`  Bulunan keyword: ${totalFound}`);
  console.log(`  Çakışma: ${conflicts.length}`);
  console.log(`  Hiç bulunamayan metrik: ${notFound.length}`);

  if (conflicts.length > 0) {
    console.log(`\n⚠️ ÇAKIŞMALAR (manuel inceleme gerekli):`);
    for (const c of conflicts) {
      console.log(`  • Keyword "${c.keywordName}" (ID ${c.keywordId}): ${c.metrics.join(" ↔ ")}`);
    }
  }

  if (notFound.length > 0) {
    console.log(`\n⚠️ BULUNAMAYAN METRİKLER (keyword adayları TMDB'de yok):`);
    for (const m of notFound) {
      console.log(`  • ${m}`);
    }
  }

  console.log(`\n${"=".repeat(70)}`);
  console.log("SONRAKİ ADIMLAR:");
  console.log("=".repeat(70));
  console.log("1. scripts/keyword-verification.csv dosyasını aç ve CONFLICT/NOT_FOUND satırlarını incele.");
  console.log("2. Gerekirse METRIC_KEYWORD_CANDIDATES listesini düzenle ve scripti tekrar çalıştır.");
  console.log("3. Her şey doğruysa, validate-real-data.mjs'i güncelle:");
  console.log(
    `   const KEYWORD_TO_METRIC = JSON.parse(fs.readFileSync("data/taste/keyword-mappings.json")).KEYWORD_TO_METRIC;`
  );
  console.log("4. validate-real-data.mjs'i tekrar çalıştır:");
  console.log(`   node --env-file=.env scripts/validate-real-data.mjs --sample-size 50 --max-calls 50`);
  console.log("=".repeat(70));
}

main().catch((err) => {
  console.error("BEKLENMEYEN HATA:", err);
  process.exit(1);
});
