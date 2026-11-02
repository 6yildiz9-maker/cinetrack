// CineTrack CSV -> cinetrack-data.json tohumlama aracı
// Kullanım: node scripts/seed-from-csv.mjs "<csv-yolu>" [server-url]
// Varsayılan: en yeni profil CSV'si ve http://127.0.0.1:3000
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const serverUrl = process.argv[3] || 'http://127.0.0.1:3000';
const csvArg = process.argv[2];
let csvPath = csvArg;
if (!csvPath) {
  const downloads = path.join(os.homedir(), 'Downloads');
  const candidates = fs
    .readdirSync(downloads)
    .filter((f) => /^cinetrack-profile-.*\.csv$/i.test(f))
    .sort()
    .reverse();
  if (candidates.length === 0) {
    console.error('Downloads klasöründe cinetrack-profile-*.csv bulunamadı.');
    process.exit(1);
  }
  csvPath = path.join(downloads, candidates[0]);
  console.log(`Otomatik seçilen CSV: ${candidates[0]}`);
}

const raw = fs.readFileSync(csvPath, 'utf8').replace(/^\uFEFF/, '');
const lines = raw.split(/\r?\n/).filter((l) => l.trim() !== '');
if (lines.length < 2) {
  console.error('CSV boş veya başlık satırı eksik.');
  process.exit(1);
}

// Başlık: Title,Year,Rating10,WatchedDate,Status,MediaType,tmdbID
// Başlıklar virgül içerebildiği için satırın SON 6 alanı sabittir;
// başlık greedy yakalanır.
const ROW_RE = /^(.*),(\d{4})?,([^,]*),([^,]*),(watching|watchlist|completed),(movie|tv),(\d+)$/;
const items = [];
const failures = [];
let skippedNoId = 0;

for (const line of lines.slice(1)) {
  const m = ROW_RE.exec(line.trim());
  if (!m) {
    failures.push(line.slice(0, 80));
    continue;
  }
  let [, rawTitle, , ratingStr, watchedDate, status, mediaType, tmdbId] = m;
  let title = rawTitle.trim();
  if (title.length >= 2 && title.startsWith('"') && title.endsWith('"')) {
    title = title.slice(1, -1).replace(/""/g, '"').trim();
  }
  if (!title || !tmdbId) {
    skippedNoId++;
    continue;
  }
  const ratingNum = Number(ratingStr);
  const personal_rating =
    ratingStr !== '' && Number.isInteger(ratingNum) && ratingNum >= 1 && ratingNum <= 10
      ? ratingNum
      : '';
  const dateIso = /^\d{4}-\d{2}-\d{2}$/.test(watchedDate)
    ? `${watchedDate}T00:00:00.000Z`
    : undefined;
  const item = {
    id: tmdbId,
    media_type: mediaType,
    title,
    status,
    personal_rating,
    ...(dateIso ? { addedAt: dateIso, firstAddedAt: dateIso, updatedAt: dateIso } : {}),
    ...(dateIso && status === 'completed' ? { completedAt: dateIso } : {}),
    ...(dateIso && personal_rating !== '' ? { ratedAt: dateIso } : {}),
  };
  items.push(item);
}

console.log(`Ayrıştırılan kayıt: ${items.length} | Hatalı satır: ${failures.length} | Kimliksiz atlanan: ${skippedNoId}`);
for (const f of failures.slice(0, 5)) console.log(`  HATALI: ${f}`);
if (failures.length > 5) console.log(`  ... ve ${failures.length - 5} satır daha`);

const document = {
  version: 3,
  schemaVersion: 3,
  engineVersion: 'v3.2.0',
  activeProfileId: 'profile-default',
  profiles: [
    {
      id: 'profile-default',
      name: 'default',
      items,
      preferences: { disliked: [], hidden: [] },
      favoriteActors: [],
    },
  ],
  revision: 0,
  updatedAt: new Date().toISOString(),
};

const res = await fetch(`${serverUrl}/api/data`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(document),
});
const body = await res.json().catch(() => ({}));
if (res.ok && body.ok) {
  console.log(`SUNUCUYA YAZILDI: rev-${body.revision}, profil: ${body.profiles}, toplam kayıt: ${body.items}`);
} else {
  console.error(`SUNUCU YAZMA HATASI (HTTP ${res.status}): ${JSON.stringify(body).slice(0, 400)}`);
  process.exit(1);
}
