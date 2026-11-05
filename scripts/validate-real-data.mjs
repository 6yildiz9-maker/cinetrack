#!/usr/bin/env node
// ===========================================================================
// Cinethos Taste Engine — Gerçek Veri Doğrulama Scripti
//
// Faz 2 (Deterministik İndeks) + Faz 3 (Profil Motoru) mantığını GERÇEK
// TMDB verileriyle uçtan uca doğrular.
//
// MUTLAK KURALLAR:
//  1. data/cinetrack-data.json ASLA yazılmaz — yalnızca okunur.
//  2. TMDB API Key hiçbir yerde hardcode edilmez; process.env.TMDB_API_KEY
//     (veya proje .env dosyası) üzerinden okunur.
//  3. Bu script ana uygulamanın UI/sunucu rotalarını değiştirmez;
//     bağımsız bir dosyadır, dosya sistemine hiçbir şey yazmaz.
//
// Kural kaynakları (ayna/parse edilmiş):
//  - Faz 2: src/core/taste/feature-extractor.ts, taxonomy.ts,
//           tmdb-mappings.ts, feature-normalizer.ts, constants.ts
//  - Faz 3: src/core/taste/behavior-signals.ts, evidence-ledger.ts,
//           preference-calculator.ts (TP-015/021/024), confidence-calculator.ts (TP-025)
//  - ADR   : phase-0-findings.md (ADR-02 kanonik anahtar, ADR-03 puan ölçeği)
// ===========================================================================

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");

// === Sürüm bilgileri (src/core/taste/constants.ts) ===
const EXTRACTOR_VERSION = "v1.0";
const TMDB_MAPPING_VERSION = "tmdb-2026-11";
const TAXONOMY_VERSION = "v0.1";
const SHRINKAGE_K = 2.5; // TP-021
const MIN_EVIDENCE_FOR_DIRECTIONAL = 3; // §6.3

// Feature strength/confidence tabloları (constants.ts)
const FEATURE_STRENGTH = {
  directGenre: 100,
  origin: 90,
  format: 85,
  keywordStrong: 80,
  keywordWeak: 60,
  heuristicShadow: 50,
};
const FEATURE_CONFIDENCE = {
  directGenre: 0.95,
  tvCombinedScifiFantasy: 0.75,
  origin: 0.9,
  format: 0.85,
  keyword: 0.8,
  heuristicShadow: 0.5,
};

// Davranış sinyal tablosu (constants.ts → BEHAVIOR_SIGNALS)
const BEHAVIOR_SIGNALS = {
  rating_9_10: 1.0,
  rating_8_89: 0.75,
  rating_7_79: 0.45,
  rating_5_69: 0,
  rating_3_49: -0.55,
  rating_1_29: -1.0,
};

// === Anahtar Kelime Eşlemesi (Faz 6.5 çıktısı: data/taste/keyword-mappings.json) ===
const keywordMappingsPath = path.join(PROJECT_ROOT, "data", "taste", "keyword-mappings.json");
const KEYWORD_TO_METRIC = fs.existsSync(keywordMappingsPath)
  ? JSON.parse(fs.readFileSync(keywordMappingsPath, "utf8")).KEYWORD_TO_METRIC
  : {};

