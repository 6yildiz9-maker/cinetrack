import { makeMediaKey, parseMediaKey } from './keys.ts';
import { findSaved } from './saved-index.ts';
import { bayesianRating, clamp01 } from './rating-math.ts';
import { matchesSelectedGenre } from './genre-matching.ts';
import type { FavoriteActorInfo } from './cinetrack-core.ts';

export interface ActorRecommendationSignalBreakdown {
  actorPresence: number; // 0-30 (temel + kadro sırası/rol puanı)
  actorRoleText: string; // örn: "1. Başrol (#1, +12)"
  multiActorBonus: number; // 0 veya 10
  genreScore: number; // 0-20
  tasteScore: number; // 0-15 (kullanıcı puanları 1-10 ve tür/oyuncu benzerliğinden)
  tasteExplanation: string; // kullanıcıya / geliştiriciye açıklama
  qualityScore: number; // 0-10 (Bayesyen TMDB puanı)
  recencyScore: number; // 0-5
  platformScore: number; // 0-10 (doğrulanmışsa 10/6/3, bilinmiyorsa 5 nötr)
  platformVerified: boolean;
  confidenceScore: number; // 0-100
  confidenceLevel: 'high' | 'medium' | 'low';
  rawTotal: number;
}

export interface ActorRecommendationItem {
  id: number;
  title: string;
  name?: string;
  media_type: 'movie' | 'tv';
  poster_path?: string | null;
  backdrop_path?: string | null;
  overview?: string;
  genre_ids: number[];
  release_date?: string;
  first_air_date?: string;
  vote_average: number;
  vote_count: number;
  popularity: number;
  character?: string;
  order?: number;
  matchedActors: Array<{
    id: number;
    name: string;
    character?: string;
    order?: number;
  }>;
  matchScore: number;
  confidenceScore: number;
  confidenceLevel: 'high' | 'medium' | 'low';
  reason: string;
  signalBreakdown: ActorRecommendationSignalBreakdown;
  [key: string]: any;
}

export interface ScoreActorRecommendationsOptions {
  favoriteActors: FavoriteActorInfo[];
  actorCreditsMap: Record<number | string, any[]>;
  savedItems?: any[];
  dislikedKeys?: string[];
  genresMap?: Record<number, string>;
  providerIndex?: Record<string, any[]>;
  preferredProviders?: string[];
  sortMode?: 'best_match' | 'newest' | 'hidden_gems';
  sortBy?: string;
  mediaTypeFilter?: 'all' | 'movie' | 'tv' | string;
  genreFilter?: string;
  enableDiversity?: boolean;
  maxPerGenre?: number;
  limit?: number;
  now?: number;
}

/**
 * Kadro sırasına (TMDB order) göre rol ağırlığı ve etiketi üretir.
 */
export function calculateActorRoleBonus(order?: number): { bonus: number; label: string } {
  if (order === 0) return { bonus: 12, label: '1. Başrol (#1)' };
  if (order === 1 || order === 2) return { bonus: 10, label: `Başrol (#${order + 1})` };
  if (order === 3 || order === 4) return { bonus: 7, label: `Ana Kadro (#${order + 1})` };
  if (typeof order === 'number' && order >= 5 && order <= 9) return { bonus: 4, label: `Yardımcı Rol (#${order + 1})` };
  if (typeof order === 'number' && order >= 10) return { bonus: 1, label: `Küçük Rol / Konuk (#${order + 1})` };
  return { bonus: 3, label: 'Kadroda' };
}

/**
 * Favori oyuncu önerilerinde aynı tür yığılmasını önlemek için çeşitlilik uygular.
 */
export function diversifyActorRecommendations(
  items: ActorRecommendationItem[],
  { maxPerGenre = 3, limit = 50 }: { maxPerGenre?: number; limit?: number } = {}
): ActorRecommendationItem[] {
  if (!Array.isArray(items) || items.length <= maxPerGenre) return items;

  const picked: ActorRecommendationItem[] = [];
  const deferred: ActorRecommendationItem[] = [];
  const genreCounts: Record<number, number> = {};

  for (const item of items) {
    const dominantGenre = item.genre_ids?.[0];
    if (dominantGenre != null) {
      const count = genreCounts[dominantGenre] || 0;
      if (count >= maxPerGenre) {
        deferred.push(item);
        continue;
      }
      genreCounts[dominantGenre] = count + 1;
    }
    picked.push(item);
    if (picked.length >= limit) break;
  }

  return [...picked, ...deferred].slice(0, limit);
}

