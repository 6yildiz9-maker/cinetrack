import {
  makeMediaKey,
  type Profile,
  type SavedItem,
} from './cinetrack-core.ts';

export interface TasteDnaTrait {
  label: string;
  value: string;
  detail: string;
}

export interface TasteDnaProfile {
  profileName: string;
  totalTracked: number;
  completedCount: number;
  averagePersonalRating: number | null;
  movieRatioPercent: number;
  tvRatioPercent: number;
  dominantEra: string;
  topGenres: { id: number; name: string; count: number; sharePercent: number }[];
  topPeople: { id: number; name: string; role: 'Oyuncu' | 'Yönetmen'; count: number }[];
  signatureTraits: TasteDnaTrait[];
}

const DEFAULT_GENRE_NAMES: Record<number, string> = {
  28: 'Aksiyon',
  12: 'Macera',
  16: 'Animasyon',
  35: 'Komedi',
  80: 'Suç',
  99: 'Belgesel',
  18: 'Dram',
  10751: 'Aile',
  14: 'Fantastik',
  36: 'Tarih',
  27: 'Korku',
  10402: 'Müzik',
  9648: 'Gizem',
  10749: 'Romantik',
  878: 'Bilim Kurgu',
  10770: 'TV Filmi',
  53: 'Gerilim',
  10752: 'Savaş',
  37: 'Vahşi Batı',
  10759: 'Aksiyon & Macera',
  10765: 'Bilim Kurgu & Fantazi',
};