// ===========================================================================
// KOMUT SATIRI
// ===========================================================================
function parseArgs(argv) {
  const args = {
    data: path.join(PROJECT_ROOT, "data", "cinetrack-data.json"),
    csv: null,
    seed: 20261102,
    sampleSize: 12,
    maxCalls: 15,
    delayMs: 250,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--data") args.data = next();
    else if (a === "--csv") args.csv = next();
    else if (a === "--seed") args.seed = Number(next());
    else if (a === "--sample-size") args.sampleSize = Number(next());
    else if (a === "--max-calls") args.maxCalls = Number(next());
    else if (a === "--delay-ms") args.delayMs = Number(next());
    else if (a === "--help" || a === "-h") {
      console.log(`
Kullanım:
  node --env-file=.env scripts/validate-real-data.mjs [seçenekler]

Seçenekler:
  --data <yol>        cinetrack-data.json yolu (varsayılan: data/cinetrack-data.json)
  --csv <yol>         CSV dışa aktarımından veri yükle (Title,Year,Rating10,Status,MediaType,tmdbID)
  --seed <n>          Rastgele seçim için tohum (tekrarlanabilirlik)
  --sample-size <n>   Örneklem büyüklüğü (varsayılan: 12)
  --max-calls <n>     Azami TMDB çağrısı (varsayılan: 15)
  --delay-ms <n>      TMDB çağrıları arası bekleme (varsayılan: 250)
`);
      process.exit(0);
    } else {
      console.error(`Bilinmeyen argüman: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

// ===========================================================================
// ORTAM / API KEY (Kural 2: hardcode YASAK)
// ===========================================================================
function loadEnvFile(envPath) {
  if (!fs.existsSync(envPath)) return {};
  const out = {};
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
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
      "  a) node --env-file=.env scripts/validate-real-data.mjs ...  ile çalıştırın, veya\n" +
      "  b) TMDB_API_KEY ortam değişkenini tanımlayın, veya\n" +
      `  c) ${envPath} / ${envLocalPath} dosyasında TMDB_API_KEY satırı olduğundan emin olun.`
  );
  process.exit(1);
}

// ===========================================================================
// VERİ YÜKLEME (Kural 1: salt-okunur)
// ===========================================================================
function parseCsv(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((f) => f !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f !== "")) rows.push(row);
  return rows;
}

function normalizeRating(value) {
  if (value === "" || value === null || value === undefined) return "";
  const n = Number(value);
  return Number.isFinite(n) && n >= 1 && n <= 10 ? String(n) : "";
}

function loadEntriesFromJson(dataPath, warnings) {
  if (!fs.existsSync(dataPath)) return null;
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(dataPath, "utf8"));
  } catch (err) {
    console.error(`HATA: ${dataPath} okunamadı/parse edilemedi: ${err.message}`);
    process.exit(1);
  }
  const profiles = Array.isArray(doc.profiles) ? doc.profiles : [];
  if (profiles.length === 0) return [];
  const active =
    profiles.find((p) => p.id === doc.activeProfileId) ?? profiles[0];
  const items = Array.isArray(active.items) ? active.items : [];
  const entries = [];
  for (const it of items) {
    const tmdbId = Number(it.id);
    if (!Number.isFinite(tmdbId) || tmdbId <= 0) {
      warnings.push(`JSON kaydı atlandı (geçersiz id): ${JSON.stringify(it.id)}`);
      continue;
    }
    const mediaType = it.media_type === "movie" || it.media_type === "tv" ? it.media_type : null;
    if (!mediaType) {
      warnings.push(`JSON kaydı atlandı (geçersiz media_type): ${JSON.stringify(it.media_type)}`);
      continue;
    }
    let rating = normalizeRating(it.personal_rating);
    if (it.personal_rating_cleared === true && rating !== "") {
      warnings.push(
        `ADR-03: ${mediaType}:${tmdbId} puanı temizlenmiş (personal_rating_cleared) — puansız kabul edildi.`
      );
      rating = "";
    }
    entries.push({
      tmdbId,
      mediaType,
      title: String(it.title ?? it.name ?? `${mediaType}:${tmdbId}`),
      rating,
      status: String(it.status ?? ""),
      source: "json",
    });
  }
  return entries;
}

function loadEntriesFromCsv(csvPath, warnings) {
  if (!fs.existsSync(csvPath)) {
    console.error(`HATA: CSV dosyası bulunamadı: ${csvPath}`);
    process.exit(1);
  }
  const rows = parseCsv(fs.readFileSync(csvPath, "utf8"));
  const header = rows[0].map((h) => h.trim());
  const idx = (name) => header.indexOf(name);
  const iTitle = idx("Title");
  const iRating = idx("Rating10");
  const iStatus = idx("Status");
  const iMedia = idx("MediaType");
  const iTmdb = idx("tmdbID");
  if (iTmdb === -1 || iMedia === -1) {
    console.error("HATA: CSV başlığında tmdbID/MediaType kolonu bulunamadı.");
    process.exit(1);
  }
  const entries = [];
  let skipped = 0;
  for (const r of rows.slice(1)) {
    const tmdbId = Number((r[iTmdb] ?? "").trim());
    const mediaType = (r[iMedia] ?? "").trim();
    if (!Number.isFinite(tmdbId) || tmdbId <= 0) {
      skipped++;
      continue;
    }
    if (mediaType !== "movie" && mediaType !== "tv") {
      skipped++;
      continue;
    }
    entries.push({
      tmdbId,
      mediaType,
      title: (r[iTitle] ?? "").trim() || `${mediaType}:${tmdbId}`,
      rating: normalizeRating(r[iRating] ?? ""),
      status: (r[iStatus] ?? "").trim(),
      source: "csv",
    });
  }
  if (skipped > 0) {
    warnings.push(`CSV'de ${skipped} satır geçersiz tmdbID/MediaType nedeniyle atlandı.`);
  }
  return entries;
}

// ===========================================================================
// ÖRNEKLEM SEÇİMİ (kural: yüksek/düşük/puansız katmanlar + zarif yedek)
// ===========================================================================
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(arr, rng) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function selectSample(entries, args, warnings) {
  const rng = mulberry32(args.seed);
  const rated = entries.filter((e) => e.rating !== "");
  const unrated = entries.filter((e) => e.rating === "");
  if (rated.length === 0) {
    console.error("HATA: Veride puanlı (personal_rating !== '') hiç içerik yok.");
    process.exit(1);
  }

  const band = (r) => {
    const n = Number(r);
    if (n >= 9) return "high";
    if (n <= 3) return "low";
    if (n < 5) return "midLow";
    if (n < 7) return "mid";
    return "midHigh";
  };

  const buckets = {
    high: rated.filter((e) => band(e.rating) === "high"),
    low: rated.filter((e) => band(e.rating) === "low"),
    midLow: rated.filter((e) => band(e.rating) === "midLow"),
    mid: rated.filter((e) => band(e.rating) === "mid"),
    midHigh: rated.filter((e) => band(e.rating) === "midHigh"),
  };

  const sample = [];
  const used = new Set();
  const pick = (pool, n) => {
    for (const e of shuffle(pool, rng)) {
      if (n <= 0) break;
      const key = `${e.mediaType}:${e.tmdbId}`;
      if (used.has(key)) continue;
      used.add(key);
      sample.push(e);
      n--;
    }
    return n;
  };

  const highTarget = 5;
  const lowTarget = 5;
  const unratedTarget = 2;

  pick(buckets.high, highTarget);
  if (buckets.high.length < highTarget) {
    warnings.push(`UYARI: 9-10 puanlı yalnızca ${buckets.high.length} içerik var (hedef ${highTarget}).`);
  }

  let remaining = pick(buckets.low, lowTarget);
  if (buckets.low.length < lowTarget) {
    warnings.push(
      `UYARI: 1-3 puanlı hiç içerik yok (bulunan: ${buckets.low.length}). ` +
        "Düşük puan katmanı 3-5 bandından dolduruluyor."
    );
    remaining = pick(buckets.midLow, remaining);
    if (buckets.midLow.length < remaining) {
      warnings.push(
        "UYARI: 3-5 puanlı içerik de yetersiz; düşük katman 5-7 bandından dolduruluyor."
      );
      remaining = pick(buckets.mid, remaining);
      remaining = pick(buckets.midHigh, remaining);
    }
  }

  const unratedWatched = unrated.filter((e) => e.status === "completed");
  const unratedRest = unrated.filter((e) => e.status !== "completed");
  let unratedLeft = pick(unratedWatched, unratedTarget);
  if (unratedWatched.length < unratedTarget) {
    warnings.push(
      `UYARI: Puansız izlenmiş (completed) yalnızca ${unratedWatched.length} içerik var; ` +
        "diğer puansız kayıtlardan dolduruluyor."
    );
    unratedLeft = pick(unratedRest, unratedLeft);
  }
  if (unratedLeft > 0) {
    warnings.push("UYARI: Puansız içerik bulunamadı; örneklem yalnızca puanlılardan oluşuyor.");
  }

  // En az 10 puanlı garanti et
  const ratedInSample = sample.filter((e) => e.rating !== "").length;
  if (ratedInSample < 10) {
    warnings.push(
      `UYARI: Örneklemde yalnızca ${ratedInSample} puanlı içerik var; kalan puanlılardan dolduruluyor.`
    );
    const allRatedPool = rated.filter(
      (e) => !used.has(`${e.mediaType}:${e.tmdbId}`)
    );
    pick(allRatedPool, 10 - ratedInSample);
  }

  // Örneklem büyüklüğüne tamamla (args.sampleSize > 12 ise önce kalan puanlıları dahil et)
  if (sample.length < args.sampleSize) {
    const remainingRated = rated.filter((e) => !used.has(`${e.mediaType}:${e.tmdbId}`));
    const leftAfterRated = pick(remainingRated, args.sampleSize - sample.length);
    if (leftAfterRated > 0) {
      const remainingUnrated = unrated.filter((e) => !used.has(`${e.mediaType}:${e.tmdbId}`));
      pick(remainingUnrated, leftAfterRated);
    }
  }

  return sample.slice(0, Math.min(args.maxCalls, args.sampleSize));
}

// ===========================================================================
// TMDB İSTEMCİSİ
// ===========================================================================
const TMDB_BASE = "https://api.themoviedb.org/3";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchTmdb(endpoint, apiKey, stats) {
  const url = new URL(`${TMDB_BASE}${endpoint}`);
  url.searchParams.set("api_key", apiKey);
  let lastError = null;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(15000),
      });
      if (res.status === 429) {
        stats.rateLimitHits++;
        const retryAfter = Number(res.headers.get("retry-after")) || 1;
        await sleep(Math.min(retryAfter * 1000, 8000));
        continue;
      }
      if (res.status === 401 || res.status === 403) {
        console.error(
          `HATA: TMDB yetkilendirme hatası (HTTP ${res.status}). TMDB_API_KEY geçerli mi?`
        );
        process.exit(1);
      }
      if (res.status === 404) return { status: 404, data: null };
      if (!res.ok) {
        lastError = new Error(`HTTP ${res.status}`);
        await sleep(attempt * 500);
        continue;
      }
      const data = await res.json();
      return { status: 200, data };
    } catch (err) {
      lastError = err;
      await sleep(attempt * 500);
    }
  }
  return { status: 0, data: null, error: lastError };
}