export type ActorFetchStatusCode = 'idle' | 'loading' | 'success' | 'error' | 'empty';

export interface ActorFetchStatus {
  actorId: number;
  actorName: string;
  status: ActorFetchStatusCode;
  creditsCount: number;
  error?: string;
  updatedAt: number;
}

export interface FetchActorCreditsBatchOptions {
  concurrency?: number;
  signal?: AbortSignal;
  ticketId?: number;
  isCurrentTicket?: (ticketId: number) => boolean;
  force?: boolean;
  onActorStatusChange?: (status: ActorFetchStatus) => void;
  fetchTmdbFn?: (path: string, params?: Record<string, string>, signal?: AbortSignal, ttl?: number) => Promise<any>;
}

export interface FetchActorCreditsBatchResult {
  creditsMap: Record<number, any[]>;
  statuses: Record<number, ActorFetchStatus>;
  completedCount: number;
  errorCount: number;
  emptyCount: number;
}

// In-flight istek paylaşımı haritası: Aynı oyuncu için eşzamanlı istekleri tek Promise altında birleştirir
const inFlightActorCredits = new Map<number, Promise<{ cast: any[]; error?: string }>>();

export function getInFlightActorCreditsCount(): number {
  return inFlightActorCredits.size;
}

export function clearInFlightActorCredits(): void {
  inFlightActorCredits.clear();
}

/**
 * Favori oyuncuların filmografilerini (combined_credits) sınırlı kuyruk (bounded queue),
 * oyuncu bazında durum takibi, in-flight istek paylaşımı ve eski yanıt korumasıyla çeker.
 */
export async function fetchActorCreditsBatch(
  favoriteActors: FavoriteActorInfo[],
  options: FetchActorCreditsBatchOptions = {}
): Promise<FetchActorCreditsBatchResult> {
  const {
    concurrency = 3,
    signal,
    ticketId,
    isCurrentTicket,
    force = false,
    onActorStatusChange,
    fetchTmdbFn,
  } = options;

  const creditsMap: Record<number, any[]> = {};
  const statuses: Record<number, ActorFetchStatus> = {};
  let completedCount = 0;
  let errorCount = 0;
  let emptyCount = 0;

  if (!Array.isArray(favoriteActors) || favoriteActors.length === 0) {
    return { creditsMap, statuses, completedCount: 0, errorCount: 0, emptyCount: 0 };
  }

  // 1. Oyuncu bazında başlangıç durumlarını (loading) oluştur ve bildir
  const now = Date.now();
  for (const actor of favoriteActors) {
    if (!actor || !actor.id) continue;
    statuses[actor.id] = {
      actorId: actor.id,
      actorName: actor.name || `Oyuncu #${actor.id}`,
      status: 'loading',
      creditsCount: 0,
      updatedAt: now,
    };
    onActorStatusChange?.(statuses[actor.id]);
  }

  // Eski yanıtları engelleme kontrolü (Ticket Gate)
  if (ticketId != null && isCurrentTicket && !isCurrentTicket(ticketId)) {
    return { creditsMap, statuses, completedCount: 0, errorCount: 0, emptyCount: 0 };
  }

  // 2. Sınırlı Kuyruk (Bounded Concurrency Queue): Eşzamanlı istek sayısını sınırla (varsayılan: 3)
  const validActors = favoriteActors.filter((a) => a && a.id);
  const queueLimit = Math.max(1, Math.min(concurrency, 6));
  let cursor = 0;

  const worker = async () => {
    while (cursor < validActors.length) {
      if (signal?.aborted) break;
      if (ticketId != null && isCurrentTicket && !isCurrentTicket(ticketId)) break;

      const actor = validActors[cursor++];
      const actorId = actor.id;

      // 3. In-flight istek paylaşımı: Aynı oyuncu için halihazırda süren istek varsa mükerrer tetikleme
      let creditPromise = inFlightActorCredits.get(actorId);
      if (!creditPromise) {
        creditPromise = (async () => {
          let lastError: any = null;
          try {
            // Önce Türkçe ardından İngilizce yedek (Language fallback)
            let data: any = null;
            const fetcher = fetchTmdbFn || (async (p: string, params?: Record<string, string>) => {
              const res = await fetch(`/api/tmdb?path=${encodeURIComponent(p)}&${new URLSearchParams(params || {}).toString()}`);
              return res.json();
            });

            if (!force) {
              try {
                data = await fetcher(`/person/${actorId}/combined_credits`, { language: 'tr-TR' });
              } catch (e) {
                lastError = e;
              }
            }
            if (!data || !Array.isArray(data.cast) || data.cast.length === 0) {
              try {
                data = await fetcher(`/person/${actorId}/combined_credits`, { language: 'en-US' });
              } catch (e) {
                lastError = e;
              }
            }

            if (data && Array.isArray(data.cast)) {
              return { cast: data.cast };
            }
            if (lastError && (!data || !Array.isArray(data.cast))) {
              return { cast: [], error: lastError?.message || 'Bağlantı hatası' };
            }
            return { cast: [] };
          } catch (err: any) {
            return { cast: [], error: err?.message || 'Bağlantı hatası' };
          }
        })().finally(() => {
          inFlightActorCredits.delete(actorId);
        });

        inFlightActorCredits.set(actorId, creditPromise);
      }

      const res = await creditPromise;

      // 4. Eski yanıtları engelleme: Eğer yeni bir ticket başlatıldıysa veya iptal edildiyse sonucu yut
      if (ticketId != null && isCurrentTicket && !isCurrentTicket(ticketId)) {
        return;
      }
      if (signal?.aborted) {
        return;
      }

      // 5. Oyuncu bazında durum güncellemesi
      const cast = Array.isArray(res.cast) ? res.cast : [];
      creditsMap[actorId] = cast;

      let status: ActorFetchStatusCode = 'success';
      if (res.error) {
        status = 'error';
        errorCount++;
      } else if (cast.length === 0) {
        status = 'empty';
        emptyCount++;
      } else {
        status = 'success';
        completedCount++;
      }

      statuses[actorId] = {
        actorId,
        actorName: actor.name || `Oyuncu #${actorId}`,
        status,
        creditsCount: cast.length,
        error: res.error,
        updatedAt: Date.now(),
      };

      onActorStatusChange?.(statuses[actorId]);
    }
  };

  const runners = Array.from({ length: Math.min(queueLimit, validActors.length) }, () => worker());
  await Promise.all(runners);

  return { creditsMap, statuses, completedCount, errorCount, emptyCount };
}