export function buildTasteDnaProfile(
  profile: Profile,
  genreMap: Record<number, string> = {}
): TasteDnaProfile {
  const items = Array.isArray(profile.items) ? profile.items : [];
  const totalTracked = items.length;
  const completedItems = items.filter((item) => item.status === 'completed');
  const ratedItems = items.filter(
    (item) => typeof item.personal_rating === 'number' && Number.isFinite(item.personal_rating) && item.personal_rating > 0
  );

  const avgRating =
    ratedItems.length > 0
      ? Math.round(
          (ratedItems.reduce((sum, item) => sum + Number(item.personal_rating || 0), 0) / ratedItems.length) * 10
        ) / 10
      : null;

  const movieCount = items.filter((item) => item.media_type !== 'tv').length;
  const movieRatioPercent = totalTracked > 0 ? Math.round((movieCount / totalTracked) * 100) : 50;
  const tvRatioPercent = totalTracked > 0 ? 100 - movieRatioPercent : 50;

  // Dominant release era
  const decadeBuckets = new Map<string, number>();
  for (const item of items) {
    const rawDate = item.release_date || item.first_air_date || '';
    const year = Number(rawDate.slice(0, 4));
    if (year >= 1920 && year <= 2035) {
      const decade = `${Math.floor(year / 10) * 10}'ler`;
      decadeBuckets.set(decade, (decadeBuckets.get(decade) || 0) + 1);
    }
  }
  let dominantEra = 'Karışık Dönem';
  let bestDecadeCount = 0;
  for (const [decade, count] of decadeBuckets.entries()) {
    if (count > bestDecadeCount) {
      bestDecadeCount = count;
      dominantEra = decade;
    }
  }

  // Weighted genre tally (completed & high rated count slightly more)
  const genreCounts = new Map<number, number>();
  for (const item of items) {
    const gids = Array.isArray(item.genre_ids) ? item.genre_ids : [];
    const weight =
      typeof item.personal_rating === 'number' && item.personal_rating >= 8
        ? 1.5
        : item.status === 'completed'
        ? 1.2
        : 1;
    for (const gid of gids) {
      if (typeof gid === 'number' && gid > 0) {
        genreCounts.set(gid, (genreCounts.get(gid) || 0) + weight);
      }
    }
  }

  const totalGenreWeight = Array.from(genreCounts.values()).reduce((sum, v) => sum + v, 0) || 1;
  const topGenres = Array.from(genreCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([id, weightedCount]) => ({
      id,
      name: genreMap[id] || DEFAULT_GENRE_NAMES[id] || `Tür #${id}`,
      count: Math.round(weightedCount),
      sharePercent: Math.max(1, Math.round((weightedCount / totalGenreWeight) * 100)),
    }));

  // Top people (directors + cast + favorite actors)
  const peopleMap = new Map<string, { id: number; name: string; role: 'Oyuncu' | 'Yönetmen'; count: number }>();
  for (const fav of profile.favoriteActors || []) {
    if (fav && fav.id > 0 && fav.name) {
      peopleMap.set(`actor:${fav.id}`, { id: fav.id, name: fav.name, role: 'Oyuncu', count: 2 });
    }
  }
  for (const item of items) {
    for (const c of (item.crew || []).filter((m) => m.job === 'Director')) {
      const key = `dir:${c.id}`;
      const existing = peopleMap.get(key);
      if (existing) existing.count += 1;
      else peopleMap.set(key, { id: c.id, name: c.name, role: 'Yönetmen', count: 1 });
    }
    for (const actor of (item.cast || []).slice(0, 4)) {
      const key = `actor:${actor.id}`;
      const existing = peopleMap.get(key);
      if (existing) existing.count += 1;
      else peopleMap.set(key, { id: actor.id, name: actor.name, role: 'Oyuncu', count: 1 });
    }
  }
  const topPeople = Array.from(peopleMap.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  const signatureTraits: TasteDnaTrait[] = [
    {
      label: 'Format Dengesi',
      value: movieRatioPercent >= 65 ? 'Sinema Odaklı' : tvRatioPercent >= 65 ? 'Dizi Maratoncusu' : 'Hibrit İzleyici',
      detail: `%${movieRatioPercent} Film · %${tvRatioPercent} Dizi`,
    },
    {
      label: 'Baskın Dönem',
      value: dominantEra,
      detail: bestDecadeCount > 0 ? `${bestDecadeCount} içerik bu dönemden` : 'Henüz dönem verisi az',
    },
    {
      label: 'Puanlama Karakteri',
      value:
        avgRating === null
          ? 'Henüz Puanlanmadı'
          : avgRating >= 8.2
          ? 'Seçici Küratör'
          : avgRating <= 6.2
          ? 'Sert Eleştirmen'
          : 'Dengeli Değerlendirici',
      detail: avgRating !== null ? `Ortalama kişisel puan: ${avgRating}/10` : `${ratedItems.length} puanlı içerik`,
    },
  ];

  return {
    profileName: profile.name,
    totalTracked,
    completedCount: completedItems.length,
    averagePersonalRating: avgRating,
    movieRatioPercent,
    tvRatioPercent,
    dominantEra,
    topGenres,
    topPeople,
    signatureTraits,
  };
}

function escapeCsvCell(value: string | number | null | undefined): string {
  const str = value == null ? '' : String(value);
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function parseCsvRows(csvText: string): string[][] {
  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentCell = '';
  let inQuotes = false;
  const text = String(csvText || '').replace(/^\uFEFF/, '');

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') {
        currentCell += '"';
        i += 1;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        currentCell += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      currentRow.push(currentCell.trim());
      currentCell = '';
    } else if (ch === '\r' && next === '\n') {
      currentRow.push(currentCell.trim());
      if (currentRow.some((cell) => cell.length > 0)) rows.push(currentRow);
      currentRow = [];
      currentCell = '';
      i += 1;
    } else if (ch === '\n' || ch === '\r') {
      currentRow.push(currentCell.trim());
      if (currentRow.some((cell) => cell.length > 0)) rows.push(currentRow);
      currentRow = [];
      currentCell = '';
    } else {
      currentCell += ch;
    }
  }

  currentRow.push(currentCell.trim());
  if (currentRow.some((cell) => cell.length > 0)) {
    rows.push(currentRow);
  }
  return rows;
}