async function fetchContentMetadata(entry, apiKey, stats) {
  const base = entry.mediaType === "movie" ? `/movie/${entry.tmdbId}` : `/tv/${entry.tmdbId}`;
  const res = await fetchTmdb(`${base}?append_to_response=keywords`, apiKey, stats);
  stats.calls++;
  if (res.status !== 200) return res;
  const d = res.data;
  const keywords =
    d.keywords?.keywords ??
    d.keywords?.results ??
    null;
  return {
    status: 200,
    meta: {
      contentId: `${entry.mediaType}:${entry.tmdbId}`,
      mediaType: entry.mediaType,
      tmdbId: entry.tmdbId,
      title: entry.title,
      rating: entry.rating,
      status: entry.status,
      genreIds: Array.isArray(d.genres) ? d.genres.map((g) => Number(g.id)).filter(Number.isFinite) : [],
      keywords: Array.isArray(keywords)
        ? keywords.map((k) => ({ id: Number(k.id), name: k.name })).filter((k) => Number.isFinite(k.id))
        : [],
      originalLanguage: d.original_language ?? undefined,
      productionCountries: Array.isArray(d.production_countries)
        ? d.production_countries.map((c) => c.iso_3166_1).filter(Boolean)
        : undefined,
      originCountry: Array.isArray(d.origin_country) ? d.origin_country.filter(Boolean) : undefined,
      runtime: entry.mediaType === "movie" ? d.runtime ?? undefined : undefined,
      episodeRunTime: Array.isArray(d.episode_run_time) && d.episode_run_time.length > 0 ? d.episode_run_time : undefined,
      numberOfSeasons: entry.mediaType === "tv" ? d.number_of_seasons ?? undefined : undefined,
      releaseDate: d.release_date || undefined,
      firstAirDate: d.first_air_date || undefined,
    },
  };
}

