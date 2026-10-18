import { createServer } from "node:http";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.CINETRACK_PORT) || 4173;

// Veri temizliği, tarayıcı ve testlerle aynı çekirdek mantıktan gelir.
const coreContext = vm.createContext({ URL, AbortController });
vm.runInContext(readFileSync(path.join(root, "cinetrack-core.js"), "utf8"), coreContext, { filename: "cinetrack-core.js" });
const { normalizeDataDocument } = coreContext.CineTrackCore;

const dataDir = path.join(root, "data");
const dataFile = path.join(dataDir, "cinetrack-data.json");
const dataBackupFile = path.join(dataDir, "cinetrack-data.bak.json");
const maxDataBytes = 2_000_000;
const maxProfiles = 20;
const maxItemsPerProfile = 5000;
const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
const allowedOrigins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);

const envPath = path.join(root, ".env.local");
let envFile = "";

try {
  envFile = readFileSync(envPath, "utf8");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

const localEnv = Object.fromEntries(
  envFile.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const separator = line.indexOf("=");
      if (separator < 1) return ["", ""];
      const key = line.slice(0, separator).trim();
      const value = line.slice(separator + 1).trim().replace(/^(['"])(.*)\1$/, "$2");
      return [key, value];
    })
    .filter(([key]) => key),
);
const tmdbApiKey = process.env.TMDB_API_KEY || localEnv.TMDB_API_KEY || "";
const allowedPath =
  /^\/(?:trending\/(?:all|movie|tv)\/(?:day|week)|genre\/(?:movie|tv)\/list|search\/multi|discover\/(?:movie|tv)|person\/\d+(?:\/combined_credits)?|(?:movie|tv)\/(?:popular|top_rated|upcoming|on_the_air|\d+(?:\/(?:recommendations|similar|watch\/providers))?))$/;
const allowedQueryKeys = new Set([
  "language",
  "query",
  "page",
  "include_adult",
  "append_to_response",
  "with_genres",
  "sort_by",
  "vote_average.gte",
  "vote_count.gte",
  "vote_count.lte",
  "primary_release_date.gte",
  "primary_release_date.lte",
  "first_air_date.gte",
  "first_air_date.lte",
  "with_people",
  "with_watch_providers",
  "watch_region",
]);

function sendJson(response, status, body) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(body));
}

function emptyDocument() {
  return { version: 3, activeProfileId: "", profiles: [] };
}

function readData() {
  for (const file of [dataFile, dataBackupFile]) {
    try {
      const document = normalizeDataDocument(JSON.parse(readFileSync(file, "utf8")), { maxProfiles, maxItems: maxItemsPerProfile });
      if (document) return document;
      console.error(`Veri dosyası biçimi geçersiz: ${path.basename(file)}`);
    } catch (error) {
      if (error.code !== "ENOENT") console.error(`Veri dosyası okunamadı (${path.basename(file)}):`, error.message);
    }
  }
  return emptyDocument();
}

function backupExistingData() {
  if (!existsSync(dataFile)) return;
  let worthKeeping = true;
  try {
    const existing = JSON.parse(readFileSync(dataFile, "utf8"));
    const profiles = Array.isArray(existing?.profiles) ? existing.profiles : [];
    worthKeeping = profiles.length > 0
      ? profiles.some((profile) => Array.isArray(profile?.items) && profile.items.length > 0) || profiles.length > 1
      : Boolean(existing?.profileName) || (Array.isArray(existing?.items) && existing.items.length > 0);
  } catch {
    worthKeeping = true; // Bozuk dosya da yedeğe alınır.
  }
  if (worthKeeping) copyFileSync(dataFile, dataBackupFile);
}

function writeData(data) {
  mkdirSync(dataDir, { recursive: true });
  backupExistingData();
  const temporaryFile = `${dataFile}.tmp`;
  writeFileSync(temporaryFile, JSON.stringify(data, null, 2), "utf8");
  renameSync(temporaryFile, dataFile);
}