/**
 * Exports profile items into Letterboxd / CineTrack compatible CSV format.
 */
export function exportItemsToCsv(items: SavedItem[]): string {
  const headers = [
    'Title',
    'Year',
    'Rating10',
    'WatchedDate',
    'Status',
    'MediaType',
    'tmdbID',
  ];
  const lines = [headers.join(',')];

  for (const item of items) {
    const title = item.title || item.name || 'İsimsiz';
    const rawDate = item.release_date || item.first_air_date || '';
    const year = rawDate.slice(0, 4);
    const rating10 = typeof item.personal_rating === 'number' && item.personal_rating > 0 ? item.personal_rating : '';
    const watchedDate = (item.updatedAt || item.addedAt || '').slice(0, 10);
    const tmdbId = typeof item.id === 'number' || /^\d+$/.test(String(item.id)) ? String(item.id) : '';
    lines.push(
      [
        escapeCsvCell(title),
        escapeCsvCell(year),
        escapeCsvCell(rating10),
        escapeCsvCell(watchedDate),
        escapeCsvCell(item.status),
        escapeCsvCell(item.media_type),
        escapeCsvCell(tmdbId),
      ].join(',')
    );
  }

  return lines.join('\r\n');
}

export interface CsvImportResult {
  importedItems: SavedItem[];
  skippedCount: number;
  detectedFormat: 'letterboxd' | 'imdb' | 'cinetrack' | 'generic';
}

function stableCustomIdFromTitle(title: string, year: string, mediaType: 'movie' | 'tv'): string {
  const slug = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_-]+/g, '-')
    .slice(0, 48);
  const safeSlug = slug || 'item';
  return `custom-csv-${mediaType}-${safeSlug}${year ? `-${year}` : ''}`;
}

/**
 * Parses Letterboxd, IMDb, or CineTrack CSV exports into valid SavedItem records.
 */