// ===========================================================================
// FAZ 2 — ÖZELLİK ÇIKARIMI (feature-extractor.ts + feature-normalizer.ts aynası)
// ===========================================================================
function clampStrength(n) {
  return Math.max(0, Math.min(100, Math.round(n)));
}
function clampConfidence(n) {
  return Math.max(0, Math.min(1, n));
}

function hashString(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h) ^ s.charCodeAt(i);
    h = h >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

function buildMetadataHash(input) {
  const canonical = JSON.stringify({
    contentId: input.contentId,
    mediaType: input.mediaType,
    tmdbId: input.tmdbId,
    genreIds: (input.genreIds ?? []).slice().sort((a, b) => a - b),
    keywords: (input.keywords ?? []).map((k) => k.id).sort((a, b) => a - b),
    originalLanguage: input.originalLanguage ?? null,
    productionCountries: (input.productionCountries ?? []).slice().sort(),
    originCountry: (input.originCountry ?? []).slice().sort(),
    runtime: input.runtime ?? null,
    episodeRunTime: (input.episodeRunTime ?? []).slice().sort((a, b) => a - b),
    numberOfSeasons: input.numberOfSeasons ?? null,
    releaseDate: input.releaseDate ?? null,
    firstAirDate: input.firstAirDate ?? null,
    _extractor: EXTRACTOR_VERSION,
    _mapping: TMDB_MAPPING_VERSION,
    _taxonomy: TAXONOMY_VERSION,
  });
  return hashString(canonical);
}

function extractRawFeatures(meta, mappings, warnings) {
  const features = {};
  const genreIdSet = new Set(meta.genreIds ?? []);

  // --- Genre (doğrudan ID eşleşmesi) ---
  if (meta.mediaType === "movie") {
    for (const [key, id] of Object.entries(mappings.movieGenreIds)) {
      if (genreIdSet.has(id)) {
        features[`genre.${key}`] = {
          strength: FEATURE_STRENGTH.directGenre,
          confidence: FEATURE_CONFIDENCE.directGenre,
          source: "tmdb",
          evidence: [String(id)],
          state: "present",
        };
      }
    }
  } else {
    for (const [key, id] of Object.entries(mappings.tvGenreIds)) {
      if (key === "scifi_fantasy") {
        if (genreIdSet.has(id)) {
          for (const metricId of ["genre.scifi", "genre.fantasy"]) {
            features[metricId] = {
              strength: FEATURE_STRENGTH.directGenre,
              confidence: FEATURE_CONFIDENCE.tvCombinedScifiFantasy,
              source: "tmdb",
              evidence: [String(id)],
              state: "present",
            };
          }
        }
      } else if (genreIdSet.has(id)) {
        features[`genre.${key}`] = {
          strength: FEATURE_STRENGTH.directGenre,
          confidence: FEATURE_CONFIDENCE.directGenre,
          source: "tmdb",
          evidence: [String(id)],
          state: "present",
        };
      }
    }
    if (Object.keys(KEYWORD_TO_METRIC).length === 0) {
      const missingTvGenres = ["genre.thriller", "genre.horror", "genre.romance"];
      const produced = Object.keys(features);
      const absent = missingTvGenres.filter((m) => !produced.includes(m));
      if (absent.length > 0) {
        warnings.push(
          `UYARI: TV içeriği ${meta.contentId} — TV'de ${absent.join(", ")} için tür ID'si yok; ` +
            "bu metrikler yalnızca keyword'den türetilebilir (KEYWORD_TO_METRIC boş olduğundan unknown kalır)."
        );
      }
    }
  }

  // --- Keyword (sayısal ID eşleşmesi; v1.0'da eşleme BOŞ) ---
  if (Object.keys(KEYWORD_TO_METRIC).length > 0) {
    for (const kw of meta.keywords ?? []) {
      const metricId = KEYWORD_TO_METRIC[kw.id];
      if (!metricId) continue;
      if (!features[metricId]) {
        features[metricId] = {
          strength: FEATURE_STRENGTH.keywordStrong,
          confidence: FEATURE_CONFIDENCE.keyword,
          source: "tmdb",
          evidence: [String(kw.id)],
          state: "present",
        };
      } else {
        features[metricId].evidence = [...(features[metricId].evidence ?? []), String(kw.id)];
      }
    }
  }

  // --- Origin (dil + ülke) ---
  const lang = meta.originalLanguage ?? "";
  const countrySet = new Set([
    ...(meta.productionCountries ?? []),
    ...(meta.originCountry ?? []),
  ]);
  const origin = mappings.originRules;
  if (
    origin.asian_cinema.languages.includes(lang) ||
    origin.asian_cinema.countries.some((c) => countrySet.has(c))
  ) {
    features["origin.asian_cinema"] = {
      strength: FEATURE_STRENGTH.origin,
      confidence: FEATURE_CONFIDENCE.origin,
      source: "tmdb",
      evidence: [lang, ...countrySet].filter(Boolean),
      state: "present",
    };
  }
  if (origin.european.countries.some((c) => countrySet.has(c))) {
    features["origin.european"] = {
      strength: FEATURE_STRENGTH.origin,
      confidence: FEATURE_CONFIDENCE.origin,
      source: "tmdb",
      evidence: [...countrySet].filter((c) => origin.european.countries.includes(c)),
      state: "present",
    };
  }
  if (
    origin.turkish.languages.includes(lang) ||
    origin.turkish.countries.some((c) => countrySet.has(c))
  ) {
    features["origin.turkish"] = {
      strength: FEATURE_STRENGTH.origin,
      confidence: FEATURE_CONFIDENCE.origin,
      source: "tmdb",
      evidence: [lang, ...countrySet].filter(Boolean),
      state: "present",
    };
  }

  // --- Format (yalnızca TV) ---
  if (meta.mediaType === "tv") {
    const seasons = meta.numberOfSeasons ?? 0;
    const maxRunTime =
      meta.episodeRunTime && meta.episodeRunTime.length > 0
        ? Math.max(...meta.episodeRunTime)
        : 0;
    if (
      seasons === mappings.formatRules.miniseries.seasons &&
      maxRunTime > mappings.formatRules.miniseries.minEpisodeRuntime
    ) {
      features["format.miniseries"] = {
        strength: FEATURE_STRENGTH.format,
        confidence: FEATURE_CONFIDENCE.format,
        source: "tmdb",
        evidence: [`seasons:${seasons}`, `maxRunTime:${maxRunTime}`],
        state: "present",
      };
    }
    if (seasons >= mappings.formatRules.long_running.minSeasons) {
      features["format.long_running"] = {
        strength: FEATURE_STRENGTH.format,
        confidence: FEATURE_CONFIDENCE.format,
        source: "tmdb",
        evidence: [`seasons:${seasons}`],
        state: "present",
      };
    }
    if (maxRunTime === 0) {
      warnings.push(
        `UYARI: TV içeriği ${meta.contentId} — episode_run_time boş; format.miniseries belirlenemedi.`
      );
    }
  }

  return features;
}

