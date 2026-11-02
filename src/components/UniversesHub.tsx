import React, { useEffect, useMemo, useState } from 'react';
import {
  Compass,
  GitBranch,
  Layers,
  Orbit,
  Users,
} from 'lucide-react';
import type {
  FavoriteActorInfo,
  PoolCandidateItem,
  Preferences,
  SavedItem,
} from '../core/cinetrack-core.ts';
import {
  isCandidateEligibleInPool,
  makeMediaKey,
} from '../core/cinetrack-core.ts';
import type { TmdbItem } from '../types/tmdb.ts';
import { TAXONOMY_V01 } from '../core/taste/taxonomy.ts';
import {
  getCategoryDisplayLabel,
  getMetricDisplayTitle,
  resolveEffectiveMetricView,
} from '../core/taste/metric-labels.ts';
import { useTasteProfile } from '../hooks/useTasteProfile.ts';
import { loadStockIdb } from '../services/storage-idb.ts';
import { SeriesRecommendationsSection } from './SeriesRecommendationsSection.tsx';
import { ActorRecommendationsSection } from './ActorRecommendationsSection.tsx';
import { RelationshipExplorer } from './RelationshipExplorer.tsx';
import { MediaCard } from './MediaCard.tsx';
import { GlassCard } from './ui/GlassCard.tsx';

export type UniverseSubTab = 'franchises' | 'people' | 'network' | 'blind-spots';

export interface UniversesHubProps {
  profileId: string;
  savedItems: SavedItem[];
  preferences: Preferences;
  favoriteActors: FavoriteActorInfo[];
  genresMap: Record<number, string>;
  selectedType: string;
  selectedGenre: string;
  selectedSort: string;
  isDemo: boolean;
  tmdbSource: string;
  initialSourceKey?: string;
  onRefreshRelationships: (mediaFilter: 'all' | 'movie' | 'tv') => Promise<PoolCandidateItem[]>;
  onOpenDetails: (item: TmdbItem | SavedItem | PoolCandidateItem) => void;
  onQuickAdd: (item: TmdbItem) => void;
  onSetStatus: (item: TmdbItem, status: 'watching' | 'watchlist' | 'completed') => void;
  onQuickSave: (item: TmdbItem | SavedItem | PoolCandidateItem) => void;
  onToggleDislike: (key: string) => void;
  onOpenPerson: (id: number, name: string) => void;
  onOpenWhyModal?: (item: TmdbItem) => void;
  onEmptyAction: (action: string) => void;
}

interface BlindSpotSuggestion {
  id: string;
  headline: string;
  rationale: string;
  items: TmdbItem[];
}

const ASIAN_LANG_SET = new Set(['ja', 'ko', 'zh', 'cn', 'th', 'hi']);
const EURO_LANG_SET = new Set(['fr', 'de', 'es', 'it', 'sv', 'da', 'no', 'pl', 'nl']);