export interface ActorChipDisplayState {
  state: 'loading' | 'pending' | 'error' | 'empty' | 'success';
  title: string;
  creditsCount: number;
}

export function describeActorFetchChipState(
  actor: Partial<FavoriteActorInfo> | null | undefined,
  status?: ActorFetchStatus | null,
  isBatchLoading = false
): ActorChipDisplayState {
  const actorName = String(actor?.name || 'Oyuncu').trim() || 'Oyuncu';
  if (!status) {
    if (isBatchLoading) {
      return {
        state: 'loading',
        title: `${actorName}: Kuyrukta yükleniyor...`,
        creditsCount: 0,
      };
    }
    return {
      state: 'pending',
      title: `${actorName}: Filmografi verisi hazırlanıyor...`,
      creditsCount: 0,
    };
  }

  if (status.status === 'loading') {
    return {
      state: 'loading',
      title: `${actorName}: Kuyrukta yükleniyor...`,
      creditsCount: 0,
    };
  }

  if (status.status === 'error') {
    return {
      state: 'error',
      title: `${actorName}: ${status.error || 'Hata'}`,
      creditsCount: 0,
    };
  }

  if (status.status === 'empty') {
    return {
      state: 'empty',
      title: `${actorName}: Filmografide uygun içerik bulunamadı`,
      creditsCount: 0,
    };
  }

  const count = Math.max(0, Number(status.creditsCount) || 0);
  return {
    state: 'success',
    title: `${actorName}: ${count} yapım yüklendi`,
    creditsCount: count,
  };
}

/**
 * Favori oyuncuların yer aldığı, kullanıcının henüz izlemediği / listesine eklemediği
 * yapımları bir havuzda toplayıp sinyal ağırlıklarına göre puanlar.
 */