function normalizeFeatures(rawFeatures, metrics) {
  // 1) değerleri sıkıştır, 2) gölge metrikleri çıkar,
  // 3) semanticGroup damping (v0.1'de tanımsız → etkisiz), 4) kategori tavanı
  const byId = new Map(metrics.map((m) => [m.id, m]));
  let features = {};
  for (const [id, f] of Object.entries(rawFeatures)) {
    features[id] = {
      ...f,
      strength: clampStrength(f.strength),
      confidence: clampConfidence(f.confidence),
    };
  }
  for (const id of Object.keys(features)) {
    const def = byId.get(id);
    if (def && def.scoringEnabled === false) delete features[id];
  }
  const categoryCount = new Map();
  for (const id of Object.keys(features)) {
    const cat = byId.get(id)?.categoryId;
    if (cat) categoryCount.set(cat, (categoryCount.get(cat) ?? 0) + 1);
  }
  for (const [id, f] of Object.entries(features)) {
    const cat = byId.get(id)?.categoryId;
    const count = categoryCount.get(cat) ?? 1;
    if (count > 3) {
      features[id] = {
        ...f,
        strength: clampStrength(f.strength * (3 / count)),
      };
    }
  }
  return features;
}

function computeCompleteness(features, mediaType, metrics) {
  const active = metrics.filter(
    (m) => m.scoringEnabled && m.applicableMedia.includes(mediaType)
  );
  if (active.length === 0) return 0;
  const covered = active.filter((m) => features[m.id] !== undefined).length;
  return Math.round((covered / active.length) * 100) / 100;
}

// ===========================================================================
// FAZ 3 — PROFİL HESABI (behavior-signals + evidence-ledger +
//         preference-calculator + confidence-calculator aynası)
// ===========================================================================
function behaviorSignalForRating(rating) {
  const r = Number(rating);
  if (r >= 9 && r <= 10) return BEHAVIOR_SIGNALS.rating_9_10;
  if (r >= 8 && r < 9) return BEHAVIOR_SIGNALS.rating_8_89;
  if (r >= 7 && r < 8) return BEHAVIOR_SIGNALS.rating_7_79;
  if (r >= 5 && r < 7) return BEHAVIOR_SIGNALS.rating_5_69;
  if (r >= 3 && r < 5) return BEHAVIOR_SIGNALS.rating_3_49;
  if (r >= 1 && r < 3) return BEHAVIOR_SIGNALS.rating_1_29;
  return 0;
}

