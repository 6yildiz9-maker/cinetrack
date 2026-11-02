// CineTrack Hibrit Yedek Birleştirme CLI
// Kullanım: node scripts/hybrid-merge.mjs [csv-yolu] [--apply] [--server <url>]
// Varsayılan: Downloads'taki en yeni cinetrack-profile-*.csv, kuru çalıştırma (önizleme).
// --apply: birleştirmeyi kaydeder (ardından UI'dan veya sync API'sinden GitHub'a eşitlenebilir).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const applyFlag = args.includes('--apply');
const serverIdx = args.indexOf('--server');
const serverUrl =
  serverIdx >= 0 && args[serverIdx + 1] ? args[serverIdx + 1] : 'http://127.0.0.1:3000';
const csvArg = args.find((a) => !a.startsWith('--') && a !== args[serverIdx + 1]);

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

const csvText = fs.readFileSync(csvPath, 'utf8');
console.log(
  `Mod: ${applyFlag ? 'KAYDET (birleştir)' : 'ÖNİZLEME (kuru çalıştırma)'} | Sunucu: ${serverUrl} | CSV boyutu: ${(csvText.length / 1024).toFixed(1)} KB`
);

const res = await fetch(`${serverUrl}/api/backup/hybrid-merge`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ csvText, dryRun: !applyFlag }),
});
const body = await res.json().catch(() => ({}));

if (!res.ok || !body.ok) {
  console.error(
    `BİRLEŞTİRME HATASI (HTTP ${res.status}): ${JSON.stringify(body).slice(0, 500)}`
  );
  process.exit(1);
}

const r = body.report || {};
console.log('--- RAPOR ---');
console.log(`CSV kaydı: ${r.csvRowsParsed} | Hatalı satır: ${r.csvRowsFailed} | Kimliksiz atlanan: ${r.csvRowsSkippedNoId}`);
console.log(`CSV içi çift satır temizlendi: ${r.csvDuplicateRowsRemoved}`);
console.log(`Kimlikle eşleşip birleşen: ${r.mergedByIdCount} | Başlık+yıl ile eşleşen: ${r.matchedByTitleYearCount} | Yeni kayıt: ${r.newItemsCreated}`);
console.log(`Yıl bilgisi işlenen kayıt: ${r.yearEnrichedCount} | Çakışma çözümü: ${r.conflictResolutionCount}`);
for (const s of r.conflictSamples || []) console.log(`  - ${s}`);
if ((r.suspiciousDuplicatePairs || []).length > 0) {
  console.log(`Şüpheli çiftler (${r.suspiciousDuplicatePairs.length}):`);
  for (const p of r.suspiciousDuplicatePairs) console.log(`  - ${p.a} <-> ${p.b} (${p.reason})`);
}
console.log(`Son kayıt sayısı: ${r.finalItemCount}`);
if (body.dryRun) {
  console.log('ÖNİZLEME — veri kaydedilmedi. Kaydetmek için --apply ekleyin.');
} else {
  console.log(`KAYDEDİLDİ: rev-${body.revision}, toplam kayıt: ${body.items}`);
  console.log('GitHub\'a yazmak için: curl -X POST http://127.0.0.1:3000/api/sync/reconcile -H "Content-Type: application/json" -d "{}"');
}