export function importItemsFromCsv(csvText: string): CsvImportResult {
  const rows = parseCsvRows(csvText);
  if (rows.length < 2) {
    return { importedItems: [], skippedCount: 0, detectedFormat: 'generic' };
  }

  const header = rows[0].map((col) => col.toLowerCase().trim());
  const findCol = (...candidates: string[]) => header.findIndex((h) => candidates.includes(h));

  const idxTitle = findCol('title', 'name', 'original title', 'film', 'başlık');
  const idxYear = findCol('year', 'yıl', 'release year');
  const idxRating10 = findCol('rating10', 'your rating', 'personal_rating', 'puan');
  const idxRating5 = findCol('rating');
  const idxDate = findCol('watcheddate', 'watched date', 'date rated', 'date', 'created');
  const idxStatus = findCol('status', 'durum');
  const idxType = findCol('mediatype', 'media_type', 'title type', 'type', 'tür');
  const idxTmdb = findCol('tmdbid', 'tmdb_id', 'tmdb');
  const idxImdbVote = findCol('imdb rating', 'vote_average');

  let detectedFormat: CsvImportResult['detectedFormat'] = 'generic';
  if (header.includes('tmdbid') && header.includes('rating10')) {
    detectedFormat = 'cinetrack';
  } else if (header.includes('const') || header.includes('your rating') || header.includes('title type')) {
    detectedFormat = 'imdb';
  } else if (header.includes('letterboxd uri') || (header.includes('name') && header.includes('watched date'))) {
    detectedFormat = 'letterboxd';
  }

  if (idxTitle === -1) {
    return { importedItems: [], skippedCount: rows.length - 1, detectedFormat };
  }

  const importedItems: SavedItem[] = [];
  const seenKeys = new Set<string>();
  let skippedCount = 0;

  for (let r = 1; r < rows.length; r += 1) {
    const row = rows[r];
    const rawTitle = (row[idxTitle] || '').trim();
    if (!rawTitle) {
      skippedCount += 1;
      continue;
    }

    const rawYear = idxYear >= 0 ? (row[idxYear] || '').trim().slice(0, 4) : '';
    const validYear = /^\d{4}$/.test(rawYear) ? rawYear : '';

    const rawType = idxType >= 0 ? (row[idxType] || '').toLowerCase().trim() : '';
    const mediaType: 'movie' | 'tv' =
      rawType.includes('tv') || rawType.includes('series') || rawType.includes('mini') || rawType === 'dizi'
        ? 'tv'
        : 'movie';

    let personalRating: number | '' = '';
    if (idxRating10 >= 0 && row[idxRating10]) {
      const parsed10 = Number(row[idxRating10]);
      if (Number.isFinite(parsed10) && parsed10 > 0) {
        personalRating = Math.min(10, Math.max(1, Math.round(parsed10)));
      }
    } else if (idxRating5 >= 0 && row[idxRating5]) {
      const parsed5 = Number(row[idxRating5]);
      if (Number.isFinite(parsed5) && parsed5 > 0) {
        // Letterboxd ratings are 0.5 - 5.0 stars -> scale to 1-10
        const scaled = parsed5 <= 5 ? Math.round(parsed5 * 2) : Math.round(parsed5);
        personalRating = Math.min(10, Math.max(1, scaled));
      }
    }

    const rawStatus = idxStatus >= 0 ? (row[idxStatus] || '').toLowerCase().trim() : '';
    let status: SavedItem['status'] = 'completed';
    if (rawStatus === 'watchlist' || rawStatus === 'izlenecek') {
      status = 'watchlist';
    } else if (rawStatus === 'watching' || rawStatus === 'izleniyor') {
      status = 'watching';
    } else if (detectedFormat === 'letterboxd' && idxDate === -1 && personalRating === '') {
      status = 'watchlist';
    }

    const rawTmdb = idxTmdb >= 0 ? (row[idxTmdb] || '').trim() : '';
    const numericTmdbId = /^\d+$/.test(rawTmdb) && Number(rawTmdb) > 0 ? Number(rawTmdb) : null;
    const id: number | string = numericTmdbId ?? stableCustomIdFromTitle(rawTitle, validYear, mediaType);

    const key = makeMediaKey(mediaType, id);
    if (seenKeys.has(key)) {
      skippedCount += 1;
      continue;
    }
    seenKeys.add(key);

    const rawWatchedDate = idxDate >= 0 ? (row[idxDate] || '').trim() : '';
    const isoDate = /^\d{4}-\d{2}-\d{2}/.test(rawWatchedDate)
      ? `${rawWatchedDate.slice(0, 10)}T12:00:00.000Z`
      : new Date().toISOString();

    const extVote = idxImdbVote >= 0 && Number.isFinite(Number(row[idxImdbVote])) ? Number(row[idxImdbVote]) : 0;

    const item: SavedItem = {
      id,
      media_type: mediaType,
      title: rawTitle,
      name: rawTitle,
      release_date: mediaType === 'movie' && validYear ? `${validYear}-01-01` : undefined,
      first_air_date: mediaType === 'tv' && validYear ? `${validYear}-01-01` : undefined,
      vote_average: extVote > 0 && extVote <= 10 ? extVote : 0,
      vote_count: 0,
      popularity: 10,
      genre_ids: [],
      status,
      personal_rating: personalRating,
      addedAt: isoDate,
      updatedAt: isoDate,
      custom: numericTmdbId === null,
    };

    importedItems.push(item);
  }

  return { importedItems, skippedCount, detectedFormat };
}

export interface CalendarReleaseEvent {
  uid: string;
  title: string;
  date: string; // YYYY-MM-DD
  mediaType: 'movie' | 'tv';
  subtitle: string;
  mediaId: number | string;
}