function computeMasses(metricEvidence) {
  const masses = {
    posMass: 0,
    negMass: 0,
    uncertainMass: 0,
    evidenceMass: 0,
    evidenceCount: metricEvidence.length,
    topPositiveContentIds: [],
    topNegativeContentIds: [],
  };
  const pos = [];
  const neg = [];
  for (const e of metricEvidence) {
    masses.evidenceMass += e.baseWeight; // D_m = Σ W_im (nötr dahil — TP-015)
    if (e.contribution > 0) {
      masses.posMass += e.contribution;
      pos.push({ contentId: e.contentId, contribution: e.contribution });
    } else if (e.contribution < 0) {
      masses.negMass += Math.abs(e.contribution);
      neg.push({ contentId: e.contentId, contribution: e.contribution });
    } else {
      masses.uncertainMass += e.baseWeight;
    }
  }
  pos.sort((a, b) => b.contribution - a.contribution);
  neg.sort((a, b) => a.contribution - b.contribution);
  masses.topPositiveContentIds = pos.slice(0, 3).map((c) => c.contentId);
  masses.topNegativeContentIds = neg.slice(0, 3).map((c) => c.contentId);
  return masses;
}

function computePreference(masses) {
  const weightedSum = masses.posMass - masses.negMass;
  const affinityRaw = weightedSum / (masses.evidenceMass + SHRINKAGE_K);
  const affinity = Math.round(affinityRaw * 100);
  return { affinity, status: determineStatus(masses) };
}

function determineStatus(masses) {
  const { posMass, negMass, uncertainMass, evidenceMass, evidenceCount } = masses;
  if (evidenceCount === 0 || evidenceMass < 0.1) return "unknown";
  if (evidenceCount < MIN_EVIDENCE_FOR_DIRECTIONAL) return "unknown";
  const totalDirected = posMass + negMass;
  if (totalDirected > 0) {
    const posRatio = posMass / totalDirected;
    const negRatio = negMass / totalDirected;
    if (posRatio > 0.3 && negRatio > 0.3) return "mixed";
  }
  if (uncertainMass > posMass && uncertainMass > negMass) return "neutral";
  return "directional";
}

function computeConfidence(masses, avgFeatureConfidence, hasExactDate) {
  let support;
  if (masses.evidenceCount >= 10) support = "high";
  else if (masses.evidenceCount >= 5) support = "medium";
  else support = "low";

  let quality;
  if (avgFeatureConfidence >= 0.8 && hasExactDate) quality = "high";
  else if (avgFeatureConfidence >= 0.6) quality = "medium";
  else quality = "low";

  const coverage = masses.evidenceCount > 0 ? "medium" : "low";

  const overall = [support, quality, coverage].includes("low")
    ? "low"
    : [support, quality, coverage].includes("medium")
      ? "medium"
      : "high";
  return { support, quality, coverage, overall };
}

// ===========================================================================
// RAPORLAMA
// ===========================================================================
const TR_STATE = {
  unknown: "Bilinmiyor",
  directional: "Yönlü",
  neutral: "Nötr",
  mixed: "Karışık",
  excluded: "Hariç",
};
const TR_CONF = { low: "Düşük", medium: "Orta", high: "Yüksek" };

function fmtAffinity(a) {
  return `${a >= 0 ? "+" : ""}${a}`;
}

function reportContent(meta, features, completeness, metadataHash, signal, perMetricContrib, warnings) {
  const label = meta.mediaType === "movie" ? "Film" : "Dizi";
  console.log(`\n${"-".repeat(70)}`);
  console.log(`# ${label}: ${meta.title} (TMDB ID: ${meta.tmdbId})  [${meta.contentId}]`);
  console.log(`  Kullanıcı Puanı: ${meta.rating === "" ? "(puansız)" : meta.rating} → sinyal ${signal >= 0 ? "+" : ""}${signal.toFixed(2)}`);
  if (meta.rating === "" && meta.status !== "completed") {
    console.log(`  Not: puansız ve izlenmemiş — kanıt sayacına girmez (yalnızca Faz 2 doğrulaması).`);
  }

  const featureIds = Object.keys(features);
  console.log(`  Çıkarılan Özellikler (Faz 2): ${featureIds.length} adet`);
  if (featureIds.length === 0) {
    console.log("    (hiç aktif feature üretilemedi — keyword mapping eksik olabilir)");
  }
  for (const id of featureIds) {
    const f = features[id];
    const evidence = (f.evidence ?? []).join(", ");
    console.log(
      `    • ${id.padEnd(26)} strength: ${String(f.strength).padStart(3)}  conf: ${f.confidence.toFixed(2)}  [${f.source}; kanıt: ${evidence}]`
    );
  }
  console.log(`  completeness: ${completeness}  metadataHash: ${metadataHash}`);

  if (perMetricContrib.length > 0) {
    console.log(`  Metrik Katkıları (Faz 3, C_im = R × F' × Q):`);
    for (const c of perMetricContrib) {
      const dir = c.contribution > 0 ? "posMass" : c.contribution < 0 ? "negMass" : "nötr";
      console.log(
        `    • ${c.metricId.padEnd(26)} ${dir} ${c.contribution >= 0 ? "+" : ""}${c.contribution.toFixed(4)}  (${c.signal.toFixed(2)} × ${(c.strength / 100).toFixed(2)} × ${c.confidence.toFixed(2)})`
      );
    }
  } else if (meta.rating !== "") {
    console.log("  Metrik Katkıları: hiç feature üretilmediği için katkı yok.");
  }
}

