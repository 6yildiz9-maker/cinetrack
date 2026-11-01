import type ExcelJS from 'exceljs';
import type { Profile, SavedItem } from '../core/cinetrack-core.ts';
import { buildTasteDnaProfile, type TasteDnaProfile } from '../core/exporters.ts';
import {
  computeProfileCentroid,
  cosineSimilarity,
  encodeItemContent,
  STANDARD_GENRE_IDS,
} from '../core/encoding.ts';

const TR_MONTH_NAMES = [
  'Ocak',
  'Şubat',
  'Mart',
  'Nisan',
  'Mayıs',
  'Haziran',
  'Temmuz',
  'Ağustos',
  'Eylül',
  'Ekim',
  'Kasım',
  'Aralık',
] as const;

const DEFAULT_GENRE_LABELS: Record<number, string> = {
  28: 'aksiyon',
  12: 'macera',
  16: 'animasyon',
  35: 'komedi',
  80: 'suç',
  99: 'belgesel',
  18: 'dram',
  10751: 'aile',
  14: 'fantastik',
  36: 'tarih',
  27: 'korku',
  10402: 'müzik',
  9648: 'gizem',
  10749: 'romantik',
  878: 'bilim kurgu',
  10770: 'TV filmi',
  53: 'gerilim',
  10752: 'savaş',
  37: 'vahşi batı',
  10759: 'aksiyon & macera',
  10765: 'bilim kurgu & fantazi',
};

const DARK_GENRE_IDS = new Set<number>([27, 53, 80, 9648]);

export interface MonthlyCentroidSnapshot {
  monthKey: string;
  monthLabel: string;
  itemCount: number;
  averageRating: number | null;
  dominantSignature: string;
  centroid: number[];
}

export interface TasteDriftTransition {
  fromMonthKey: string;
  toMonthKey: string;
  fromLabel: string;
  toLabel: string;
  similarityPercent: number;
  driftPercent: number;
  narrative: string;
}

export interface TasteDnaSheetAnalysis {
  dna: TasteDnaProfile;
  monthlySnapshots: MonthlyCentroidSnapshot[];
  driftTransitions: TasteDriftTransition[];
}

