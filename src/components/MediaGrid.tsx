import React, { useMemo, useState } from 'react';
import { MediaCard } from './MediaCard';
import { ActorRecommendationsSection } from './ActorRecommendationsSection';
import { SeriesRecommendationsSection } from './SeriesRecommendationsSection';
import { SeasonCalendarSection } from './SeasonCalendarSection';
import { ErrorBoundary } from './ErrorBoundary';
import {
  SavedItem,
  FavoriteActorInfo,
  findSavedItem,
  makeMediaKey,
  normalizeFavoriteActors,
} from '../core/cinetrack-core';
import { imageUrl, handleImageError } from '../utils/helpers';
import { TmdbItem } from '../types/tmdb';

interface MediaGridProps {
  title: string;
  description: string;
  isLoading: boolean;
  loadingMore: boolean;
  items: TmdbItem[];
  savedItems: SavedItem[];
  genres: Record<number, string>;
  recommendationReasons: Map<string, string>;
  dislikedKeys: string[];
  preferredProviders?: string[];
  providerIndex?: Record<string, Array<{ id: number | string; name?: string }>>;
  tab: 'discover' | 'list';
  query: string;
  listStatus: string;
  category: string;
  page: number;
  totalPages: number;
  hasMore: boolean;
  favoriteActors?: FavoriteActorInfo[];
  onLoadMore: () => void;
  onOpenDetails: (item: TmdbItem) => void;
  onQuickAdd: (item: TmdbItem) => void;
  onSetStatus: (item: TmdbItem, status: 'watching' | 'watchlist' | 'completed') => void;
  onQuickSave: (item: TmdbItem) => void;
  onToggleDislike: (key: string) => void;
  onEmptyAction: (action: string) => void;
  onOpenPerson?: (id: number, name: string) => void;
  onToggleFavoriteActor?: (actor: FavoriteActorInfo) => void;
  onRefreshForYou?: () => void;
  forYouProgressStep?: string;
  tmdbSource?: string;
  tmdbStaleReason?: string;
  selectedType?: string;
  onTypeChange?: (t: string) => void;
  selectedGenre?: string;
  onGenreChange?: (g: string) => void;
  selectedSort?: string;
  onSortChange?: (s: string) => void;
  forYouSubTab?: 'recommendations' | 'series';
  onForYouSubTabChange?: (sub: 'recommendations' | 'series') => void;
  seriesCount?: number;
  hiddenKeys?: string[];
  mood?: string;
  isDemo?: boolean;
}