function reportProfile(profileMetrics, metricsById) {
  console.log(`\n${"=".repeat(70)}`);
  console.log("GENEL PROFİL TAHMİNİ (Faz 3 — A_m = (S + k×μ) / (D + k), k = 2.5)");
  console.log("=".repeat(70));

  const rows = Object.values(profileMetrics)
    .filter((m) => m.masses.evidenceCount > 0)
    .sort((a, b) => b.affinity - a.affinity);

  if (rows.length === 0) {
    console.log("Örneklemden hiç metrik kanıtı üretilemedi.");
    return;
  }
  for (const m of rows) {
    const def = metricsById.get(m.metricId);
    const conf = m.confidence;
    console.log(
      `${m.metricId.padEnd(26)} affinity: ${fmtAffinity(m.affinity).padStart(5)}  durum: ${TR_STATE[m.status]}` +
        `  Güven: ${TR_CONF[conf.overall]} (destek: ${TR_CONF[conf.support]}, nitelik: ${TR_CONF[conf.quality]}, kapsam: ${TR_CONF[conf.coverage]})`
    );
    console.log(
      `  ${def?.definition ?? ""}  [posMass: ${m.masses.posMass.toFixed(3)}  negMass: ${m.masses.negMass.toFixed(3)}` +
        `  uncertainMass: ${m.masses.uncertainMass.toFixed(3)}  kanıt: ${m.masses.evidenceCount} içerik]`
    );
    if (m.masses.topPositiveContentIds.length > 0) {
      console.log(`  En çok + katkı: ${m.masses.topPositiveContentIds.join(", ")}`);
    }
    if (m.masses.topNegativeContentIds.length > 0) {
      console.log(`  En çok - katkı: ${m.masses.topNegativeContentIds.join(", ")}`);
    }
  }

  const unknownCount = Object.values(profileMetrics).filter(
    (m) => m.masses.evidenceCount === 0
  ).length;
  console.log(
    `\nKanıtsız (unknown) metrik sayısı: ${unknownCount} — örneklem küçük olduğu için normaldir ` +
      `(yön için en az ${MIN_EVIDENCE_FOR_DIRECTIONAL} kanıt gerekir).`
  );
}

function reportWarnings(warnings) {
  if (warnings.length === 0) return;
  console.log(`\n${"!".repeat(70)}`);
  console.log(`UYARILAR (${warnings.length})`);
  console.log("!".repeat(70));
  for (const w of warnings) console.log(`  • ${w}`);
}