export function extractUpcomingReleaseEvents(
  items: SavedItem[],
  referenceDateIso = new Date().toISOString().slice(0, 10)
): CalendarReleaseEvent[] {
  const events: CalendarReleaseEvent[] = [];
  for (const item of items) {
    if (item.media_type === 'tv' && item.next_episode_to_air?.air_date) {
      const airDate = item.next_episode_to_air.air_date.slice(0, 10);
      if (/^\d{4}-\d{2}-\d{2}$/.test(airDate) && airDate >= referenceDateIso) {
        const sNum = item.next_episode_to_air.season_number;
        const eNum = item.next_episode_to_air.episode_number;
        events.push({
          uid: `cinetrack-tv-${item.id}-s${sNum}e${eNum}@cinetrack.local`,
          title: `${item.title || item.name} — S${String(sNum).padStart(2, '0')}E${String(eNum).padStart(2, '0')}`,
          date: airDate,
          mediaType: 'tv',
          subtitle: `${sNum}. Sezon ${eNum}. Bölüm Yayın Tarihi`,
          mediaId: item.id,
        });
      }
    } else if (item.media_type === 'movie' && item.release_date) {
      const relDate = item.release_date.slice(0, 10);
      if (/^\d{4}-\d{2}-\d{2}$/.test(relDate) && relDate >= referenceDateIso && item.status !== 'completed') {
        events.push({
          uid: `cinetrack-movie-${item.id}-${relDate}@cinetrack.local`,
          title: `${item.title || item.name} (Vizyon / Yayın)`,
          date: relDate,
          mediaType: 'movie',
          subtitle: 'İzleme Listesi Film Yayın Tarihi',
          mediaId: item.id,
        });
      }
    }
  }

  return events.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

function escapeIcsText(value: string): string {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

function addDaysCompact(yyyyMmDd: string, days: number): string {
  const [y, m, d] = yyyyMmDd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, (m || 1) - 1, (d || 1) + days));
  return dt.toISOString().slice(0, 10).replace(/-/g, '');
}

/**
 * Generates an RFC 5545 compliant .ics iCalendar feed for upcoming episodes and movies.
 */
export function generateIcsCalendar(events: CalendarReleaseEvent[], calendarName = 'CineTrack Yayın Takvimi'): string {
  const dtStamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//CineTrack//Release Calendar TR//TR',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeIcsText(calendarName)}`,
  ];

  for (const ev of events) {
    const dtStart = ev.date.replace(/-/g, '');
    const dtEnd = addDaysCompact(ev.date, 1);
    lines.push(
      'BEGIN:VEVENT',
      `UID:${escapeIcsText(ev.uid)}`,
      `DTSTAMP:${dtStamp}`,
      `DTSTART;VALUE=DATE:${dtStart}`,
      `DTEND;VALUE=DATE:${dtEnd}`,
      `SUMMARY:${escapeIcsText(ev.title)}`,
      `DESCRIPTION:${escapeIcsText(ev.subtitle)}`,
      'END:VEVENT'
    );
  }

  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}

export interface WatchlistOverlapResult {
  commonWatchlist: SavedItem[];
  unwatchedByEither: SavedItem[];
  recommendedByOneToOther: { item: SavedItem; recommenderName: string; rating: number }[];
}

/**
 * Computes deterministic intersection between two local profiles for joint watch nights ("Birlikte Ne İzlesek?").
 */