function readBody(request, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        request.destroy();
        reject(new Error("İstek gövdesi çok büyük."));
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

async function handleData(request, response) {
  const origin = request.headers.origin;
  if (!allowedHosts.has(request.headers.host || "") || (origin && !allowedOrigins.has(origin))) {
    sendJson(response, 403, { status_message: "Yalnızca yerel CineTrack sayfası kullanılabilir." });
    return;
  }
  if (request.method === "GET") {
    sendJson(response, 200, readData());
    return;
  }
  if (request.method !== "PUT") {
    response.writeHead(405, { Allow: "GET, PUT" });
    response.end("Method Not Allowed");
    return;
  }
  if (!origin) {
    sendJson(response, 403, { status_message: "Kayıt isteği tarayıcıdaki CineTrack sayfasından gelmelidir." });
    return;
  }
  if (!/^application\/json\b/i.test(request.headers["content-type"] || "")) {
    sendJson(response, 415, { status_message: "İçerik türü application/json olmalıdır." });
    return;
  }
  if (Number(request.headers["content-length"] || 0) > maxDataBytes) {
    sendJson(response, 413, { status_message: "Veri 2 MB sınırını aşıyor." });
    return;
  }
  try {
    const document = normalizeDataDocument(JSON.parse(await readBody(request, maxDataBytes)), { maxProfiles, maxItems: maxItemsPerProfile });
    if (!document) {
      sendJson(response, 400, { status_message: "Veri biçimi geçersiz." });
      return;
    }
    writeData(document);
    sendJson(response, 200, {
      ok: true,
      profiles: document.profiles.length,
      items: document.profiles.reduce((sum, profile) => sum + profile.items.length, 0)
    });
  } catch (error) {
    if (error instanceof SyntaxError) {
      sendJson(response, 400, { status_message: "Veri JSON olarak okunamadı." });
      return;
    }
    console.error("Veri kaydedilemedi:", error.message);
    if (!response.headersSent && !response.destroyed) sendJson(response, 500, { status_message: "Veri dosyasına yazılamadı." });
  }
}

function validateParam(key, value) {
  if (key === "query" && value.length > 120) return "Arama ifadesi çok uzun.";
  if (key === "with_genres" && !/^\d+(?:\|\d+)*$/.test(value)) return "Tür kimlikleri geçersiz.";
  if (key === "sort_by" && !/^(?:popularity|vote_average|release_date)\.(?:asc|desc)$/.test(value)) return "Sıralama seçeneği geçersiz.";
  if (key === "vote_average.gte" && (!/^\d+(?:\.\d+)?$/.test(value) || Number(value) > 10)) return "Puan eşiği geçersiz.";
  if (key === "vote_count.gte" && (!/^\d+$/.test(value) || Number(value) > 1_000_000)) return "Oy sayısı eşiği geçersiz.";
  if (key === "vote_count.lte" && (!/^\d+$/.test(value) || Number(value) > 1_000_000)) return "Azami oy sayısı geçersiz.";
  if (["primary_release_date.gte", "primary_release_date.lte", "first_air_date.gte", "first_air_date.lte"].includes(key) && !/^\d{4}-\d{2}-\d{2}$/.test(value)) return "Tarih filtresi geçersiz.";
  if (key === "with_people" && !/^\d+(?:\|\d+)*$/.test(value)) return "Oyuncu kimlikleri geçersiz.";
  if (key === "with_watch_providers" && !/^\d+(?:\|\d+)*$/.test(value)) return "Yayın platformu kimlikleri geçersiz.";
  if (key === "watch_region" && !/^[A-Z]{2}$/.test(value)) return "Bölge kodu geçersiz.";
  if (key === "page" && (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 500)) return "Sayfa numarası geçersiz.";
  if (key === "append_to_response" && value.split(",").some((part) => !["credits", "videos"].includes(part))) return "İstenen detay genişletmesi desteklenmiyor.";
  if (key === "include_adult" && !["true", "false"].includes(value)) return "Yetişkin içerik parametresi geçersiz.";
  return "";
}

const tmdbCacheMaxEntries = 500;
const tmdbCacheTtlMs = 5 * 60_000;
const tmdbCache = new Map();

function tmdbCacheKey(endpoint, searchParams) {
  // Endpoint önek olarak zaten anahtarda; path parametresi yalnızca yinelemesin diye ayıklanır.
  const entries = [...searchParams].filter(([key]) => key !== "path").sort(([a], [b]) => (a < b ? -1 : 1));
  return `${endpoint}?${new URLSearchParams(entries).toString()}`;
}

function tmdbCacheGet(key) {
  const hit = tmdbCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > tmdbCacheTtlMs) {
    tmdbCache.delete(key);
    return null;
  }
  tmdbCache.delete(key);
  tmdbCache.set(key, hit);
  return hit;
}