export const UniversesHub: React.FC<UniversesHubProps> = ({
  profileId,
  savedItems,
  preferences,
  favoriteActors,
  genresMap,
  selectedType,
  selectedGenre,
  selectedSort,
  isDemo,
  tmdbSource,
  initialSourceKey,
  onRefreshRelationships,
  onOpenDetails,
  onQuickAdd,
  onSetStatus,
  onQuickSave,
  onToggleDislike,
  onOpenPerson,
  onOpenWhyModal,
  onEmptyAction,
}) => {
  const [subTab, setSubTab] = useState<UniverseSubTab>(() =>
    initialSourceKey ? 'network' : 'franchises'
  );
  const [graphMode, setGraphMode] = useState<'relationships' | 'taste-map'>('relationships');
  const [stockItems, setStockItems] = useState<TmdbItem[]>([]);
  const { profile } = useTasteProfile();

  useEffect(() => {
    if (initialSourceKey) {
      setSubTab('network');
      setGraphMode('relationships');
    }
  }, [initialSourceKey]);

  useEffect(() => {
    let active = true;
    void loadStockIdb().then((stock) => {
      if (!active) return;
      const merged: TmdbItem[] = [
        ...(stock.movies || []).map((m) => ({ ...m, media_type: 'movie' as const })),
        ...(stock.tv || []).map((t) => ({ ...t, media_type: 'tv' as const })),
      ];
      setStockItems(merged);
    });
    return () => {
      active = false;
    };
  }, [savedItems.length]);

  // Kütüphanedeki en sık karşılaşılan yönetmen ve oyuncular (Oyuncu/Yönetmen Ağı özeti)
  const topCollaborators = useMemo(() => {
    const counts = new Map<number, { id: number; name: string; role: string; count: number }>();
    for (const item of savedItems) {
      const raw = item as unknown as {
        cast?: Array<{ id?: number; name?: string }>;
        crew?: Array<{ id?: number; name?: string; job?: string }>;
      };
      for (const c of (raw.crew || []).slice(0, 6)) {
        if (c?.id && c.name && (c.job === 'Director' || c.job === 'Creator')) {
          const prev = counts.get(c.id);
          counts.set(c.id, {
            id: c.id,
            name: c.name,
            role: 'Yönetmen',
            count: (prev?.count || 0) + 1,
          });
        }
      }
      for (const a of (raw.cast || []).slice(0, 5)) {
        if (a?.id && a.name) {
          const prev = counts.get(a.id);
          counts.set(a.id, {
            id: a.id,
            name: a.name,
            role: prev?.role === 'Yönetmen' ? 'Yönetmen / Oyuncu' : 'Oyuncu',
            count: (prev?.count || 0) + 1,
          });
        }
      }
    }
    return Array.from(counts.values())
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);
  }, [savedItems]);

  // Kavram İlişkileri (Zevk Ağı — parentId ve semanticGroup kümeleri)
  const conceptClusters = useMemo(() => {
    const groups = new Map<
      string,
      Array<{ id: string; title: string; category: string; affinity: number }>
    >();
    for (const def of TAXONOMY_V01) {
      if (!def.scoringEnabled || !def.semanticGroup) continue;
      const view = resolveEffectiveMetricView(profile?.metrics?.[def.id]);
      if (view.effectiveStatus === 'unknown' && !view.hasOverride) continue;
      const list = groups.get(def.semanticGroup) ?? [];
      list.push({
        id: def.id,
        title: getMetricDisplayTitle(def.id),
        category: getCategoryDisplayLabel(def.categoryId),
        affinity: view.effectiveAffinity,
      });
      groups.set(def.semanticGroup, list);
    }
    return Array.from(groups.entries())
      .filter(([, list]) => list.length >= 2)
      .slice(0, 6);
  }, [profile]);

  // Keşif Alanları (Blind Spots) — Güçlü zevk metrikleriyle uyumlu ama az denenmiş alt evrenler
  const blindSpots = useMemo<BlindSpotSuggestion[]>(() => {
    const savedKeys = new Set(savedItems.map((s) => makeMediaKey(s.media_type, s.id)));
    const eligibleStock = stockItems.filter(
      (it) =>
        !savedKeys.has(makeMediaKey(it.media_type || 'movie', it.id)) &&
        isCandidateEligibleInPool(it, savedItems, preferences)
    );

    const topGenreMetric = TAXONOMY_V01.filter(
      (d) => d.categoryId === 'genre' && d.scoringEnabled
    )
      .map((d) => ({
        id: d.id,
        title: getMetricDisplayTitle(d.id),
        affinity: resolveEffectiveMetricView(profile?.metrics?.[d.id]).effectiveAffinity,
      }))
      .sort((a, b) => b.affinity - a.affinity)[0];

    const dominantTitle =
      topGenreMetric && topGenreMetric.affinity > 0 ? topGenreMetric.title : 'Derin Anlatı';

    const watchedAsianCount = savedItems.filter((s) => {
      const lang = (s as unknown as { original_language?: string }).original_language || '';
      return ASIAN_LANG_SET.has(lang.toLowerCase());
    }).length;

    const watchedEuroCount = savedItems.filter((s) => {
      const lang = (s as unknown as { original_language?: string }).original_language || '';
      return EURO_LANG_SET.has(lang.toLowerCase());
    }).length;

    const watchedClassicCount = savedItems.filter((s) => {
      const yr = Number((s.release_date || s.first_air_date || '').slice(0, 4));
      return yr > 0 && yr < 2000;
    }).length;

    const results: BlindSpotSuggestion[] = [];

    if (watchedAsianCount < 3) {
      const asianPicks = eligibleStock
        .filter((it) =>
          ASIAN_LANG_SET.has(String(it.original_language || '').toLowerCase()) &&
          Number(it.vote_average || 0) >= 7.2
        )
        .sort((a, b) => Number(b.vote_average || 0) - Number(a.vote_average || 0))
        .slice(0, 6);

      if (asianPicks.length > 0) {
        results.push({
          id: 'blindspot-asian',
          headline: `${dominantTitle} seviyorsun — Doğu Asya Sineması ile kesişimi henüz denemedin`,
          rationale: `Kütüphanende yalnızca ${watchedAsianCount} Doğu Asya yapımı var. Yüksek puanlı Kore ve Japon yapımları mevcut eğiliminle güçlü uyum gösteriyor.`,
          items: asianPicks,
        });
      }
    }

    if (watchedEuroCount < 3) {
      const euroPicks = eligibleStock
        .filter((it) =>
          EURO_LANG_SET.has(String(it.original_language || '').toLowerCase()) &&
          Number(it.vote_average || 0) >= 7.2
        )
        .sort((a, b) => Number(b.vote_average || 0) - Number(a.vote_average || 0))
        .slice(0, 6);

      if (euroPicks.length > 0) {
        results.push({
          id: 'blindspot-euro',
          headline: `Avrupa & İskandinav Sineması — Zevk profilinle uyumlu keşif alanı`,
          rationale: `Kütüphanende ${watchedEuroCount} Avrupa yapımı bulunuyor. Atmosferik ve karakter odaklı bu seçki kör noktanı aydınlatabilir.`,
          items: euroPicks,
        });
      }
    }

    if (watchedClassicCount < 4) {
      const classicPicks = eligibleStock
        .filter((it) => {
          const yr = Number((it.release_date || it.first_air_date || '').slice(0, 4));
          return yr > 1950 && yr < 2000 && Number(it.vote_average || 0) >= 7.5;
        })
        .sort((a, b) => Number(b.vote_average || 0) - Number(a.vote_average || 0))
        .slice(0, 6);

      if (classicPicks.length > 0) {
        results.push({
          id: 'blindspot-classics',
          headline: `2000 Öncesi Modern Klasikler — Kanıtlı eğilimlerinin kökleri`,
          rationale: `Listen büyük ölçüde güncel dönem ağırlıklı (${watchedClassicCount} klasik yapım). Sevdiğin türlerin kurucu başyapıtları burada.`,
          items: classicPicks,
        });
      }
    }

    if (results.length === 0 && eligibleStock.length > 0) {
      const hiddenGems = eligibleStock
        .filter((it) => Number(it.vote_average || 0) >= 7.6 && Number(it.popularity || 0) < 60)
        .sort((a, b) => Number(b.vote_average || 0) - Number(a.vote_average || 0))
        .slice(0, 6);
      if (hiddenGems.length > 0) {
        results.push({
          id: 'blindspot-gems',
          headline: `${dominantTitle} ekseninde az bilinen yüksek puanlı seçki`,
          rationale: 'Ana akım listelerin dışında kalan ancak kişisel zevk profilinle örtüşen stok adayları.',
          items: hiddenGems,
        });
      }
    }

    return results;
  }, [savedItems, stockItems, preferences, profile]);

  return (
    <section aria-label="Evrenler ve Bağlantılar" className="py-4 sm:py-6 space-y-6">
      {/* Evrenler Hero Başlığı */}
      <header className="rounded-2xl border border-violet-400/20 bg-gradient-to-br from-cinema-surface/90 via-cinema-surface/75 to-violet-950/20 p-6 sm:p-8">
        <div className="max-w-2xl">
          <div className="inline-flex items-center gap-2 text-violet-300 text-xs font-mono uppercase tracking-wider mb-2">
            <Orbit className="w-3.5 h-3.5" aria-hidden="true" />
            <span>Bağlantıları Keşfet</span>
          </div>
          <h1 className="text-3xl sm:text-5xl font-display font-bold tracking-tight text-cinema-textPrimary">
            Evrenler
          </h1>
          <p className="mt-2 text-sm text-cinema-textMuted leading-relaxed">
            Kütüphanendeki serilerin eksik halkalarını, favori oyuncu ve yönetmen ağlarını, kavramsal zevk grafiğini ve henüz keşfetmediğin kör noktaları tek merkezden incele.
          </p>
        </div>

        {/* Evrenler Alt Dal Sekmeleri */}
        <div
          role="tablist"
          aria-label="Evrenler alt sekmeleri"
          className="mt-6 flex items-center gap-2 overflow-x-auto pb-1"
        >
          <button
            type="button"
            role="tab"
            aria-selected={subTab === 'franchises'}
            onClick={() => setSubTab('franchises')}
            className={`inline-flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-semibold transition-all whitespace-nowrap shrink-0 ${
              subTab === 'franchises'
                ? 'bg-violet-500/25 border border-violet-400/50 text-violet-200'
                : 'bg-cinema-bg/60 border border-white/10 text-cinema-textMuted hover:text-cinema-textPrimary'
            }`}
          >
            <Layers className="w-3.5 h-3.5" aria-hidden="true" />
            <span>Franchise & Seriler</span>
          </button>

          <button
            type="button"
            role="tab"
            aria-selected={subTab === 'people'}
            onClick={() => setSubTab('people')}
            className={`inline-flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-semibold transition-all whitespace-nowrap shrink-0 ${
              subTab === 'people'
                ? 'bg-violet-500/25 border border-violet-400/50 text-violet-200'
                : 'bg-cinema-bg/60 border border-white/10 text-cinema-textMuted hover:text-cinema-textPrimary'
            }`}
          >
            <Users className="w-3.5 h-3.5" aria-hidden="true" />
            <span>Oyuncu & Yönetmen Ağı</span>
          </button>

          <button
            type="button"
            role="tab"
            aria-selected={subTab === 'network'}
            onClick={() => setSubTab('network')}
            className={`inline-flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-semibold transition-all whitespace-nowrap shrink-0 ${
              subTab === 'network'
                ? 'bg-violet-500/25 border border-violet-400/50 text-violet-200'
                : 'bg-cinema-bg/60 border border-white/10 text-cinema-textMuted hover:text-cinema-textPrimary'
            }`}
          >
            <GitBranch className="w-3.5 h-3.5" aria-hidden="true" />
            <span>Zevk & Bağlantı Ağı</span>
          </button>

          <button
            type="button"
            role="tab"
            aria-selected={subTab === 'blind-spots'}
            onClick={() => setSubTab('blind-spots')}
            className={`inline-flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-semibold transition-all whitespace-nowrap shrink-0 ${
              subTab === 'blind-spots'
                ? 'bg-violet-500/25 border border-violet-400/50 text-violet-200'
                : 'bg-cinema-bg/60 border border-white/10 text-cinema-textMuted hover:text-cinema-textPrimary'
            }`}
          >
            <Compass className="w-3.5 h-3.5" aria-hidden="true" />
            <span>Keşif Alanları</span>
          </button>
        </div>
      </header>

      {/* 1. Franchise / Koleksiyonlar & Seri Bağlantıları */}
      {subTab === 'franchises' && (
        <SeriesRecommendationsSection
          savedItems={savedItems}
          dislikedKeys={preferences.disliked}
          hiddenKeys={preferences.hidden}
          genresMap={genresMap}
          mood={preferences.mood}
          selectedType={selectedType}
          selectedGenre={selectedGenre}
          selectedSort={selectedSort}
          isDemo={isDemo}
          tmdbSource={tmdbSource}
          onOpenDetails={(it) => onOpenDetails(it)}
          onQuickAdd={onQuickAdd}
          onSetStatus={onSetStatus}
          onQuickSave={(it) => onQuickSave(it)}
          onToggleDislike={onToggleDislike}
          onEmptyAction={onEmptyAction}
        />
      )}

      {/* 2. Oyuncu / Yönetmen Ağı */}
      {subTab === 'people' && (
        <div className="space-y-6">
          {topCollaborators.length > 0 && (
            <div className="rounded-2xl bg-cinema-surface/60 border border-white/10 p-5">
              <h3 className="text-sm font-semibold text-cinema-textPrimary mb-1">
                Kütüphanendeki Yaratıcı & Oyuncu Düğümleri
              </h3>
              <p className="text-xs text-cinema-textMuted mb-4">
                Bir isme tıklayarak tüm filmografisini ve ortak yapımlarını inceleyebilirsin
              </p>
              <div className="flex flex-wrap gap-2.5">
                {topCollaborators.map((person) => (
                  <button
                    key={person.id}
                    type="button"
                    onClick={() => onOpenPerson(person.id, person.name)}
                    className="px-3.5 py-2 rounded-xl bg-cinema-bg/80 border border-white/10 hover:border-violet-400/50 transition-colors text-left flex items-center gap-2.5"
                  >
                    <span className="text-xs font-medium text-cinema-textPrimary">
                      {person.name}
                    </span>
                    <span className="text-[11px] text-cinema-textMuted">
                      {person.role} · <strong className="tabular-nums text-violet-300">{person.count}</strong>
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {favoriteActors.length > 0 ? (
            <ActorRecommendationsSection
              favoriteActors={favoriteActors}
              savedItems={savedItems}
              dislikedKeys={preferences.disliked}
              genresMap={genresMap}
              preferredProviders={preferences.providers}
              selectedType={selectedType}
              selectedGenre={selectedGenre}
              selectedSort={selectedSort}
              onOpenDetails={(it) => onOpenDetails(it as TmdbItem)}
              onQuickAdd={(it) => onQuickAdd(it as TmdbItem)}
              onSetStatus={(it, st) => onSetStatus(it as TmdbItem, st)}
              onQuickSave={(it) => onQuickSave(it as TmdbItem)}
              onOpenPerson={onOpenPerson}
            />
          ) : (
            <div className="glass-panel rounded-2xl p-8 text-center space-y-2">
              <p className="text-sm text-cinema-textPrimary font-medium">
                Henüz favori oyuncu eklemedin
              </p>
              <p className="text-xs text-cinema-textMuted max-w-lg mx-auto">
                Herhangi bir film veya dizi detay penceresinden sevdiğin oyuncuları favorilerine eklediğinde, izlemediğin diğer yapımları burada otomatik listelenir.
              </p>
            </div>
          )}
        </div>
      )}

      {/* 3. Zevk Ağı & İlişki Grafiği */}
      {subTab === 'network' && (
        <div className="space-y-6">
          {conceptClusters.length > 0 && (
            <div className="rounded-2xl bg-cinema-surface/60 border border-white/10 p-5 space-y-3">
              <div>
                <h3 className="text-sm font-semibold text-cinema-textPrimary">
                  Kavram & Atmosfer Kümeleri (Zevk Ağı)
                </h3>
                <p className="text-xs text-cinema-textMuted">
                  Aktif zevk metriklerinin birbiriyle kurduğu anlamsal köprüler
                </p>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {conceptClusters.map(([groupKey, nodes]) => (
                  <div
                    key={groupKey}
                    className="p-3.5 rounded-xl bg-cinema-bg/70 border border-white/10 flex flex-wrap items-center gap-2"
                  >
                    {nodes.map((node, idx) => (
                      <React.Fragment key={node.id}>
                        {idx > 0 && (
                          <span className="text-xs text-violet-300" aria-hidden="true">
                            →
                          </span>
                        )}
                        <span className="text-xs font-medium text-cinema-textPrimary">
                          {node.title}{' '}
                          <span className="metric-value text-cinema-gold">
                            ({node.affinity > 0 ? `+${node.affinity}` : node.affinity})
                          </span>
                        </span>
                      </React.Fragment>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="flex items-center gap-2" role="group" aria-label="Ağ görünüm türü">
            <button
              type="button"
              aria-pressed={graphMode === 'relationships'}
              onClick={() => setGraphMode('relationships')}
              className={`px-3.5 py-2 rounded-xl text-xs font-semibold border transition-colors whitespace-nowrap ${
                graphMode === 'relationships'
                  ? 'bg-violet-500/20 border-violet-400/50 text-violet-200'
                  : 'bg-cinema-surface border-white/10 text-cinema-textMuted hover:text-cinema-textPrimary'
              }`}
            >
              Yapım & Kadro Bağlantıları
            </button>
            <button
              type="button"
              aria-pressed={graphMode === 'taste-map'}
              onClick={() => setGraphMode('taste-map')}
              className={`px-3.5 py-2 rounded-xl text-xs font-semibold border transition-colors whitespace-nowrap ${
                graphMode === 'taste-map'
                  ? 'bg-violet-500/20 border-violet-400/50 text-violet-200'
                  : 'bg-cinema-surface border-white/10 text-cinema-textMuted hover:text-cinema-textPrimary'
              }`}
            >
              Zevk Yakınlık Ağı
            </button>
          </div>

          <RelationshipExplorer
            key={`${profileId}-${graphMode}`}
            mode={graphMode}
            profileId={profileId}
            savedItems={savedItems}
            preferences={preferences}
            candidates={[]}
            favoriteActors={favoriteActors}
            genreNames={genresMap}
            onRefresh={onRefreshRelationships}
            onOpenDetails={onOpenDetails}
            onQuickSave={onQuickSave}
            initialSourceKey={graphMode === 'relationships' ? initialSourceKey : ''}
          />
        </div>
      )}

      {/* 4. Keşif Alanları (Blind Spots) */}
      {subTab === 'blind-spots' && (
        <div className="space-y-6">
          {blindSpots.length === 0 ? (
            <GlassCard className="text-center py-8 space-y-2">
              <p className="text-sm font-medium text-cinema-textPrimary">
                Keşif alanları analiz ediliyor
              </p>
              <p className="text-xs text-cinema-textMuted max-w-md mx-auto">
                Stok havuzu doldukça ve yapımları puanladıkça zevk profilinle uyumlu ama henüz hiç denemediğin sinema bölgeleri burada listelenir.
              </p>
            </GlassCard>
          ) : (
            blindSpots.map((spot) => (
              <div
                key={spot.id}
                className="rounded-2xl bg-cinema-surface/60 border border-white/10 p-5 sm:p-6 space-y-4"
              >
                <div>
                  <h3 className="text-lg font-display font-bold text-cinema-textPrimary">
                    {spot.headline}
                  </h3>
                  <p className="text-xs text-cinema-textMuted mt-1 leading-relaxed">
                    {spot.rationale}
                  </p>
                </div>

                <div className="grid">
                  {spot.items.map((item) => (
                    <MediaCard
                      key={makeMediaKey(item.media_type || 'movie', item.id)}
                      item={item}
                      genres={genresMap}
                      recommendationReason={spot.headline}
                      tab="discover"
                      onOpenDetails={(it) => onOpenDetails(it)}
                      onQuickAdd={onQuickAdd}
                      onSetStatus={onSetStatus}
                      onQuickSave={(it) => onQuickSave(it)}
                      onToggleDislike={onToggleDislike}
                      onOpenWhyModal={onOpenWhyModal}
                    />
                  ))}
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </section>
  );
};

export default UniversesHub;