function parseItemMonth(item: SavedItem): { monthKey: string; year: number; monthIdx: number } | null {
  const candidates = [item.updatedAt, item.addedAt, item.firstAddedAt];
  for (const raw of candidates) {
    if (!raw || typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    if (!trimmed || trimmed === '1970-01-01T00:00:00.000Z') continue;
    const dt = new Date(trimmed);
    if (!Number.isNaN(dt.getTime())) {
      const yr = dt.getUTCFullYear();
      const mIdx = dt.getUTCMonth();
      if (yr >= 2000 && yr <= 2100 && mIdx >= 0 && mIdx < 12) {
        return {
          monthKey: `${yr}-${String(mIdx + 1).padStart(2, '0')}`,
          year: yr,
          monthIdx: mIdx,
        };
      }
    }
  }
  return null;
}

function describeCentroidFlavor(
  centroid: number[],
  items: SavedItem[],
  genresMap: Record<number, string>
): string {
  // Rank genres from centroid [0..26]
  const genreScores: Array<{ gid: number; score: number }> = [];
  for (let i = 0; i < STANDARD_GENRE_IDS.length && i < centroid.length; i += 1) {
    if (centroid[i] > 0.05) {
      genreScores.push({ gid: STANDARD_GENRE_IDS[i], score: centroid[i] });
    }
  }
  genreScores.sort((a, b) => b.score - a.score);

  // Check dark tone dims [31..46] or dark genres
  const toneSlice = centroid.slice(31, 47);
  const toneEnergy = toneSlice.reduce((sum, v) => sum + v, 0);
  const topGenreId = genreScores[0]?.gid ?? 0;
  const secondGenreId = genreScores[1]?.gid ?? 0;

  const resolveGenreLower = (gid: number): string => {
    const custom = genresMap[gid];
    if (custom) return custom.toLocaleLowerCase('tr-TR');
    return DEFAULT_GENRE_LABELS[gid] || `tür #${gid}`;
  };

  if (genreScores.length === 0) {
    const tvRatio =
      items.length > 0 ? items.filter((it) => it.media_type === 'tv').length / items.length : 0;
    return tvRatio >= 0.6 ? 'dizi seçkisi ağırlıklı' : 'genel sinema seçkisi';
  }

  const primaryGenre = resolveGenreLower(topGenreId);
  const hasDarkAtmosphere = DARK_GENRE_IDS.has(topGenreId) || toneEnergy >= 0.35;

  if (hasDarkAtmosphere && (topGenreId === 53 || topGenreId === 9648 || topGenreId === 80 || topGenreId === 27)) {
    return `karanlık ${primaryGenre} ağırlıklı`;
  }

  if (secondGenreId && genreScores[1].score >= genreScores[0].score * 0.65) {
    const secondaryGenre = resolveGenreLower(secondGenreId);
    return `${primaryGenre} ve ${secondaryGenre} ekseni`;
  }

  return `${primaryGenre} ağırlıklı`;
}

/**
 * Computes Taste DNA profile, monthly feature centroids, and consecutive taste drift transitions
 * for the `tasteDna` Excel worksheet (IMP-14).
 */
export function computeMonthlyTasteDrift(
  profile: Profile,
  genresMap: Record<number, string> = {}
): TasteDnaSheetAnalysis {
  const dna = buildTasteDnaProfile(profile, genresMap);
  const items = Array.isArray(profile.items) ? profile.items : [];

  const buckets = new Map<
    string,
    { year: number; monthIdx: number; items: SavedItem[] }
  >();

  for (const item of items) {
    const parsed = parseItemMonth(item);
    if (!parsed) continue;
    const existing = buckets.get(parsed.monthKey);
    if (existing) {
      existing.items.push(item);
    } else {
      buckets.set(parsed.monthKey, {
        year: parsed.year,
        monthIdx: parsed.monthIdx,
        items: [item],
      });
    }
  }

  const sortedKeys = Array.from(buckets.keys()).sort((a, b) => a.localeCompare(b));
  const monthlySnapshots: MonthlyCentroidSnapshot[] = [];

  for (const monthKey of sortedKeys) {
    const bucket = buckets.get(monthKey)!;
    const encoded = bucket.items.map((it) => ({
      encoding: encodeItemContent(it),
      personal_rating: it.personal_rating,
    }));
    const weights: Record<string, number> = {};
    for (const it of bucket.items) {
      const mType = it.media_type === 'tv' ? 'tv' : 'movie';
      weights[`${mType}:${it.id}`] =
        it.status === 'completed' ? 1.0 : it.status === 'watching' ? 0.75 : 0.5;
    }

    const centroid = computeProfileCentroid(encoded, weights);
    const rated = bucket.items.filter(
      (it) => typeof it.personal_rating === 'number' && it.personal_rating > 0
    );
    const averageRating =
      rated.length > 0
        ? Math.round(
            (rated.reduce((s, it) => s + Number(it.personal_rating || 0), 0) / rated.length) * 10
          ) / 10
        : null;

    const monthLabel = `${TR_MONTH_NAMES[bucket.monthIdx]} ${bucket.year}`;
    const dominantSignature = describeCentroidFlavor(centroid, bucket.items, genresMap);

    monthlySnapshots.push({
      monthKey,
      monthLabel,
      itemCount: bucket.items.length,
      averageRating,
      dominantSignature,
      centroid,
    });
  }

  const driftTransitions: TasteDriftTransition[] = [];
  for (let i = 0; i < monthlySnapshots.length - 1; i += 1) {
    const prev = monthlySnapshots[i];
    const next = monthlySnapshots[i + 1];
    const sim = cosineSimilarity(prev.centroid, next.centroid);
    const similarityPercent = Math.round(sim * 100);
    const driftPercent = Math.max(0, 100 - similarityPercent);
    const narrative = `${prev.monthLabel}: ${prev.dominantSignature} → ${next.monthLabel}: ${next.dominantSignature}`;

    driftTransitions.push({
      fromMonthKey: prev.monthKey,
      toMonthKey: next.monthKey,
      fromLabel: `${prev.monthLabel}: ${prev.dominantSignature}`,
      toLabel: `${next.monthLabel}: ${next.dominantSignature}`,
      similarityPercent,
      driftPercent,
      narrative,
    });
  }

  return {
    dna,
    monthlySnapshots,
    driftTransitions,
  };
}

/**
 * Adds and formats the `tasteDna` worksheet inside an ExcelJS workbook for `xlsx_only` exports (IMP-14).
 */
export function populateTasteDnaWorksheet(
  workbook: ExcelJS.Workbook,
  profile: Profile,
  genresMap: Record<number, string> = {}
): TasteDnaSheetAnalysis {
  const analysis = computeMonthlyTasteDrift(profile, genresMap);
  const ws = workbook.addWorksheet('tasteDna', {
    views: [{ state: 'frozen', ySplit: 3 }],
  });

  ws.columns = [
    { key: 'colA', width: 28 },
    { key: 'colB', width: 34 },
    { key: 'colC', width: 46 },
    { key: 'colD', width: 18 },
    { key: 'colE', width: 18 },
  ];

  // Title banner
  ws.mergeCells('A1:E1');
  const titleCell = ws.getCell('A1');
  titleCell.value = `CineTrack Zevk İmzası (Taste DNA) & Zevk Kayması — ${analysis.dna.profileName}`;
  titleCell.font = { name: 'Calibri', size: 14, bold: true, color: { argb: 'FFFFFFFF' } };
  titleCell.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FF312E81' },
  };
  titleCell.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
  ws.getRow(1).height = 30;

  ws.mergeCells('A2:E2');
  const subCell = ws.getCell('A2');
  subCell.value = `Toplam Kayıt: ${analysis.dna.totalTracked} · İzlenen: ${analysis.dna.completedCount} · Baskın Dönem: ${analysis.dna.dominantEra} · Format: %${analysis.dna.movieRatioPercent} Film / %${analysis.dna.tvRatioPercent} Dizi`;
  subCell.font = { name: 'Calibri', size: 10, italic: true, color: { argb: 'FF3730A3' } };
  subCell.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFEEF2FF' },
  };
  subCell.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
  ws.getRow(2).height = 22;

  const addSectionHeader = (title: string) => {
    const r = ws.addRow([title, '', '', '', '']);
    ws.mergeCells(`A${r.number}:E${r.number}`);
    const cell = r.getCell(1);
    cell.font = { name: 'Calibri', size: 11, bold: true, color: { argb: 'FF1E1B4B' } };
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFE0E7FF' },
    };
    r.height = 22;
  };

  const styleTableHeader = (row: ExcelJS.Row) => {
    row.height = 20;
    row.eachCell((cell) => {
      cell.font = { name: 'Calibri', size: 10, bold: true, color: { argb: 'FF0F172A' } };
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFF1F5F9' },
      };
    });
  };

  ws.addRow([]);
  addSectionHeader('1. Zevk İmzası Karakteristikleri');
  styleTableHeader(ws.addRow(['Boyut', 'Baskın Değer', 'Açıklama', 'Baskın Tür', 'Pay (%)']));

  const maxTraitRows = Math.max(analysis.dna.signatureTraits.length, analysis.dna.topGenres.length);
  for (let i = 0; i < maxTraitRows; i += 1) {
    const trait = analysis.dna.signatureTraits[i];
    const genre = analysis.dna.topGenres[i];
    const row = ws.addRow([
      trait?.label || '',
      trait?.value || '',
      trait?.detail || '',
      genre?.name || '',
      genre ? `%${genre.sharePercent}` : '',
    ]);
    row.height = 19;
    row.eachCell((cell) => {
      cell.font = { name: 'Calibri', size: 10, color: { argb: 'FF334155' } };
    });
  }

  ws.addRow([]);
  addSectionHeader('2. Aylık Centroid Özetleri');
  styleTableHeader(
    ws.addRow(['Ay / Dönem', 'Baskın Zevk Ekseni', 'Ay Kodu', 'İçerik Sayısı', 'Ort. Kişisel Puan'])
  );

  if (analysis.monthlySnapshots.length === 0) {
    const emptyRow = ws.addRow(['Tarihli kayıt bulunamadı', '-', '-', 0, '-']);
    emptyRow.height = 19;
  } else {
    for (const snap of analysis.monthlySnapshots) {
      const r = ws.addRow([
        snap.monthLabel,
        snap.dominantSignature,
        snap.monthKey,
        snap.itemCount,
        snap.averageRating !== null ? snap.averageRating : '-',
      ]);
      r.height = 19;
      r.eachCell((cell) => {
        cell.font = { name: 'Calibri', size: 10, color: { argb: 'FF1E293B' } };
      });
    }
  }

  ws.addRow([]);
  addSectionHeader('3. Zevk Kayması (Taste Drift Analizi)');
  styleTableHeader(
    ws.addRow(['Başlangıç Ekseni', 'Hedef Ekseni', 'Zevk Kayması Özeti', 'Benzerlik (%)', 'Kayma (%)'])
  );

  if (analysis.driftTransitions.length === 0) {
    const singleNote =
      analysis.monthlySnapshots.length === 1
        ? `${analysis.monthlySnapshots[0].monthLabel}: ${analysis.monthlySnapshots[0].dominantSignature} (karşılaştırma için en az 2 ay gerekir)`
        : 'Zevk kayması hesaplamak için en az iki farklı ayda kayıt gereklidir.';
    const r = ws.addRow(['-', '-', singleNote, '-', '-']);
    r.height = 19;
  } else {
    for (const tr of analysis.driftTransitions) {
      const r = ws.addRow([
        tr.fromLabel,
        tr.toLabel,
        tr.narrative,
        `%${tr.similarityPercent}`,
        `%${tr.driftPercent}`,
      ]);
      r.height = 20;
      r.eachCell((cell, colNumber) => {
        cell.font = {
          name: 'Calibri',
          size: 10,
          bold: colNumber === 3,
          color: { argb: colNumber === 3 ? 'FF312E81' : 'FF1E293B' },
        };
      });
    }
  }

  return analysis;
}