function tmdbCacheSet(key, entry) {
  tmdbCache.set(key, entry);
  while (tmdbCache.size > tmdbCacheMaxEntries) {
    tmdbCache.delete(tmdbCache.keys().next().value);
  }
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1"}`);
  const origin = request.headers.origin;
  if (url.pathname === "/api/tmdb" && origin && !allowedOrigins.has(origin)) {
    sendJson(response, 403, { status_message: "Yalnızca yerel CineTrack sayfası kullanılabilir." });
    return;
  }
  if (url.pathname === "/api/data") {
    await handleData(request, response);
    return;
  }
  if (url.pathname === "/style.css") {
    try {
      const source = readFileSync(path.join(root, "style.css"));
      response.writeHead(200, {
        "Content-Type": "text/css; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      response.end(source);
    } catch (error) {
      console.error("Could not serve style.css:", error.message);
      response.writeHead(500);
      response.end("style.css could not be read.");
    }
    return;
  }
  if (request.method !== "GET") {
    response.writeHead(405, { Allow: "GET" });
    response.end("Method Not Allowed");
    return;
  }

  if (url.pathname === "/api/tmdb") {
    if (!tmdbApiKey) {
      sendJson(response, 503, {
        status_message: "TMDB_API_KEY eksik. Proje klasöründeki .env.local dosyasına anahtarınızı ekleyip sunucuyu yeniden başlatın.",
      });
      return;
    }

    const endpoint = url.searchParams.get("path") || "";
    if (!allowedPath.test(endpoint)) {
      sendJson(response, 400, { status_message: "TMDB uç noktası izinli değil." });
      return;
    }
    const target = new URL(`https://api.themoviedb.org/3${endpoint}`);
    target.searchParams.set("api_key", tmdbApiKey);
    for (const [key, value] of url.searchParams) {
      if (key === "path") continue;
      if (!allowedQueryKeys.has(key)) {
        sendJson(response, 400, { status_message: `Sorgu parametresi '${key}' izinli değil.` });
        return;
      }
      const invalid = validateParam(key, value);
      if (invalid) {
        sendJson(response, 400, { status_message: invalid });
        return;
      }
      target.searchParams.set(key, value);
    }

    const cacheKey = tmdbCacheKey(endpoint, url.searchParams);
    const cached = tmdbCacheGet(cacheKey);
    if (cached) {
      response.writeHead(200, {
        "Content-Type": cached.contentType,
        "Cache-Control": "public, max-age=180",
        "X-Content-Type-Options": "nosniff",
        "X-CineTrack-Cache": "hit",
      });
      response.end(cached.body);
      return;
    }

    try {
      const upstream = await fetch(target, { signal: AbortSignal.timeout(10_000) });
      const body = await upstream.text();
      if (upstream.ok) tmdbCacheSet(cacheKey, { at: Date.now(), body, contentType: upstream.headers.get("Content-Type") || "application/json; charset=utf-8" });
      response.writeHead(upstream.status, {
        "Content-Type": upstream.headers.get("Content-Type") || "application/json; charset=utf-8",
        "Cache-Control": upstream.ok ? "public, max-age=180" : "no-store",
        "X-Content-Type-Options": "nosniff",
        "X-CineTrack-Cache": "miss",
      });
      response.end(body);
    } catch (error) {
      console.error("TMDB request failed:", error.message);
      sendJson(response, 502, { status_message: "TMDB servisine ulaşılamadı veya istek zaman aşımına uğradı." });
    }
    return;
  }

  if (url.pathname === "/cinetrack-core.js") {
    try {
      const source = readFileSync(path.join(root, "cinetrack-core.js"));
      response.writeHead(200, {
        "Content-Type": "text/javascript; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      response.end(source);
    } catch (error) {
      console.error("Could not serve cinetrack-core.js:", error.message);
      response.writeHead(500);
      response.end("cinetrack-core.js could not be read.");
    }
    return;
  }

  if (url.pathname === "/" || url.pathname === "/CineTrack.html") {
    try {
      const html = readFileSync(path.join(root, "CineTrack.html"));
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      response.end(html);
    } catch (error) {
      console.error("Could not serve CineTrack.html:", error.message);
      response.writeHead(500);
      response.end("CineTrack.html could not be read.");
    }
    return;
  }

  response.writeHead(404);
  response.end("Not Found");
});

server.listen(port, "127.0.0.1", () => {
  console.log(`CineTrack is running at http://127.0.0.1:${port}`);
  console.log(`Profil ve izleme listesi: ${dataFile}`);
  if (!tmdbApiKey) console.warn("TMDB_API_KEY is not configured; add it to .env.local to enable live catalog data.");
});