export const MediaGrid: React.FC<MediaGridProps> = ({
  title,
  description,
  isLoading,
  loadingMore,
  items,
  savedItems,
  genres,
  recommendationReasons,
  dislikedKeys,
  preferredProviders = [],
  providerIndex = {},
  tab,
  query,
  listStatus,
  category,
  page,
  totalPages,
  hasMore,
  favoriteActors = [],
  onLoadMore,
  onOpenDetails,
  onQuickAdd,
  onSetStatus,
  onQuickSave,
  onToggleDislike,
  onEmptyAction,
  onOpenPerson,
  onToggleFavoriteActor,
  onRefreshForYou,
  forYouProgressStep,
  tmdbSource = 'live',
  tmdbStaleReason,
  selectedType = 'all',
  onTypeChange,
  selectedGenre = '',
  onGenreChange,
  selectedSort = 'popular',
  onSortChange,
  forYouSubTab = 'recommendations',
  onForYouSubTabChange,
  seriesCount = 0,
  hiddenKeys = [],
  mood = '',
  isDemo = false,
}) => {
  const [actorsSubTab, setActorsSubTab] = useState<'actors' | 'recommendations'>('actors');
  const getSaved = (item: TmdbItem) => findSavedItem(savedItems, item);
  const safeFavoriteActors = useMemo(
    () => normalizeFavoriteActors(favoriteActors),
    [favoriteActors]
  );
  const isActorsListMode = tab === 'list' && listStatus === 'actors';
  const isForYouSeriesMode = tab === 'discover' && category === 'for-you' && !query.trim() && forYouSubTab === 'series';

  return (
    <section aria-labelledby="catalogTitle">
      <div className="section-head">
        <div>
          <h2 id="catalogTitle" tabIndex={-1}>
            {title}
          </h2>
          <p id="catalogDescription">{description}</p>
        </div>
        <div className="section-head-actions">
          {tab === 'discover' && category === 'for-you' && !isForYouSeriesMode && onRefreshForYou && (
            <button
              type="button"
              className="for-you-head-refresh-btn"
              disabled={isLoading}
              onClick={onRefreshForYou}
              title="Önerileri manuel olarak güncelle"
            >
              <span className={`refresh-icon ${isLoading ? 'spinning' : ''}`} aria-hidden="true">↻</span>{' '}
              <span>{isLoading ? 'Hesaplanıyor...' : 'Önerileri Güncelle'}</span>
            </button>
          )}
          <div className={`loading ${isLoading || loadingMore ? 'visible' : ''}`} aria-live="polite">
            <span className="spinner"></span>
            <span>
              {tmdbSource === 'demo'
                ? 'Örnek katalog yükleniyor...'
                : tmdbSource === 'stale-cache'
                ? 'Önbellek verisi yükleniyor...'
                : 'Canlı veri yükleniyor...'}
            </span>
          </div>
        </div>
      </div>

      {tab === 'discover' && tmdbSource === 'stale-cache' && (
        <div className="catalog-source-banner banner-stale" role="status">
          <span className="catalog-source-banner-icon">⚠️</span>
          <div>
            <strong>Eski Önbellek Modu:</strong> TMDB canlı servisine anlık ulaşılamadığı için ekrandaki yapımlar ve öneriler son kaydedilen önbellek verisinden sunuluyor.
            {tmdbStaleReason ? ` (${tmdbStaleReason})` : ''}
          </div>
        </div>
      )}

      {tab === 'discover' && tmdbSource === 'demo' && (
        <div className="catalog-source-banner banner-demo" role="status">
          <span className="catalog-source-banner-icon">🟡</span>
          <div>
            <strong>Örnek Katalog Modu:</strong> TMDB_API_KEY tanımlanmadığından içerikler CineTrack örnek katalog verisiyle sunulmaktadır.
          </div>
        </div>
      )}

      {tab === 'discover' && category === 'for-you' && !isForYouSeriesMode && isLoading && forYouProgressStep && (
        <div className="progress-step-banner" role="status" aria-live="polite">
          <span>{forYouProgressStep}</span>
        </div>
      )}

      {tab === 'discover' && category === 'for-you' && !query.trim() && onForYouSubTabChange && (
        <div className="actors-subtabs-bar for-you-subtabs-bar" role="tablist" aria-label="Sana Özel alt sekmeleri">
          <button
            type="button"
            role="tab"
            aria-selected={forYouSubTab === 'recommendations'}
            className={`actors-subtab-btn ${forYouSubTab === 'recommendations' ? 'is-active' : ''}`}
            onClick={() => onForYouSubTabChange('recommendations')}
          >
            <span>Öneriler</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={forYouSubTab === 'series'}
            className={`actors-subtab-btn ${forYouSubTab === 'series' ? 'is-active' : ''}`}
            onClick={() => onForYouSubTabChange('series')}
          >
            <span>Seriler</span>{' '}
            <strong className="actors-subtab-count tabular-nums">{seriesCount}</strong>
          </button>
        </div>
      )}

      {tab === 'list' && (listStatus === 'all' || listStatus === 'watching' || listStatus === 'watchlist') && (
        <SeasonCalendarSection
          savedItems={savedItems}
          onSelectMedia={(id, mediaType) =>
            onOpenDetails({ id: Number(id) || (id as any), media_type: mediaType } as TmdbItem)
          }
        />
      )}

      {isActorsListMode && (
        <div className="actors-subtabs-bar" role="tablist" aria-label="Favori oyuncular görünümü">
          <button
            type="button"
            role="tab"
            aria-selected={actorsSubTab === 'actors'}
            className={`actors-subtab-btn ${actorsSubTab === 'actors' ? 'is-active' : ''}`}
            onClick={() => setActorsSubTab('actors')}
          >
            <span>Oyuncular</span>{' '}
            <strong className="actors-subtab-count tabular-nums">{safeFavoriteActors.length}</strong>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={actorsSubTab === 'recommendations'}
            className={`actors-subtab-btn ${actorsSubTab === 'recommendations' ? 'is-active' : ''}`}
            onClick={() => setActorsSubTab('recommendations')}
          >
            <span>Öneriler</span>
          </button>
        </div>
      )}

      {isActorsListMode && actorsSubTab === 'recommendations' ? (
        <div className="actors-recommendations-panel">
          <div className="secondary-toolbar actors-recommendations-toolbar">
            <div className="segmented-control" role="group" aria-label="İçerik türü filtresi">
              <button
                type="button"
                className={`segmented-btn ${selectedType === 'all' ? 'active' : ''}`}
                onClick={() => onTypeChange?.('all')}
              >
                Tümü
              </button>
              <button
                type="button"
                className={`segmented-btn ${selectedType === 'movie' ? 'active' : ''}`}
                onClick={() => onTypeChange?.('movie')}
              >
                Film
              </button>
              <button
                type="button"
                className={`segmented-btn ${selectedType === 'tv' ? 'active' : ''}`}
                onClick={() => onTypeChange?.('tv')}
              >
                Dizi
              </button>
            </div>

            <div className="filter-select-wrap">
              <select
                className="filter-select"
                value={selectedGenre}
                onChange={(e) => onGenreChange?.(e.target.value)}
                aria-label="Tür filtresi"
              >
                <option value="">Tüm Türler</option>
                {Object.entries(genres).map(([id, name]) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ))}
              </select>
            </div>

            <div className="filter-select-wrap">
              <select
                className="filter-select"
                value={selectedSort}
                onChange={(e) => onSortChange?.(e.target.value)}
                aria-label="Sıralama ölçütü"
              >
                <option value="popular">Uyum Puanı (Varsayılan)</option>
                <option value="rating">Puan (Yüksekten Düşüğe)</option>
                <option value="recent">Yayın Tarihi (Yeni)</option>
                <option value="gems">Gizli Cevherler</option>
                <option value="title">Başlık (A-Z)</option>
              </select>
            </div>
          </div>

          {safeFavoriteActors.length === 0 ? (
            <div className="empty-message">
              <strong>Öneri oluşturmak için henüz favori oyuncu yok</strong>
              Film ve dizi detaylarındaki oyuncu fotoğraflarının üzerindeki kalp butonuna basarak favori oyuncularınızı ekleyebilirsiniz.
              <div className="message-actions">
                <button
                  className="btn"
                  type="button"
                  onClick={() => onEmptyAction('discover')}
                >
                  Keşfet&apos;e git
                </button>
              </div>
            </div>
          ) : (
            <ErrorBoundary sectionName="Favori Oyuncu Önerileri">
              <ActorRecommendationsSection
                favoriteActors={safeFavoriteActors}
                savedItems={savedItems}
                dislikedKeys={dislikedKeys}
                genresMap={genres}
                preferredProviders={preferredProviders}
                providerIndex={providerIndex}
                selectedType={selectedType}
                selectedGenre={selectedGenre}
                selectedSort={selectedSort}
                onOpenDetails={onOpenDetails}
                onQuickAdd={onQuickAdd}
                onSetStatus={onSetStatus}
                onQuickSave={onQuickSave}
                onOpenPerson={onOpenPerson}
              />
            </ErrorBoundary>
          )}
        </div>
      ) : isForYouSeriesMode ? (
        <ErrorBoundary sectionName="Seri ve Evren Önerileri">
          <SeriesRecommendationsSection
            savedItems={savedItems}
            dislikedKeys={dislikedKeys}
            hiddenKeys={hiddenKeys}
            genresMap={genres}
            mood={mood}
            selectedType={selectedType}
            selectedGenre={selectedGenre}
            selectedSort={selectedSort}
            isDemo={isDemo}
            tmdbSource={tmdbSource}
            onOpenDetails={onOpenDetails}
            onQuickAdd={onQuickAdd}
            onSetStatus={onSetStatus}
            onQuickSave={onQuickSave}
            onToggleDislike={onToggleDislike}
            onEmptyAction={onEmptyAction}
            onBackToRecommendations={
              onForYouSubTabChange ? () => onForYouSubTabChange('recommendations') : undefined
            }
          />
        </ErrorBoundary>
      ) : (
      <div id="catalogGrid" className="grid">
        {isLoading ? (
          Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="skeleton-card" aria-hidden="true"></div>
          ))
        ) : tab === 'list' && listStatus === 'actors' ? (
          safeFavoriteActors.length === 0 ? (
            <div className="empty-message">
              <strong>Henüz favori oyuncu eklemediniz</strong>
              Film ve dizi detaylarındaki oyuncu fotoğraflarının üzerindeki kalp butonuna basarak oyuncuları favorilere ekleyebilirsiniz.
              <div className="message-actions">
                <button
                  className="btn"
                  type="button"
                  onClick={() => onEmptyAction('discover')}
                >
                  Keşfet&apos;e git
                </button>
              </div>
            </div>
          ) : (
            safeFavoriteActors.map((actor) => {
              const photo = imageUrl(actor.profile_path, 'w185');
              return (
                <article key={actor.id} className="card actor-card">
                  <div
                    className="poster actor-poster"
                    role="button"
                    tabIndex={0}
                    aria-label={`${actor.name} filmografisini gör`}
                    onClick={() => onOpenPerson?.(actor.id, actor.name)}
                    onKeyDown={(e) => {
                      if (e.target !== e.currentTarget) return;
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        onOpenPerson?.(actor.id, actor.name);
                      }
                    }}
                  >
                    {photo ? (
                      <img
                        src={photo}
                        alt={actor.name}
                        loading="lazy"
                        decoding="async"
                        referrerPolicy="no-referrer"
                        onError={(e) => handleImageError(e, photo, 'w185')}
                      />
                    ) : (
                      <div className="poster-fallback">
                        <svg className="icon">
                          <use href="#icon-user"></use>
                        </svg>
                      </div>
                    )}
                    <button
                      type="button"
                      className="actor-fav-badge is-active"
                      title="Favorilerden çıkar"
                      aria-label={`${actor.name} favorilerden çıkar`}
                      onClick={(e) => {
                        e.stopPropagation();
                        onToggleFavoriteActor?.(actor);
                      }}
                    >
                      ♥
                    </button>
                  </div>
                  <div className="card-info">
                    <button
                      className="card-title clamp-2"
                      type="button"
                      onClick={() => onOpenPerson?.(actor.id, actor.name)}
                      title={actor.name}
                    >
                      {actor.name}
                    </button>
                    <div className="card-meta">
                      <span className="kind-tag clamp-1">Oyuncu</span>
                      {actor.character && (
                        <>
                          {' '}
                          <span className="card-meta-sep" aria-hidden="true">·</span>{' '}
                          <span className="actor-card-character clamp-1">{actor.character}</span>
                        </>
                      )}
                    </div>
                    <div className="actor-card-cta-wrap">
                      <button
                        type="button"
                        className="btn actor-card-cta-btn"
                        onClick={() => onOpenPerson?.(actor.id, actor.name)}
                      >
                        Filmleri & Dizileri Gör
                      </button>
                    </div>
                  </div>
                </article>
              );
            })
          )
        ) : items.length === 0 ? (
          <div className="empty-message">
            {query.trim() ? (
              <>
                <strong>Sonuç bulunamadı</strong>
                Arama terimini değiştirebilir veya aramayı temizleyerek trendlere dönebilirsiniz.
                <div className="message-actions">
                  <button
                    className="btn"
                    type="button"
                    onClick={() => onEmptyAction('clear-search')}
                  >
                    Aramayı temizle
                  </button>
                </div>
              </>
            ) : isForYouSeriesMode ? (
              <>
                <strong>
                  {selectedType !== 'all' || selectedGenre
                    ? 'Seçili filtreye uygun eksik seri parçası bulunamadı'
                    : 'Listenizdeki serilere ait eksik yapım bulunmuyor'}
                </strong>
                {selectedType !== 'all' || selectedGenre
                  ? 'Tür veya Film/Dizi filtresini sıfırlayarak listenizdeki serilerin diğer tüm parçalarını görebilirsiniz.'
                  : 'İzlediğiniz veya listenize eklediğiniz film ve dizilerin devam halkaları ya da yan yapımları bulunduğunda burada otomatik listelenir.'}
                <div className="message-actions">
                  {(selectedType !== 'all' || selectedGenre) && (
                    <button
                      className="btn btn-primary"
                      type="button"
                      onClick={() => onEmptyAction('clear-filters')}
                    >
                      Filtreleri temizle
                    </button>
                  )}
                  <button
                    className="btn"
                    type="button"
                    onClick={() => onForYouSubTabChange?.('recommendations')}
                  >
                    Önerilere dön
                  </button>
                </div>
              </>
            ) : tab === 'discover' && category === 'for-you' ? (
              <>
                <strong>Öneri oluşturmak için yeterli veri yok</strong>
                Listene birkaç film veya dizi ekleyip puan verirsen zevkine özel öneriler burada görünecektir.
                <div className="message-actions">
                  {onRefreshForYou && (
                    <button
                      className="btn btn-primary"
                      type="button"
                      onClick={onRefreshForYou}
                    >
                      Önerileri Hesapla
                    </button>
                  )}
                  <button
                    className="btn"
                    type="button"
                    onClick={() => onEmptyAction('trending')}
                  >
                    Gündemde olanlara dön
                  </button>
                </div>
              </>
            ) : tab === 'discover' ? (
              <>
                <strong>Bu filtrelerle sonuç bulunamadı</strong>
                Seçili tür veya &ldquo;Listemdekileri Gizle&rdquo; filtresi bu kategorideki içerikleri gizliyor olabilir.
                <div className="message-actions">
                  <button
                    className="btn"
                    type="button"
                    onClick={() => onEmptyAction('clear-filters')}
                  >
                    Filtreleri temizle
                  </button>
                  {category !== 'trending' && (
                    <button
                      className="btn"
                      type="button"
                      onClick={() => onEmptyAction('trending')}
                    >
                      Gündemde olanlara dön
                    </button>
                  )}
                </div>
              </>
            ) : listStatus === 'disliked' ? (
              <>
                <strong>İlgilenmiyorum listeniz boş</strong>
                Önerilerden gizlemek istediğiniz içeriklerin posterindeki 👎 butonuna basarak bu listeye ekleyebilirsiniz.
                <div className="message-actions">
                  <button
                    className="btn"
                    type="button"
                    onClick={() => onEmptyAction('all-items')}
                  >
                    Tüm kayıtları göster
                  </button>
                </div>
              </>
            ) : listStatus !== 'all' ? (
              <>
                <strong>Bu durumda içerik yok</strong>
                Tüm kayıtlarını görerek listendeki diğer içeriklere ulaşabilirsin.
                <div className="message-actions">
                  <button
                    className="btn"
                    type="button"
                    onClick={() => onEmptyAction('all-items')}
                  >
                    Tüm kayıtları göster
                  </button>
                </div>
              </>
            ) : (
              <>
                <strong>Listen henüz boş</strong>
                Keşfet sekmesinden içerik bulabilir veya kendin ekleyebilirsin.
                <div className="message-actions">
                  <button
                    className="btn"
                    type="button"
                    onClick={() => onEmptyAction('discover')}
                  >
                    Keşfet'e git
                  </button>
                </div>
              </>
            )}
          </div>
        ) : (
          items.map((item) => {
            const itemKey = makeMediaKey(item.media_type, item.id);
            const legacyKey = `${item.media_type}-${item.id}`;
            const reason = recommendationReasons.get(itemKey) || recommendationReasons.get(legacyKey);
            const isDisliked = dislikedKeys.includes(itemKey) || dislikedKeys.includes(legacyKey);
            const saved = getSaved(item);

            return (
              <MediaCard
                key={itemKey}
                item={item}
                savedItem={saved}
                genres={genres}
                recommendationReason={reason}
                isDisliked={isDisliked}
                tab={tab}
                showMatch={tab === 'discover' && Boolean(item.tasteScore ?? item.matchScore)}
                matchScore={item.tasteScore ?? item.matchScore}
                showRing={tab === 'discover' && category === 'for-you' && !isForYouSeriesMode}
                selectionRing={item.lifecycleRing || item.ring}
                onOpenDetails={onOpenDetails}
                onQuickAdd={onQuickAdd}
                onSetStatus={onSetStatus}
                onQuickSave={onQuickSave}
                onToggleDislike={onToggleDislike}
              />
            );
          })
        )}
      </div>
      )}

      {tab === 'discover' && category === 'for-you' && !isForYouSeriesMode && items.length > 0 && onRefreshForYou && (
        <div className="for-you-refresh-wrap">
          <div className="for-you-refresh-hint">
            <span>💡 Listenize eklediğiniz veya izlediğiniz yeni yapımlara göre önerileri tazelemek için:</span>
          </div>
          <button
            type="button"
            className="for-you-refresh-btn"
            disabled={isLoading}
            onClick={onRefreshForYou}
            title="Önerileri manuel olarak güncelle"
          >
            <span className={`refresh-icon ${isLoading ? 'spinning' : ''}`} aria-hidden="true">↻</span>{' '}
            <span>{isLoading ? 'Öneriler Hesaplanıyor...' : 'Listeyi Güncelle'}</span>
          </button>
        </div>
      )}

      {tab === 'discover' && category !== 'for-you' && totalPages > 1 && (
        <div id="loadMoreWrap">
          <span id="loadMoreStatus" aria-live="polite">
            {loadingMore
              ? `${Math.min(page + 1, totalPages)}. sayfa yükleniyor / ${totalPages}`
              : `${page}. sayfa / ${totalPages}`}
          </span>
          {hasMore && (
            <button
              id="loadMoreButton"
              className="btn"
              type="button"
              disabled={loadingMore}
              onClick={onLoadMore}
            >
              Daha fazla göster
            </button>
          )}
        </div>
      )}
    </section>
  );
};
