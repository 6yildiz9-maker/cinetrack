import React from 'react';
import { MediaCard } from './MediaCard';
import { ActorRecommendationsSection } from './ActorRecommendationsSection';
import { SavedItem, findSavedItem, makeMediaKey } from '../core/cinetrack-core';
import { imageUrl } from '../utils/helpers';

interface MediaGridProps {
  title: string;
  description: string;
  isLoading: boolean;
  loadingMore: boolean;
  items: any[];
  savedItems: SavedItem[];
  genres: Record<number, string>;
  recommendationReasons: Map<string, string>;
  dislikedKeys: string[];
  tab: 'discover' | 'list';
  query: string;
  listStatus: string;
  category: string;
  page: number;
  totalPages: number;
  hasMore: boolean;
  favoriteActors?: any[];
  onLoadMore: () => void;
  onOpenDetails: (item: any) => void;
  onQuickAdd: (item: any) => void;
  onSetStatus: (item: any, status: 'watching' | 'watchlist' | 'completed') => void;
  onQuickSave: (item: any) => void;
  onToggleDislike: (key: string) => void;
  onEmptyAction: (action: string) => void;
  onOpenPerson?: (id: number, name: string) => void;
  onToggleFavoriteActor?: (actor: any) => void;
  onRefreshForYou?: () => void;
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
}) => {
  const getSaved = (item: any) => findSavedItem(savedItems, item);

  return (
    <section aria-labelledby="catalogTitle">
      <div className="section-head">
        <div>
          <h2 id="catalogTitle" tabIndex={-1}>
            {title}
          </h2>
          <p id="catalogDescription">{description}</p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          {tab === 'discover' && category === 'for-you' && onRefreshForYou && (
            <button
              type="button"
              className="for-you-head-refresh-btn"
              disabled={isLoading}
              onClick={onRefreshForYou}
              title="Önerileri manuel olarak güncelle"
            >
              <span className={`refresh-icon ${isLoading ? 'spinning' : ''}`}>🔄</span>
              <span>{isLoading ? 'Hesaplanıyor...' : 'Önerileri Güncelle'}</span>
            </button>
          )}
          <div className={`loading ${isLoading || loadingMore ? 'visible' : ''}`} aria-live="polite">
            <span className="spinner"></span>
            <span>Canlı veri yükleniyor...</span>
          </div>
        </div>
      </div>

      <div id="catalogGrid" className="grid">
        {isLoading ? (
          Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="skeleton-card" aria-hidden="true"></div>
          ))
        ) : listStatus === 'actors' ? (
          favoriteActors.length === 0 ? (
            <div className="empty-message">
              <strong>Henüz favori oyuncu eklemediniz</strong>
              Film ve dizi detaylarındaki oyuncu fotoğraflarının üzerindeki kalp butonuna basarak oyuncuları favorilere ekleyebilirsiniz.
              <div className="message-actions">
                <button
                  className="btn"
                  type="button"
                  onClick={() => onEmptyAction('discover')}
                >
                  Keşfet'e git
                </button>
              </div>
            </div>
          ) : (
            favoriteActors.map((actor) => {
              const photo = imageUrl(actor.profile_path, 'w185');
              return (
                <article key={actor.id} className="card actor-card">
                  <div
                    className="poster actor-poster"
                    role="button"
                    tabIndex={0}
                    onClick={() => onOpenPerson?.(actor.id, actor.name)}
                  >
                    {photo ? (
                      <img src={photo} alt={actor.name} loading="lazy" />
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
                      ❤️
                    </button>
                  </div>
                  <div className="card-info">
                    <button
                      className="card-title"
                      type="button"
                      onClick={() => onOpenPerson?.(actor.id, actor.name)}
                    >
                      {actor.name}
                    </button>
                    <div className="card-meta">
                      <span className="kind-tag">Oyuncu</span>
                      {actor.character && (
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {actor.character}
                        </span>
                      )}
                    </div>
                    <div style={{ marginTop: '8px' }}>
                      <button
                        type="button"
                        className="btn"
                        style={{ width: '100%', fontSize: '11px', padding: '6px 8px' }}
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
            ) : tab === 'discover' && category === 'for-you' ? (
              <>
                <strong>Öneri oluşturmak için yeterli veri yok</strong>
                Listene birkaç film veya dizi ekleyip puan verirsen zevkine özel öneriler burada görünecektir.
                <div className="message-actions">
                  {onRefreshForYou && (
                    <button
                      className="btn"
                      type="button"
                      style={{ background: 'linear-gradient(135deg, #f43f5e, #e11d48)', color: '#fff', border: '1px solid #fb718588' }}
                      onClick={onRefreshForYou}
                    >
                      🔄 Önerileri Hesapla
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
            ) : tab === 'discover' && category !== 'trending' ? (
              <>
                <strong>Bu filtrelerle sonuç yok</strong>
                Seçili tür filtresi bu kategorideki içerikleri gizliyor olabilir.
                <div className="message-actions">
                  <button
                    className="btn"
                    type="button"
                    onClick={() => onEmptyAction('clear-filters')}
                  >
                    Filtreleri temizle
                  </button>
                </div>
              </>
            ) : tab === 'discover' ? (
              <>
                <strong>Bu kategoride içerik bulunamadı</strong>
                Başka bir kategoriye geçebilir veya katalogda arama yapabilirsiniz.
                <div className="message-actions">
                  <button
                    className="btn"
                    type="button"
                    onClick={() => onEmptyAction('trending')}
                  >
                    Gündemde olanlara dön
                  </button>
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

      {listStatus === 'actors' && favoriteActors.length > 0 && (
        <ActorRecommendationsSection
          favoriteActors={favoriteActors}
          savedItems={savedItems}
          dislikedKeys={dislikedKeys}
          genresMap={genres}
          onOpenDetails={onOpenDetails}
          onQuickAdd={onQuickAdd}
          onSetStatus={onSetStatus}
          onQuickSave={onQuickSave}
          onOpenPerson={onOpenPerson}
        />
      )}

      {tab === 'discover' && category === 'for-you' && items.length > 0 && onRefreshForYou && (
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
            <span className={`refresh-icon ${isLoading ? 'spinning' : ''}`}>🔄</span>
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
