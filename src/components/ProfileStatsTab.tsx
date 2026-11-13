import React, { useMemo, useState } from 'react';
import type { Profile, SavedItem } from '../core/cinetrack-core.ts';
import {
  enrichSavedItemsFromCinemaKunye,
  type CinemaKunyeDocument,
} from '../core/cinema-kunye.ts';
import {
  buildMediaJourneyTimeline,
  buildTasteDnaProfile,
  computeProfileWatchlistIntersection,
} from '../core/exporters.ts';
import { calculateItemWatchMinutes, getTvShowEpisodesCount } from '../utils/helpers.ts';
// Zevk paneli ağır bir modül: yalnızca istatistik sekmesi görünür olduğunda yüklensin.
const TasteProfileDashboard = React.lazy(() => import('./taste/TasteProfileDashboard.tsx'));
import { ColumnChart } from './charts/ColumnChart.tsx';
import {
  buildRatingHistogramColumns,
  buildReleaseDecadeColumns,
} from './charts/profile-chart-data.ts';

interface ProfileStatsTabProps {
  effectiveActiveProfile: Profile;
  otherProfiles: Profile[];
  savedItems: SavedItem[];
  genresMap: Record<number, string>;
  tasteEntries: Record<string, unknown>;
  cinemaKunye?: CinemaKunyeDocument | null;
}

function formatMinutes(totalMinutes: number): {
  primary: string;
  secondary: string;
  days: number;
  hours: number;
  mins: number;
} {
  if (totalMinutes <= 0) {
    return { primary: '0 sa', secondary: '0 dakika', days: 0, hours: 0, mins: 0 };
  }
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const mins = totalMinutes % 60;

  const primary = days > 0 ? `${days}g ${hours}sa ${mins}dk` : `${hours} sa ${mins} dk`;
  const totalHours = Math.round((totalMinutes / 60) * 10) / 10;
  const secondary = `Toplam ${totalHours} saat (${totalMinutes.toLocaleString('tr-TR')} dakika)`;
  return { primary, secondary, days, hours, mins };
}

function watchedItemsCount(items: SavedItem[], type: 'all' | 'movie' | 'tv'): number {
  return items.filter((item) => {
    if (type !== 'all' && item.media_type !== type) return false;
    return (
      item.status === 'completed' ||
      item.status === 'watching' ||
      Number(item.personal_rating) >= 1
    );
  }).length;
}