export function scoreActorRecommendations(options: ScoreActorRecommendationsOptions): ActorRecommendationItem[] {
  const {
    favoriteActors = [],
    actorCreditsMap = {},
    savedItems = [],
    dislikedKeys = [],
    genresMap = {},
    providerIndex = {},
    preferredProviders = [],
    sortMode = 'best_match',
    sortBy,
    mediaTypeFilter = 'all',
    genreFilter = '',
    enableDiversity = true,
    maxPerGenre = 3,
    limit,
    now = Date.now(),
  } = options;

  if (!Array.isArray(favoriteActors) || favoriteActors.length === 0) {
    return [];
  }

  // 1. Kullanıcının sevdiği türleri analiz et
  const userGenreWeightMap: Record<number, number> = {};
  for (const item of savedItems) {
    if (!item) continue;
    let weight = 1;
    const rating = Number(item.personal_rating);
    if (Number.isFinite(rating) && rating >= 7) weight = 2.5;
    else if (item.status === 'completed') weight = 1.8;
    else if (item.status === 'watching') weight = 1.2;
    else if (item.status === 'disliked' || item.isDisliked) weight = -2;

    const gids: number[] = Array.isArray(item.genre_ids)
      ? item.genre_ids
      : Array.isArray(item.genres)
      ? item.genres.map((g: any) => g?.id).filter(Boolean)
      : [];
    for (const gid of gids) {
      userGenreWeightMap[gid] = (userGenreWeightMap[gid] || 0) + weight;
    }
  }

  const topGenreIds = Object.entries(userGenreWeightMap)
    .filter(([, val]) => val > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => Number(id));

  // 2. Kullanıcının gerçek puan sinyallerini topla (1-10)
  const userRatings = savedItems
    .map((it) => {
      const rating = Number(it.personal_rating);
      if (!Number.isFinite(rating) || rating < 1 || rating > 10) return null;
      const gids: number[] = Array.isArray(it.genre_ids)
        ? it.genre_ids
        : Array.isArray(it.genres)
        ? it.genres.map((g: any) => g?.id).filter(Boolean)
        : [];
      const actors: number[] = Array.isArray(it.cast)
        ? it.cast.map((c: any) => c?.id).filter(Boolean)
        : [];
      return { rating, genres: gids, actors, status: it.status };
    })
    .filter(Boolean) as Array<{ rating: number; genres: number[]; actors: number[]; status: string }>;

  // Disliked set
  const dislikedSet = new Set<string>();
  for (const k of dislikedKeys || []) {
    dislikedSet.add(k);
    const parsed = parseMediaKey(k);
    if (parsed) {
      dislikedSet.add(makeMediaKey(parsed.type, parsed.id));
      dislikedSet.add(`${parsed.type}-${parsed.id}`);
    }
  }

  // 3. Havuz oluştur: her oyuncunun combined_credits listesini birleştir
  const candidatesMap = new Map<string, any>();

  for (const actor of favoriteActors) {
    if (!actor || !actor.id) continue;
    const credits = actorCreditsMap[actor.id] || [];
    if (!Array.isArray(credits)) continue;

    for (const credit of credits) {
      if (!credit || !credit.id) continue;
      const mediaType: 'movie' | 'tv' = credit.media_type === 'tv' ? 'tv' : 'movie';
      if (
        (mediaTypeFilter === 'movie' || mediaTypeFilter === 'tv') &&
        mediaType !== mediaTypeFilter
      ) {
        continue;
      }
      if (genreFilter && !matchesSelectedGenre({ ...credit, media_type: mediaType }, genreFilter)) {
        continue;
      }
      const key = makeMediaKey(mediaType, credit.id);

      const title = String(credit.title || credit.name || '').trim();
      if (!title) continue;

      // Kullanıcının kayıtlı listesinde var mı?
      if (findSaved(savedItems, credit)) {
        continue;
      }

      // İlgilenilmeyenlerde var mı?
      if (dislikedSet.has(key) || dislikedSet.has(`${mediaType}-${credit.id}`)) {
        continue;
      }

      const actorEntry = {
        id: actor.id,
        name: actor.name,
        character: credit.character || '',
        order: typeof credit.order === 'number' ? credit.order : undefined,
      };

      if (candidatesMap.has(key)) {
        const existing = candidatesMap.get(key);
        if (!existing.matchedActors.some((a: any) => a.id === actor.id)) {
          existing.matchedActors.push(actorEntry);
        }
      } else {
        candidatesMap.set(key, {
          ...credit,
          id: credit.id,
          media_type: mediaType,
          title,
          matchedActors: [actorEntry],
        });
      }
    }
  }

  const currentYear = new Date(now).getFullYear();

  // 4. Her adayı sinyallere göre puanla
  const results: ActorRecommendationItem[] = [];

  for (const candidate of candidatesMap.values()) {
    const matchedCount = candidate.matchedActors.length;

    // Sinyal 1: Favori oyuncu varlığı ve TMDB kadro sırası / rol verisi (30 puan)
    // En iyi role sahip favori oyuncunun kadro sırasını baz al
    let bestRole = { bonus: 3, label: 'Kadroda' };
    for (const actor of candidate.matchedActors) {
      const r = calculateActorRoleBonus(actor.order);
      if (r.bonus > bestRole.bonus) {
        bestRole = r;
      }
    }
    const actorPresenceScore = 18 + bestRole.bonus; // 19 ile 30 puan arası
    const actorRoleText = bestRole.label;

    // Sinyal 2: Birden fazla favori oyuncu (+10 bonus)
    const multiActorBonus = matchedCount > 1 ? 10 : 0;

    // Sinyal 3: Kullanıcının sevdiği türlere uyum (20 puan)
    const cGenres: number[] = Array.isArray(candidate.genre_ids)
      ? candidate.genre_ids
      : Array.isArray(candidate.genres)
      ? candidate.genres.map((g: any) => g?.id).filter(Boolean)
      : [];

    let genreScore = 10;
    let matchedGenreName = '';
    if (topGenreIds.length > 0 && cGenres.length > 0) {
      const matchCount = cGenres.filter((gid) => topGenreIds.includes(gid)).length;
      if (matchCount > 0) {
        genreScore = Math.min(20, 12 + matchCount * 4);
        const topGid = cGenres.find((gid) => topGenreIds.includes(gid));
        if (topGid && genresMap[topGid]) {
          matchedGenreName = genresMap[topGid];
        }
      } else {
        genreScore = 6;
      }
    } else if (cGenres.length > 0 && genresMap[cGenres[0]]) {
      matchedGenreName = genresMap[cGenres[0]];
    }

    // Sinyal 4: tasteScore — Gerçek kullanıcı puanlarına (1-10) ve tür/oyuncu benzerliğine bağlı (15 puan)
    let tasteScore = 7.5;
    let tasteExplanation = 'Kullanıcı puan geçmişi dengeli kabul edildi';

    const matchingGenreRatings = userRatings
      .filter((r) => r.genres.some((gid) => cGenres.includes(gid)))
      .map((r) => r.rating);

    const matchedActorIds = new Set(candidate.matchedActors.map((a: any) => a.id));
    const matchingActorRatings = userRatings
      .filter((r) => r.actors.some((aid) => matchedActorIds.has(aid)))
      .map((r) => r.rating);

    if (matchingActorRatings.length > 0 || matchingGenreRatings.length > 0) {
      let avgRating = 7;
      if (matchingActorRatings.length > 0 && matchingGenreRatings.length > 0) {
        const actorAvg = matchingActorRatings.reduce((a, b) => a + b, 0) / matchingActorRatings.length;
        const genreAvg = matchingGenreRatings.reduce((a, b) => a + b, 0) / matchingGenreRatings.length;
        avgRating = actorAvg * 0.6 + genreAvg * 0.4;
        tasteExplanation = `Oyuncunun yer aldığı filmlere verdiğin puanlar (${actorAvg.toFixed(1)}/10) ve ${matchedGenreName || 'tür'} puanlarınla (${genreAvg.toFixed(1)}/10) hesaplandı`;
      } else if (matchingActorRatings.length > 0) {
        avgRating = matchingActorRatings.reduce((a, b) => a + b, 0) / matchingActorRatings.length;
        tasteExplanation = `Favori oyuncunun diğer yapımlarına verdiğin ortalama ${avgRating.toFixed(1)}/10 puanla hesaplandı`;
      } else {
        avgRating = matchingGenreRatings.reduce((a, b) => a + b, 0) / matchingGenreRatings.length;
        tasteExplanation = `${matchedGenreName || 'Bu tür'} yapımlara verdiğin ortalama ${avgRating.toFixed(1)}/10 kullanıcı puanıyla hesaplandı`;
      }

      const normalized = Math.max(0, Math.min(1, (avgRating - 1) / 9));
      tasteScore = Math.round(normalized * 15 * 10) / 10;
    } else if (userRatings.length > 0) {
      const globalAvg = userRatings.reduce((a, b) => a + b.rating, 0) / userRatings.length;
      const normalized = Math.max(0, Math.min(1, (globalAvg - 1) / 9));
      tasteScore = Math.round(normalized * 15 * 10) / 10;
      tasteExplanation = `Genel kullanıcı puan ortalaman (${globalAvg.toFixed(1)}/10) baz alındı`;
    } else if (savedItems.length > 0) {
      if (genreScore >= 16) {
        tasteScore = 13;
        tasteExplanation = 'İzleme listendeki tür yoğunluğuna göre yüksek ilgi tahmin edildi';
      } else if (genreScore <= 6) {
        tasteScore = 6;
        tasteExplanation = 'İzleme listendeki tür yoğunluğuyla kısmi eşleşme';
      } else {
        tasteScore = 9;
        tasteExplanation = 'İzleme listendeki yapımlara göre ortalama ilgi tahmin edildi';
      }
    }

    // Sinyal 5: Genel içerik kalitesi ve oy sayısı (10 puan)
    const vAvg = Number(candidate.vote_average) || 0;
    const vCnt = Number(candidate.vote_count) || 0;
    const bayes = bayesianRating(vAvg, vCnt, { prior: 6.5, minVotes: 200 });
    const qualityScore = Math.round(clamp01((bayes - 4.5) / 4.0) * 10 * 10) / 10;

    // Sinyal 6: Yenilik / güncellik (5 puan)
    const releaseDate = candidate.release_date || candidate.first_air_date || '';
    let recencyScore = 2;
    if (releaseDate) {
      const relYear = parseInt(releaseDate.substring(0, 4), 10);
      if (Number.isFinite(relYear)) {
        if (relYear >= currentYear) recencyScore = 5;
        else if (relYear >= currentYear - 2) recencyScore = 4;
        else if (relYear >= currentYear - 5) recencyScore = 3;
        else if (relYear >= currentYear - 10) recencyScore = 2;
        else recencyScore = 1;
      }
    }

    // Sinyal 7: İzleme platformu — Doğrulanmışsa puan ver, bilinmiyorsa nötr bırak (10 puan)
    const key = makeMediaKey(candidate);
    const rawProviders = candidate.watch_providers || candidate.providers || providerIndex?.[key] || null;

    let platformScore = 5; // Nötr başlangıç
    let platformVerified = false;

    if (rawProviders && Array.isArray(rawProviders) && rawProviders.length > 0) {
      platformVerified = true;
      const userPreferredSet = new Set((preferredProviders || []).map(String));
      const candidateProviderIds = rawProviders.map((p: any) => String(p?.id || p?.provider_id));

      if (userPreferredSet.size > 0) {
        const hasPreferred = candidateProviderIds.some((id) => userPreferredSet.has(id));
        if (hasPreferred) {
          platformScore = 10; // Tercih edilen platformda mevcut
        } else {
          platformScore = 6; // Başka bir platformda izlenebilir
        }
      } else {
        platformScore = 8; // Platform tercihi belirtilmemiş ama akışta doğrulandı
      }
    } else if (rawProviders && Array.isArray(rawProviders) && rawProviders.length === 0) {
      platformVerified = true;
      platformScore = 3; // Doğrulandı fakat akışta yok (satın al / kirala)
    } else {
      // Platform verisi bilinmiyor/doğrulanmamış -> NÖTR bırak
      platformVerified = false;
      platformScore = 5;
    }

    // Gerçek toplam ham puan (0-100)
    const rawTotal = Math.round(
      (actorPresenceScore +
        multiActorBonus +
        genreScore +
        tasteScore +
        qualityScore +
        recencyScore +
        platformScore) * 10
    ) / 10;

    const matchScore = Math.min(99, Math.max(1, Math.round(rawTotal)));

    // Güven Düzeyi hesaplaması (0-100)
    const ratingsCount = userRatings.length;
    const ratingsConfidence = ratingsCount >= 5 ? 1.0 : ratingsCount >= 1 ? 0.65 : 0.3;
    const voteCountConfidence = vCnt >= 1000 ? 1.0 : vCnt >= 200 ? 0.8 : vCnt >= 30 ? 0.55 : 0.3;
    const roleConfidence =
      typeof candidate.order === 'number' && candidate.order <= 5
        ? 1.0
        : typeof candidate.order === 'number'
        ? 0.75
        : 0.45;
    const platformConfidence = platformVerified ? 1.0 : 0.5;

    const confidenceScore = Math.round(
      (ratingsConfidence * 0.35 +
        voteCountConfidence * 0.30 +
        roleConfidence * 0.20 +
        platformConfidence * 0.15) * 100
    );

    let confidenceLevel: 'high' | 'medium' | 'low' = 'low';
    if (confidenceScore >= 70) confidenceLevel = 'high';
    else if (confidenceScore >= 45) confidenceLevel = 'medium';

    // Gerekçe metni
    let reason = '';
    if (matchedCount > 1) {
      const names = candidate.matchedActors.map((a: any) => a.name).join(' ve ');
      if (matchedGenreName) {
        reason = `Favori oyuncuların ${names} kadroda ve sevdiğin ${matchedGenreName} türüyle uyuşuyor.`;
      } else {
        reason = `Birden fazla favori oyuncun (${names}) bu yapımda bir araya geliyor.`;
      }
    } else {
      const singleActor = candidate.matchedActors[0];
      const isLead = typeof singleActor.order === 'number' && singleActor.order <= 2;
      const roleText = isLead ? 'başrolde' : 'kadroda';
      if (matchedGenreName) {
        reason = `Favori oyuncun ${singleActor.name} ${roleText} ve ${matchedGenreName} tür tercihlerinle eşleşiyor.`;
      } else if (vAvg >= 7.5) {
        reason = `Favori oyuncun ${singleActor.name} ${roleText} ve yapım yüksek izleyici puanına (%${Math.round(vAvg * 10)}) sahip.`;
      } else {
        reason = `Favori oyuncun ${singleActor.name} ${roleText} yer alıyor.`;
      }
    }

    const signalBreakdown: ActorRecommendationSignalBreakdown = {
      actorPresence: actorPresenceScore,
      actorRoleText,
      multiActorBonus,
      genreScore,
      tasteScore,
      tasteExplanation,
      qualityScore,
      recencyScore,
      platformScore,
      platformVerified,
      confidenceScore,
      confidenceLevel,
      rawTotal,
    };

    results.push({
      ...candidate,
      matchScore,
      confidenceScore,
      confidenceLevel,
      reason,
      signalBreakdown,
    });
  }

  // 5. Sıralama Modları
  const effectiveSort = sortBy || sortMode;
  if (effectiveSort === 'rating') {
    results.sort((a, b) => {
      const diff = (Number(b.vote_average) || 0) - (Number(a.vote_average) || 0);
      return diff !== 0 ? diff : b.matchScore - a.matchScore;
    });
  } else if (effectiveSort === 'title') {
    results.sort((a, b) => (a.title || '').localeCompare(b.title || '', 'tr'));
  } else if (effectiveSort === 'recent' || effectiveSort === 'newest') {
    results.sort((a, b) => {
      const dateA = a.release_date || a.first_air_date || '';
      const dateB = b.release_date || b.first_air_date || '';
      if (!dateA && !dateB) return b.matchScore - a.matchScore;
      if (!dateA) return 1;
      if (!dateB) return -1;
      const cmp = dateB.localeCompare(dateA);
      return cmp !== 0 ? cmp : b.matchScore - a.matchScore;
    });
  } else if (effectiveSort === 'gems' || effectiveSort === 'hidden_gems') {
    // Gizli Cevherler: Yüksek izleyici puanına (vote_average >= 7) sahip fakat ana akım aşırı popüler olmayan yapımlar
    results.sort((a, b) => {
      const bayesA = bayesianRating(a.vote_average, a.vote_count, { prior: 6.5, minVotes: 50 });
      const bayesB = bayesianRating(b.vote_average, b.vote_count, { prior: 6.5, minVotes: 50 });
      if (Math.abs(bayesB - bayesA) > 0.4) {
        return bayesB - bayesA;
      }
      return b.matchScore - a.matchScore;
    });
  } else {
    // 'best_match' / 'popular' (en güçlü eşleşmeler)
    results.sort((a, b) => {
      if (b.matchScore !== a.matchScore) {
        return b.matchScore - a.matchScore;
      }
      return (b.popularity || 0) - (a.popularity || 0);
    });

    // Tür çeşitliliği uygula (belirli bir tür filtresi seçilmediğinde)
    if (enableDiversity && !genreFilter) {
      const effectiveLimit = limit ?? Math.max(50, favoriteActors.length * 10);
      return diversifyActorRecommendations(results, { maxPerGenre, limit: effectiveLimit });
    }
  }

  return typeof limit === 'number' && limit > 0 ? results.slice(0, limit) : results;
}