export function computeProfileWatchlistIntersection(profileA: Profile, profileB: Profile): WatchlistOverlapResult {
  const mapA = new Map<string, SavedItem>();
  const mapB = new Map<string, SavedItem>();

  for (const item of profileA.items || []) {
    mapA.set(makeMediaKey(item), item);
  }
  for (const item of profileB.items || []) {
    mapB.set(makeMediaKey(item), item);
  }

  const commonWatchlist: SavedItem[] = [];
  const unwatchedByEither: SavedItem[] = [];
  const recommendedByOneToOther: { item: SavedItem; recommenderName: string; rating: number }[] = [];

  for (const [key, itemA] of mapA.entries()) {
    const itemB = mapB.get(key);
    if (itemB) {
      if (itemA.status === 'watchlist' && itemB.status === 'watchlist') {
        commonWatchlist.push(itemA);
      }
      if (itemA.status !== 'completed' && itemB.status !== 'completed') {
        unwatchedByEither.push(itemA);
      }
      if (
        itemA.status === 'completed' &&
        typeof itemA.personal_rating === 'number' &&
        itemA.personal_rating >= 8 &&
        itemB.status === 'watchlist'
      ) {
        recommendedByOneToOther.push({
          item: itemA,
          recommenderName: profileA.name,
          rating: itemA.personal_rating,
        });
      }
      if (
        itemB.status === 'completed' &&
        typeof itemB.personal_rating === 'number' &&
        itemB.personal_rating >= 8 &&
        itemA.status === 'watchlist'
      ) {
        recommendedByOneToOther.push({
          item: itemB,
          recommenderName: profileB.name,
          rating: itemB.personal_rating,
        });
      }
    }
  }

  commonWatchlist.sort((a, b) => (b.vote_average || 0) - (a.vote_average || 0));
  unwatchedByEither.sort((a, b) => (b.vote_average || 0) - (a.vote_average || 0));
  recommendedByOneToOther.sort((a, b) => b.rating - a.rating);

  return {
    commonWatchlist,
    unwatchedByEither,
    recommendedByOneToOther,
  };
}

export interface JourneyTimelineMilestone {
  id: string;
  timestamp: string;
  mediaKey: string;
  title: string;
  mediaType: 'movie' | 'tv';
  kind: 'recommended' | 'added' | 'completed' | 'rated';
  detail: string;
}

/**
 * Builds a chronological "Film/Dizi Yolculuğu" timeline merging TasteMap impressions with library milestones.
 */
export function buildMediaJourneyTimeline(
  profile: Profile,
  tasteEntries: Record<string, any> = {},
  limit = 25
): JourneyTimelineMilestone[] {
  const milestones: JourneyTimelineMilestone[] = [];

  for (const item of profile.items || []) {
    const key = makeMediaKey(item);
    const title = item.title || item.name || key;
    const entry = tasteEntries[key];

    if (entry && Array.isArray(entry.impressionHistory) && entry.impressionHistory.length > 0) {
      const firstImp = entry.impressionHistory[0];
      const impTime = firstImp?.shownAt || firstImp?.timestamp || entry.firstShownAt;
      if (impTime) {
        milestones.push({
          id: `${key}-rec-${impTime}`,
          timestamp: impTime,
          mediaKey: key,
          title,
          mediaType: item.media_type,
          kind: 'recommended',
          detail: `Sana Özel akışında keşfedildi (Uyum: ${Math.round(firstImp?.matchScore || entry.tasteScore || entry.matchScore || 0)}/100)`,
        });
      }
    }

    if (item.addedAt) {
      milestones.push({
        id: `${key}-added-${item.addedAt}`,
        timestamp: item.addedAt,
        mediaKey: key,
        title,
        mediaType: item.media_type,
        kind: 'added',
        detail: 'Kütüphaneye eklendi',
      });
    }

    if (item.status === 'completed') {
      const ts = item.updatedAt || item.addedAt || new Date().toISOString();
      milestones.push({
        id: `${key}-done-${ts}`,
        timestamp: ts,
        mediaKey: key,
        title,
        mediaType: item.media_type,
        kind: 'completed',
        detail:
          typeof item.personal_rating === 'number' && item.personal_rating > 0
            ? `İzlendi ve ${item.personal_rating}/10 olarak puanlandı`
            : 'İzlendi olarak işaretlendi',
      });
    }
  }

  return milestones
    .filter((m) => Boolean(m.timestamp))
    .sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0))
    .slice(0, Math.max(1, limit));
}