export const ProfileStatsTab: React.FC<ProfileStatsTabProps> = ({
  effectiveActiveProfile,
  otherProfiles,
  savedItems,
  genresMap,
  tasteEntries,
  cinemaKunye,
}) => {
  const [genreMediaTypeFilter, setGenreMediaTypeFilter] = useState<'all' | 'movie' | 'tv'>('all');
  const [compareProfileId, setCompareProfileId] = useState<string>(
    () => otherProfiles[0]?.id || ''
  );

  const enrichedSavedItems = useMemo(
    () => enrichSavedItemsFromCinemaKunye(savedItems, cinemaKunye),
    [savedItems, cinemaKunye]
  );

  const tasteDna = useMemo(
    () => buildTasteDnaProfile(effectiveActiveProfile, genresMap, cinemaKunye),
    [effectiveActiveProfile, genresMap, cinemaKunye]
  );

  const journeyTimeline = useMemo(
    () =>
      buildMediaJourneyTimeline(
        effectiveActiveProfile,
        tasteEntries as Record<string, { score?: number; updatedAt?: string }>,
        15
      ),
    [effectiveActiveProfile, tasteEntries]
  );

  const compareProfile = useMemo(
    () => otherProfiles.find((p) => p.id === compareProfileId) || otherProfiles[0] || null,
    [otherProfiles, compareProfileId]
  );

  const watchlistOverlap = useMemo(() => {
    if (!compareProfile) return null;
    return computeProfileWatchlistIntersection(effectiveActiveProfile, compareProfile);
  }, [effectiveActiveProfile, compareProfile]);

  const movies = savedItems.filter((i) => i.media_type === 'movie');
  const tvShows = savedItems.filter((i) => i.media_type === 'tv');

  const completedMovies = movies.filter((m) => m.status === 'completed');
  const watchingMovies = movies.filter((m) => m.status === 'watching');
  const watchlistMovies = movies.filter((m) => m.status === 'watchlist');

  const completedTvs = tvShows.filter((t) => t.status === 'completed');
  const watchingTvs = tvShows.filter((t) => t.status === 'watching');
  const watchlistTvs = tvShows.filter((t) => t.status === 'watchlist');

  let movieMinutes = 0;
  for (const m of movies) {
    movieMinutes += calculateItemWatchMinutes(m);
  }

  let tvMinutes = 0;
  let totalEpisodesWatched = 0;
  for (const t of tvShows) {
    tvMinutes += calculateItemWatchMinutes(t);
    totalEpisodesWatched += getTvShowEpisodesCount(t);
  }

  const overallMinutes = movieMinutes + tvMinutes;
  const movieTimeFmt = formatMinutes(movieMinutes);
  const tvTimeFmt = formatMinutes(tvMinutes);
  const overallTimeFmt = formatMinutes(overallMinutes);

  const movieTimePercent =
    overallMinutes > 0 ? Math.round((movieMinutes / overallMinutes) * 100) : 50;
  const tvTimePercent = overallMinutes > 0 ? 100 - movieTimePercent : 50;

  const watchedForGenres = enrichedSavedItems.filter((item) => {
    if (genreMediaTypeFilter !== 'all' && item.media_type !== genreMediaTypeFilter) return false;
    return (
      item.status === 'completed' ||
      item.status === 'watching' ||
      Number(item.personal_rating) >= 1
    );
  });

  const genreCounts: Record<string, { name: string; count: number }> = {};
  let totalGenreHits = 0;

  for (const item of watchedForGenres) {
    for (const gid of item.genre_ids || []) {
      const gName = genresMap[gid];
      if (gName) {
        if (!genreCounts[gid]) {
          genreCounts[gid] = { name: gName, count: 0 };
        }
        genreCounts[gid].count += 1;
        totalGenreHits += 1;
      }
    }
  }

  const sortedGenres = Object.values(genreCounts).sort((a, b) => b.count - a.count);
  const topGenre = sortedGenres[0] || null;

  const ratedItems = savedItems.filter(
    (item) => Number.isFinite(Number(item.personal_rating)) && item.personal_rating !== ''
  );
  const averageRating = ratedItems.length
    ? (
        ratedItems.reduce((sum, item) => sum + Number(item.personal_rating), 0) /
        ratedItems.length
      ).toFixed(1)
    : null;

  const ratingColumns = useMemo(() => buildRatingHistogramColumns(savedItems), [savedItems]);
  const decadeColumns = useMemo(() => buildReleaseDecadeColumns(savedItems), [savedItems]);

  const completedCount = completedMovies.length + completedTvs.length;
  const watchlistCount = watchlistMovies.length + watchlistTvs.length;
  const targetTotal = watchlistCount + completedCount;
  const completionRate = targetTotal > 0 ? Math.round((completedCount / targetTotal) * 100) : 0;

  return (
    <div className="profile-stats-card tabular-nums">
      {/* Overall Total Time Highlight Card */}
      <div className="profile-stat-box highlight">
        <div className="stat-icon-wrap">
          <svg className="icon" aria-hidden="true">
            <use href="#icon-clock"></use>
          </svg>
          <span>Genel Toplam İzleme Süresi</span>
        </div>
        <div className="stat-big-val">{overallTimeFmt.primary}</div>
        <div className="stat-sub">{overallTimeFmt.secondary}</div>

        {overallMinutes > 0 && (
          <div className="profile-ratio-wrap">
            <div className="profile-ratio-labels">
              <span>Filmler (%{movieTimePercent})</span>
              <span>Diziler (%{tvTimePercent})</span>
            </div>
            <svg
              className="profile-ratio-svg"
              viewBox="0 0 100 7"
              preserveAspectRatio="none"
              aria-hidden="true"
            >
              <rect
                className="profile-ratio-movie"
                x="0"
                y="0"
                width={movieTimePercent}
                height="7"
              />
              <rect
                className="profile-ratio-tv"
                x={movieTimePercent}
                y="0"
                width={tvTimePercent}
                height="7"
              />
            </svg>
          </div>
        )}
      </div>

      {/* Movie & TV Separate Time Breakdown Grid */}
      <div className="profile-stats-grid">
        <div className="profile-stat-box">
          <div className="stat-icon-wrap stat-tone-sky">
            <svg className="icon" aria-hidden="true">
              <use href="#icon-film"></use>
            </svg>
            <span>Film İzleme Süresi</span>
          </div>
          <div className="stat-big-val">{movieTimeFmt.primary}</div>
          <div className="stat-sub">
            <strong>{completedMovies.length} film</strong> izlendi
            {watchingMovies.length > 0 ? ` · ${watchingMovies.length} izleniyor` : ''}
            {watchlistMovies.length > 0 ? ` · ${watchlistMovies.length} beklemede` : ''}
          </div>
          <div className="profile-stat-footnote">{movieTimeFmt.secondary}</div>
        </div>

        <div className="profile-stat-box">
          <div className="stat-icon-wrap stat-tone-rose">
            <svg className="icon" aria-hidden="true">
              <use href="#icon-play"></use>
            </svg>
            <span>Dizi İzleme Süresi</span>
          </div>
          <div className="stat-big-val">{tvTimeFmt.primary}</div>
          <div className="stat-sub">
            <strong>{totalEpisodesWatched} bölüm</strong> izlendi
            {completedTvs.length > 0 ? ` · ${completedTvs.length} bitti` : ''}
            {watchingTvs.length > 0 ? ` · ${watchingTvs.length} izleniyor` : ''}
          </div>
          <div className="profile-stat-footnote">{tvTimeFmt.secondary}</div>
        </div>
      </div>

      {/* Rating & Completion Highlights */}
      <div className="profile-stats-grid">
        <div className="profile-stat-box">
          <div className="stat-icon-wrap stat-tone-amber">
            <svg className="icon" aria-hidden="true">
              <use href="#icon-star"></use>
            </svg>
            <span>Kişisel Puan Ortalaması</span>
          </div>
          <div className="stat-big-val stat-tone-amber">
            {averageRating ? `${averageRating} / 10` : 'Puan Yok'}
          </div>
          <div className="stat-sub">
            {ratedItems.length > 0
              ? `${ratedItems.length} yapım değerlendirildi`
              : 'Henüz puan verilmedi'}
          </div>
        </div>

        <div className="profile-stat-box">
          <div className="stat-icon-wrap stat-tone-emerald">
            <svg className="icon" aria-hidden="true">
              <use href="#icon-check"></use>
            </svg>
            <span>İzleme Listesi Tamamlama</span>
          </div>
          <div className="stat-big-val stat-tone-emerald">%{completionRate}</div>
          <div className="stat-sub">
            {targetTotal > 0
              ? `${completedCount} tamamlandı / ${targetTotal} hedef (İzlenecek + İzlenen)`
              : 'Henüz izleme listesi oluşturulmadı'}
          </div>
          <div className="profile-stat-footnote">Yalnızca İzlenecekler ve İzlenenler oranı</div>
        </div>
      </div>

      {/* Puan Histogramı + Yayın Onyılı Dağılımı */}
      <div className="profile-stats-grid">
        <div className="profile-stat-box">
          <div className="stat-icon-wrap stat-tone-amber">
            <svg className="icon" aria-hidden="true">
              <use href="#icon-star"></use>
            </svg>
            <span>Kişisel Puan Dağılımı</span>
          </div>
          {ratedItems.length > 0 ? (
            <ColumnChart
              points={ratingColumns}
              tone="gold"
              ariaLabel="Kişisel puan dağılımı (1-10)"
            />
          ) : (
            <p className="profile-stat-footnote">
              Puan verdikçe 1-10 aralığındaki dağılımınız burada oluşur.
            </p>
          )}
        </div>

        <div className="profile-stat-box">
          <div className="stat-icon-wrap">
            <svg className="icon" aria-hidden="true">
              <use href="#icon-calendar"></use>
            </svg>
            <span>Yayın Onyılı Dağılımı</span>
          </div>
          {decadeColumns.length > 0 ? (
            <ColumnChart
              points={decadeColumns}
              tone="accent"
              ariaLabel="Kütüphanenin yayın onyıllarına göre dağılımı"
            />
          ) : (
            <p className="profile-stat-footnote">
              Yayın yılı olan en az üç onyıl birikince dağılım görünür.
            </p>
          )}
        </div>
      </div>

      {/* Genre / Category Distribution Card */}
      <div className="genre-dist-card">
        <div className="genre-dist-header">
          <h4 className="genre-dist-heading">İzlenen Kategori Dağılımı</h4>
          {topGenre && <span className="top-genre-badge">En Çok İzlenen: {topGenre.name}</span>}
        </div>

        <div className="genre-filter-row">
          <button
            type="button"
            className={`profile-genre-filter-btn whitespace-nowrap ${
              genreMediaTypeFilter === 'all' ? 'is-active' : ''
            }`}
            onClick={() => setGenreMediaTypeFilter('all')}
          >
            Tümü ({watchedItemsCount(savedItems, 'all')})
          </button>
          <button
            type="button"
            className={`profile-genre-filter-btn whitespace-nowrap ${
              genreMediaTypeFilter === 'movie' ? 'is-active' : ''
            }`}
            onClick={() => setGenreMediaTypeFilter('movie')}
          >
            Filmler ({watchedItemsCount(savedItems, 'movie')})
          </button>
          <button
            type="button"
            className={`profile-genre-filter-btn whitespace-nowrap ${
              genreMediaTypeFilter === 'tv' ? 'is-active' : ''
            }`}
            onClick={() => setGenreMediaTypeFilter('tv')}
          >
            Diziler ({watchedItemsCount(savedItems, 'tv')})
          </button>
        </div>

        {sortedGenres.length === 0 ? (
          <p className="provider-message">
            Henüz seçilen filtreye uygun izlenmiş veya tamamlanmış içerik bulunmuyor.
          </p>
        ) : (
          <div className="genre-bars">
            {sortedGenres.slice(0, 8).map((g, index) => {
              const percent =
                totalGenreHits > 0 ? Math.round((g.count / totalGenreHits) * 100) : 0;
              const rankTone =
                index === 0
                  ? 'rank-1'
                  : index === 1
                    ? 'rank-2'
                    : index === 2
                      ? 'rank-3'
                      : 'rank-rest';

              return (
                <div key={g.name} className="genre-bar-item">
                  <span className="genre-bar-name" title={g.name}>
                    {index === 0 ? '1. ' : ''}
                    {g.name}
                  </span>
                  <svg
                    className="genre-bar-svg"
                    viewBox="0 0 100 8"
                    preserveAspectRatio="none"
                    aria-hidden="true"
                  >
                    <rect className="genre-bar-svg-track" x="0" y="0" width="100" height="8" rx="4" />
                    <rect
                      className={`genre-bar-svg-fill ${rankTone}`}
                      x="0"
                      y="0"
                      width={Math.max(2, percent)}
                      height="8"
                      rx="4"
                    />
                  </svg>
                  <span className="genre-bar-count">
                    %{percent} <span className="genre-bar-raw">({g.count})</span>
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Sinema Kimliğim — Algoritmik Zevk Takımyıldızı (Derin Sinema) */}
      <div className="profile-tools-section">
        <React.Suspense
          fallback={
            <div className="lazy-tab-fallback" role="status">
              Zevk profili yükleniyor…
            </div>
          }
        >
          <TasteProfileDashboard compact />
        </React.Suspense>
      </div>

      {/* Zevk DNA Özeti */}
      <div className="profile-tools-section">
        <h4 className="profile-tools-heading">
          <svg className="icon" width="16" height="16" aria-hidden="true">
            <use href="#icon-dna"></use>
          </svg>
          <span>Zevk DNA Özeti</span>
        </h4>
        <div className="dna-traits-grid">
          {tasteDna.signatureTraits.map((trait) => (
            <div key={trait.label} className="dna-trait-item">
              <span className="dna-trait-label">{trait.label}</span>
              <span className="dna-trait-value">{trait.value}</span>
              <span className="dna-trait-detail">{trait.detail}</span>
            </div>
          ))}
        </div>
        {tasteDna.topGenres.length > 0 && (
          <p className="dna-inline-meta">
            <strong>Baskın Türler:</strong>{' '}
            {tasteDna.topGenres.map((g) => `${g.name} (%${g.sharePercent})`).join(' · ')}
          </p>
        )}
        {tasteDna.topPeople.length > 0 && (
          <p className="dna-inline-meta">
            <strong>Öne Çıkan İsimler:</strong>{' '}
            {tasteDna.topPeople.map((p) => `${p.name} (${p.role})`).join(' · ')}
          </p>
        )}
      </div>

      {/* Birlikte Ne İzlesek? */}
      {otherProfiles.length > 0 && (
        <div className="profile-tools-section">
          <h4 className="profile-tools-heading">Birlikte Ne İzlesek? (Profil Kesişimi)</h4>
          <div className="overlap-select-row">
            <label htmlFor="compareProfileSelect" className="provider-message">
              Karşılaştırılacak profil:
            </label>
            <select
              id="compareProfileSelect"
              value={compareProfile?.id || ''}
              onChange={(e) => setCompareProfileId(e.target.value)}
            >
              {otherProfiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          {watchlistOverlap &&
          (watchlistOverlap.commonWatchlist.length > 0 ||
            watchlistOverlap.recommendedByOneToOther.length > 0) ? (
            <div className="overlap-results-list">
              {watchlistOverlap.commonWatchlist.map((item) => (
                <div key={`common-${item.media_type}:${item.id}`} className="overlap-row">
                  <span>{item.title || item.name}</span>
                  <span className="journey-date">Ortak İzlenecek Listesi</span>
                </div>
              ))}
              {watchlistOverlap.recommendedByOneToOther.map((rec) => (
                <div key={`rec-${rec.item.media_type}:${rec.item.id}`} className="overlap-row">
                  <span>{rec.item.title || rec.item.name}</span>
                  <span className="journey-date">
                    {rec.recommenderName} önerisi ({rec.rating}/10)
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="provider-message">
              Seçili profil ile henüz ortak izlenecek yapım bulunmuyor.
            </p>
          )}
        </div>
      )}

      {/* İzleme Yolculuğu Zaman Çizelgesi */}
      <div className="profile-tools-section">
        <h4 className="profile-tools-heading">İzleme Yolculuğu Zaman Çizelgesi</h4>
        {journeyTimeline.length === 0 ? (
          <p className="provider-message">
            Kütüphaneye yapım ekledikçe ve tamamladıkça kronolojik yolculuğunuz burada listelenir.
          </p>
        ) : (
          <div className="journey-timeline-list">
            {journeyTimeline.map((m) => (
              <div key={m.id} className="journey-row">
                <div>
                  <strong>{m.title}</strong>
                  <span className="provider-message"> · {m.detail}</span>
                </div>
                <span className="journey-date">{m.timestamp.slice(0, 10)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