// ===========================================================================
// ANA AKIŞ
// ===========================================================================
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const warnings = [];
  const apiKey = resolveApiKey();
  if (args.csv && !fs.existsSync(args.csv)) {
    console.error(`HATA: CSV dosyası bulunamadı: ${args.csv}`);
    process.exit(1);
  }

  // 1) Veri yükleme (salt-okunur)
  let entries = null;
  if (args.csv) {
    entries = loadEntriesFromCsv(args.csv, warnings);
  } else {
    entries = loadEntriesFromJson(args.data, warnings);
    if (entries === null) {
      console.error(
        `HATA: ${args.data} bulunamadı.\n` +
          `  Veri dosyası bu çalışma kopyasında yoksa --csv <yol> ile CSV dışa aktarımınızı verin:\n` +
          `  node --env-file=.env scripts/validate-real-data.mjs --csv "C:\\Users\\<kullanici>\\Downloads\\cinetrack-profile-default-*.csv"`
      );
      process.exit(1);
    }
  }
  const ratedCount = entries.filter((e) => e.rating !== "").length;
  console.log(`Veri kaynağı: ${args.csv ? args.csv : args.data}`);
  console.log(`Toplam içerik: ${entries.length} (puanlı: ${ratedCount})`);

  // 2) Örneklem
  const sample = selectSample(entries, args, warnings);
  const ratedInSample = sample.filter((e) => e.rating !== "").length;
  console.log(
    `Örneklem: ${sample.length} içerik (${ratedInSample} puanlı, ${sample.length - ratedInSample} puansız) — seed: ${args.seed}`
  );

  // Taksonomi: çalışma zamanı artefaktı (drift önleme)
  const taxonomyPath = path.join(PROJECT_ROOT, "data", "taste", "cinetrack-taste-taxonomy.json");
  if (!fs.existsSync(taxonomyPath)) {
    console.error(`HATA: Taksonomi dosyası bulunamadı: ${taxonomyPath}`);
    process.exit(1);
  }
  const taxonomyDoc = JSON.parse(fs.readFileSync(taxonomyPath, "utf8"));
  const metrics = Array.isArray(taxonomyDoc.metrics) ? taxonomyDoc.metrics : [];
  const mappings = taxonomyDoc.tmdbMappings;
  if (!mappings?.movieGenreIds || !mappings?.tvGenreIds) {
    console.error("HATA: Taksonomi JSON'unda tmdbMappings eksik.");
    process.exit(1);
  }
  if (taxonomyDoc.taxonomyVersion !== TAXONOMY_VERSION) {
    warnings.push(
      `UYARI: Taksonomi sürümü uyuşmazlığı (dosya: ${taxonomyDoc.taxonomyVersion}, beklenen: ${TAXONOMY_VERSION}).`
    );
  }
  const metricsById = new Map(metrics.map((m) => [m.id, m]));

  // 3) Canlı TMDB çağrıları + 4) Faz 2 + 5) Faz 3
  const stats = { calls: 0, rateLimitHits: 0, notFound: 0 };
  const evidenceByMetric = new Map(); // metricId -> MetricEvidence[]
  const perContent = [];

  for (const entry of sample) {
    const res = await fetchContentMetadata(entry, apiKey, stats);
    if (res.status !== 200) {
      if (res.status === 404) {
        stats.notFound++;
        warnings.push(
          `UYARI: ${entry.mediaType}:${entry.tmdbId} (${entry.title}) TMDB'de bulunamadı (404) — atlandı.`
        );
      } else {
        warnings.push(
          `UYARI: ${entry.mediaType}:${entry.tmdbId} (${entry.title}) TMDB çağrısı başarısız` +
            `${res.error ? `: ${res.error.message}` : ""} — atlandı.`
        );
      }
      await sleep(args.delayMs);
      continue;
    }

    const meta = res.meta;
    if ((meta.keywords ?? []).length === 0) {
      warnings.push(
        `UYARI: ${meta.contentId} — keywords boş/eksik; keyword'den türetilen metrikler (mood, narrative, concept, character, style, setting) unknown kalır.`
      );
    }
    if (
      meta.mediaType === "movie" &&
      (!meta.productionCountries || meta.productionCountries.length === 0) &&
      !meta.originalLanguage
    ) {
      warnings.push(`UYARI: ${meta.contentId} — production_countries ve original_language eksik; origin metrikleri üretilemedi.`);
    }

    // Faz 2: çıkarım + normalizasyon
    const rawFeatures = extractRawFeatures(meta, mappings, warnings);
    const features = normalizeFeatures(rawFeatures, metrics);
    const completeness = computeCompleteness(features, meta.mediaType, metrics);
    const metadataHash = buildMetadataHash(meta);

    // Faz 3: davranış sinyali + katkılar
    let signal = 0;
    const perMetricContrib = [];
    if (meta.rating !== "") {
      signal = behaviorSignalForRating(meta.rating);
      for (const [metricId, feat] of Object.entries(features)) {
        const def = metricsById.get(metricId);
        if (!def || !def.scoringEnabled) continue;
        const contribution = signal * (feat.strength / 100) * feat.confidence;
        const baseWeight = (feat.strength / 100) * feat.confidence;
        const evidence = {
          contentId: meta.contentId,
          eventId: crypto.randomUUID(),
          metricId,
          contribution,
          baseWeight,
          featureStrength: feat.strength,
          confidence: feat.confidence,
          behaviorSignal: signal,
          timeWeight: 1,
          groupDamping: 1,
          direction: contribution > 0 ? "positive" : contribution < 0 ? "negative" : "neutral",
          recordedAt: new Date().toISOString(),
        };
        if (!evidenceByMetric.has(metricId)) evidenceByMetric.set(metricId, []);
        evidenceByMetric.get(metricId).push(evidence);
        perMetricContrib.push({
          metricId,
          contribution,
          signal,
          strength: feat.strength,
          confidence: feat.confidence,
        });
      }
    }
    perMetricContrib.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));

    perContent.push({ meta, features, completeness, metadataHash, signal, perMetricContrib });
    reportContent(meta, features, completeness, metadataHash, signal, perMetricContrib, warnings);
    await sleep(args.delayMs);
  }

  // 6) Profil agregasyonu
  const profileMetrics = {};
  for (const metricDef of metrics) {
    if (!metricDef.scoringEnabled) continue;
    const evidences = evidenceByMetric.get(metricDef.id) ?? [];
    const masses = computeMasses(evidences);
    const preference = computePreference(masses);
    const avgFeatureConfidence =
      evidences.length > 0
        ? evidences.reduce((s, e) => s + e.confidence, 0) / evidences.length
        : 0;
    // Faz 0 bulgusu: ratedAt yok, timePrecision "unknown" → hasExactDate = false
    const confidence = computeConfidence(masses, avgFeatureConfidence, false);
    profileMetrics[metricDef.id] = {
      metricId: metricDef.id,
      affinity: preference.affinity,
      status: preference.status,
      masses,
      confidence,
    };
  }

  reportProfile(profileMetrics, metricsById);

  // İstatistikler
  console.log(`\n${"-".repeat(70)}`);
  console.log("İSTATİSTİKLER");
  console.log("-".repeat(70));
  console.log(`  TMDB çağrısı: ${stats.calls} (başarılı: ${perContent.length}, 404: ${stats.notFound}, rate-limit: ${stats.rateLimitHits})`);
  const avgCompleteness =
    perContent.length > 0
      ? perContent.reduce((s, c) => s + c.completeness, 0) / perContent.length
      : 0;
  console.log(`  Ortalama completeness (Faz 2): ${(avgCompleteness * 100).toFixed(1)}%`);
  const profileEntries = Object.values(profileMetrics);
  console.log(
    `  Profil metrikleri: ${profileEntries.length} (kanıtlı: ${profileEntries.filter((m) => m.masses.evidenceCount > 0).length})`
  );
  console.log(`  Shrinkage: k = ${SHRINKAGE_K}  |  Yön eşiği: ${MIN_EVIDENCE_FOR_DIRECTIONAL} kanıt`);

  reportWarnings(warnings);
  console.log("\nDoğrulama tamamlandı. (cinetrack-data.json dosyasına yazılmadı — salt okunur çalıştırıldı)");
}

main().catch((err) => {
  console.error("BEKLENMEYEN HATA:", err);
  process.exit(1);
});
