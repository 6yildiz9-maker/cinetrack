import React, { useState, useMemo } from 'react';
import {
  PersistentTasteMapData,
  TasteRing,
  TasteMapEntry,
  TasteProfileSummary,
  getTasteRingLabel,
  inferLifecycleRing,
  normalizeTasteRing,
  makeMediaKey,
} from '../core/cinetrack-core';
import { getPoster, releaseYear } from '../utils/helpers';

interface TasteMapViewProps {
  tasteMap: PersistentTasteMapData;
  summary: TasteProfileSummary | null;
  genresMap: Record<number, string>;
  onOpenDetails: (item: any) => void;
  onQuickSave: (item: any) => void;
  onSetStatus: (item: any, status: 'watching' | 'watchlist' | 'completed') => void;
  onToggleDislike: (key: string) => void;
  onRefreshTasteMap: () => void;
  isLoading?: boolean;
  isDemo?: boolean;
  tmdbSource?: string;
  tmdbStaleReason?: string;
}

export const TasteMapView: React.FC<TasteMapViewProps> = ({
  tasteMap,
  summary,
  genresMap,
  onOpenDetails,
  onQuickSave,
  onSetStatus,
  onToggleDislike,
  onRefreshTasteMap,
  isLoading = false,
  isDemo = false,
  tmdbSource = 'live',
  tmdbStaleReason,
}) => {
  const [activeViewTab, setActiveViewTab] = useState<'active' | 'archived'>('active');
  const [selectedRing, setSelectedRing] = useState<TasteRing>('ring0');
  const [mediaFilter, setMediaFilter] = useState<'all' | 'movie' | 'tv'>('all');

  const entriesList = useMemo(() => {
    return Object.values(tasteMap?.entries || {});
  }, [tasteMap]);

  const archivedList = useMemo(() => {
    return Object.values(tasteMap?.archivedEntries || {});
  }, [tasteMap]);

  const activeMoviesCount = useMemo(() => {
    return entriesList.filter((e) => e.mediaType === 'movie').length;
  }, [entriesList]);

  const activeTvCount = useMemo(() => {
    return entriesList.filter((e) => e.mediaType === 'tv').length;
  }, [entriesList]);

  const lastKeys = useMemo(() => tasteMap?.lastRecommendedKeys || [], [tasteMap]);

  // Ring counts for active entries
  const ringCounts = useMemo(() => {
    const counts: Record<string, number> = { ring0: 0, ring1: 0, ring2: 0 };
    for (const e of entriesList) {
      const key = e.mediaKey || makeMediaKey(e);
      const norm = inferLifecycleRing(key, e, lastKeys);
      counts[norm] = (counts[norm] || 0) + 1;
    }
    return counts;
  }, [entriesList, lastKeys]);

  // Filtered entries for selected ring
  const activeRingEntries = useMemo(() => {
    const targetNorm = normalizeTasteRing(selectedRing);
    return entriesList
      .filter((e) => {
        const key = e.mediaKey || makeMediaKey(e);
        const norm = inferLifecycleRing(key, e, lastKeys);
        if (norm !== targetNorm) return false;
        if (mediaFilter === 'all') return true;
        return e.mediaType === mediaFilter;
      })
      .sort((a, b) => b.matchScore - a.matchScore);
  }, [entriesList, selectedRing, mediaFilter, lastKeys]);

  // Filtered archived entries
  const filteredArchivedEntries = useMemo(() => {
    return archivedList
      .filter((e) => {
        if (mediaFilter === 'all') return true;
        return e.mediaType === mediaFilter;
      })
      .sort((a, b) => {
        if ((b.shownCount || 0) !== (a.shownCount || 0)) {
          return (b.shownCount || 0) - (a.shownCount || 0);
        }
        return b.matchScore - a.matchScore;
      });
  }, [archivedList, mediaFilter]);

  const ringsMeta: Array<{
    id: TasteRing;
    name: string;
    sub: string;
    priority: string;
    badgeColor: string;
    borderColor: string;
    desc: string;
    icon: string;
  }> = [
    {
      id: 'ring0',
      name: 'Halka 0 — Yeni Eşleşme',
      sub: 'Öncelikli Havuz',
      priority: '1. Öncelik',
      badgeColor: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40',
      borderColor: 'border-emerald-500',
      desc: 'Bu profil için henüz öneri vitrininde gösterilmemiş taze adaylar. Normal öneri sıralamasında 1. önceliktedir.',
      icon: '🌟',
    },
    {
      id: 'ring1',
      name: 'Halka 1 — Yakın Zamanda Gösterildi',
      sub: 'Dinlendirme Havuzu',
      priority: 'Dinleniyor',
      badgeColor: 'bg-amber-500/20 text-amber-300 border-amber-500/40',
      borderColor: 'border-amber-500',
      desc: 'Önceki öneri grubunda gösterilmiş, fakat henüz bir listeye eklenmemiş içerikler. Bir sonraki öneri grubunda gösterilmez.',
      icon: '⏳',
    },
    {
      id: 'ring2',
      name: 'Halka 2 — Daha Önce Atlandı',
      sub: 'Yedek Eşleşmeler',
      priority: '2. Öncelik (Yedek)',
      badgeColor: 'bg-sky-500/20 text-sky-300 border-sky-500/40',
      borderColor: 'border-sky-500',
      desc: 'En az bir öneri yenileme döngüsünde dinlendirilmiş, gerçek eşleşme puanı (%91 gibi) korunan adaylar. Yeni eşleşmeler yetersiz kaldığında devreye girer.',
      icon: '🔄',
    },
  ];

  return (
    <div className="shell py-6 space-y-8 animate-fadeIn">
      {/* TMDB Veri Kaynağı Durum Bildirimi (Eski Önbellek veya Demo) */}
      {tmdbSource === 'stale-cache' && (
        <div className="p-4 rounded-xl bg-rose-500/15 border border-rose-500/40 text-rose-200 text-xs sm:text-sm flex items-start gap-3 shadow-lg">
          <span className="text-xl leading-none">⚠️</span>
          <div>
            <strong className="text-white block font-semibold mb-0.5">Çevrimdışı / Eski Önbellek Modu Devrede</strong>
            TMDB canlı servisi anlık yanıt vermediği için bu zevk haritasındaki yapımlar ve eşleşme puanları son geçerli önbellek verisinden hesaplanmıştır.
            {tmdbStaleReason ? ` (${tmdbStaleReason})` : ''}
          </div>
        </div>
      )}

      {tmdbSource === 'demo' && (
        <div className="p-4 rounded-xl bg-amber-500/15 border border-amber-500/40 text-amber-200 text-xs sm:text-sm flex items-start gap-3 shadow-lg">
          <span className="text-xl leading-none">🟡</span>
          <div>
            <strong className="text-white block font-semibold mb-0.5">Örnek Katalog Modu</strong>
            Sunucu ortamında TMDB_API_KEY tanımlanmadığından zevk haritası CineTrack'in yerleşik çevrimdışı örnek film ve dizi havuzuyla çalışmaktadır.
          </div>
        </div>
      )}

      {/* Banner & Control Header */}
      <div className="bg-gradient-to-r from-slate-900 via-rose-950/40 to-slate-900 border border-slate-800 rounded-2xl p-6 sm:p-8 shadow-xl relative overflow-hidden">
        <div className="absolute top-0 right-0 w-96 h-96 bg-rose-500/10 rounded-full blur-3xl pointer-events-none -mr-20 -mt-20"></div>
        <div className="relative z-10 flex flex-col md:flex-row md:items-center justify-between gap-6">
          <div className="space-y-2">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-rose-500/15 border border-rose-500/30 text-rose-300 text-xs font-semibold">
              <span>🗺️ Akıllı Katman</span>
              <span>·</span>
              <span>15 Sinyalli Zevk Motoru</span>
            </div>
            <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight text-white flex items-center gap-3">
              Kişisel Zevk Haritası
            </h1>
            <p className="text-sm text-slate-300 max-w-2xl leading-relaxed">
              Mevcut 15 sinyalli algoritmanın üzerinde çalışan kalıcı eşleşme haritası. Adaylar her
              sayfa değişiminde baştan hesaplanmaz; profilin değiştikçe güncellenir ve atlanan
              yapımlar halka geriletmesi ile yörüngeye taşınır.
            </p>
            <div className="flex flex-wrap items-center gap-3 text-xs text-slate-400 pt-2">
              {/* 1. Profil Modu */}
              <span
                className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold ${
                  isDemo
                    ? 'bg-amber-500/15 border border-amber-500/30 text-amber-300'
                    : 'bg-emerald-500/15 border border-emerald-500/30 text-emerald-300'
                }`}
                title={isDemo ? 'Profil modu: Örnek demo kayıtları içeriyor' : 'Profil modu: Kişisel listenizdeki gerçek kayıtlara dayanıyor'}
              >
                <span className={`w-2 h-2 rounded-full ${isDemo ? 'bg-amber-400' : 'bg-emerald-400'}`}></span>
                <span>{isDemo ? '🟡 Demo Profil' : '🟢 Kişisel Profil'}</span>
              </span>

              <span>·</span>

              {/* 2. Gerçek TMDB Kaynağı */}
              <span
                className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold ${
                  tmdbSource === 'live'
                    ? 'bg-emerald-500/15 border border-emerald-500/30 text-emerald-300'
                    : tmdbSource === 'stale-cache'
                    ? 'bg-rose-500/15 border border-rose-500/30 text-rose-300'
                    : 'bg-amber-500/15 border border-amber-500/30 text-amber-300'
                }`}
                title={
                  tmdbSource === 'live'
                    ? 'TMDB API canlı ve güncel'
                    : tmdbSource === 'stale-cache'
                    ? `TMDB canlı servisi kapalı; son geçerli önbellek sunuluyor${tmdbStaleReason ? ` (${tmdbStaleReason})` : ''}`
                    : 'TMDB API anahtarı girilmediğinden çevrimdışı örnek katalog kullanılıyor'
                }
              >
                <span
                  className={`w-2 h-2 rounded-full ${
                    tmdbSource === 'live'
                      ? 'bg-emerald-400'
                      : tmdbSource === 'stale-cache'
                      ? 'bg-rose-400'
                      : 'bg-amber-400'
                  }`}
                ></span>
                <span>
                  {tmdbSource === 'live'
                    ? '🟢 Canlı TMDB Kataloğu'
                    : tmdbSource === 'stale-cache'
                    ? '⚠️ Eski Önbellek (Offline)'
                    : '🟡 Örnek TMDB Kataloğu'}
                </span>
              </span>

              <span>·</span>
              <span className="flex items-center gap-1.5" title="Öneri motorunun doğrudan seçim yaptığı güncel aday havuzu">
                <span className="w-2 h-2 rounded-full bg-emerald-400"></span>
                <span>Aktif Havuz: <strong className="text-slate-200">{entriesList.length}</strong> ({activeMoviesCount} Film + {activeTvCount} Dizi)</span>
              </span>
              {archivedList.length > 0 && (
                <>
                  <span>·</span>
                  <span className="flex items-center gap-1.5" title="Havuz rotasyonu ile arşive alınan, gösterim ve ceza geçmişi profilde korunan içerikler">
                    <span className="w-2 h-2 rounded-full bg-slate-400"></span>
                    <span>Arşivlenen Geçmiş: <strong className="text-slate-200">{archivedList.length}</strong> (Havuz dışı)</span>
                  </span>
                </>
              )}
              <span>·</span>
              <span>Son Senkronizasyon: <strong className="text-slate-200">{tasteMap?.updatedAt ? new Date(tasteMap.updatedAt).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' }) : 'Şimdi'}</strong></span>
              {tasteMap?.profileSignature && (
                <>
                  <span>·</span>
                  <span className="font-mono bg-slate-800/80 px-2 py-0.5 rounded text-[10px] text-slate-300" title={tasteMap.profileSignature}>
                    İmza: {tasteMap.profileSignature.slice(0, 18)}...
                  </span>
                </>
              )}
            </div>
          </div>

          <div className="flex flex-col sm:flex-row gap-3 flex-shrink-0">
            <button
              type="button"
              onClick={onRefreshTasteMap}
              disabled={isLoading}
              className="btn btn-primary inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl font-medium shadow-lg hover:shadow-rose-500/20 transition-all disabled:opacity-50"
            >
              <svg className={`icon w-4 h-4 ${isLoading ? 'animate-spin' : ''}`}>
                <use href="#icon-refresh"></use>
              </svg>
              <span>{isLoading ? 'Analiz Ediliyor...' : 'Zevk Haritasını Yenile'}</span>
            </button>
          </div>
        </div>
      </div>

      {/* 3 Ana Sütun (Pillars) Özeti */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
        {/* Sütun 1: Tür ve Hikâye */}
        <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-5 hover:border-slate-700 transition-colors">
          <div className="flex items-center gap-3 mb-3">
            <span className="w-9 h-9 rounded-lg bg-rose-500/20 text-rose-400 flex items-center justify-center text-lg">
              📖
            </span>
            <div>
              <h3 className="font-bold text-slate-100 text-sm">1. Tür ve Hikâye</h3>
              <p className="text-xs text-slate-400">Tür tercihi, anahtar kelimeler ve özet</p>
            </div>
          </div>
          <div className="space-y-3 pt-1">
            <div>
              <span className="text-xs font-semibold text-slate-300 block mb-1.5">Öne Çıkan Türler:</span>
              <div className="flex flex-wrap gap-1.5">
                {(summary?.topGenres || []).length > 0 ? (
                  summary!.topGenres.map((g) => (
                    <span
                      key={g.id}
                      className="px-2.5 py-1 rounded-md bg-rose-950/40 border border-rose-900/50 text-rose-200 text-xs font-medium"
                    >
                      {g.name} <span className="opacity-75">%{g.score}</span>
                    </span>
                  ))
                ) : (
                  <span className="text-xs text-slate-500 italic">Kayıtlı tür verisi bekleniyor</span>
                )}
              </div>
            </div>
            {(summary?.storyKeywords || []).length > 0 && (
              <div>
                <span className="text-xs font-semibold text-slate-300 block mb-1.5">Sevilen Özet Temaları:</span>
                <div className="flex flex-wrap gap-1">
                  {summary!.storyKeywords.map((kw, i) => (
                    <span key={i} className="px-2 py-0.5 rounded bg-slate-800 text-slate-300 text-[11px]">
                      #{kw}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Sütun 2: Kadro ve Yaratıcılar */}
        <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-5 hover:border-slate-700 transition-colors">
          <div className="flex items-center gap-3 mb-3">
            <span className="w-9 h-9 rounded-lg bg-amber-500/20 text-amber-400 flex items-center justify-center text-lg">
              🎭
            </span>
            <div>
              <h3 className="font-bold text-slate-100 text-sm">2. Kadro ve Yaratıcılar</h3>
              <p className="text-xs text-slate-400">Oyuncular, yönetmenler ve kadro uyumu</p>
            </div>
          </div>
          <div className="space-y-3 pt-1">
            <div>
              <span className="text-xs font-semibold text-slate-300 block mb-1.5">Etkili Oyuncular:</span>
              <div className="flex flex-wrap gap-1.5">
                {(summary?.topActors || []).length > 0 ? (
                  summary!.topActors.map((a) => (
                    <span
                      key={a.id}
                      className="px-2.5 py-1 rounded-md bg-amber-950/40 border border-amber-900/50 text-amber-200 text-xs font-medium"
                    >
                      {a.name} <span className="opacity-75">({a.appearances} yapım)</span>
                    </span>
                  ))
                ) : (
                  <span className="text-xs text-slate-500 italic">İzlenen yapımlardan taranıyor</span>
                )}
              </div>
            </div>
            {(summary?.topDirectors || []).length > 0 && (
              <div>
                <span className="text-xs font-semibold text-slate-300 block mb-1.5">Yönetmenler:</span>
                <div className="flex flex-wrap gap-1.5">
                  {summary!.topDirectors.map((d) => (
                    <span key={d.id} className="px-2 py-0.5 rounded bg-slate-800 text-slate-300 text-xs">
                      🎬 {d.name}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Sütun 3: Keşif ve Kalite */}
        <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-5 hover:border-slate-700 transition-colors">
          <div className="flex items-center gap-3 mb-3">
            <span className="w-9 h-9 rounded-lg bg-sky-500/20 text-sky-400 flex items-center justify-center text-lg">
              ⭐
            </span>
            <div>
              <h3 className="font-bold text-slate-100 text-sm">3. Keşif ve Kalite</h3>
              <p className="text-xs text-slate-400">TMDB Bayesyen kalite, popülerlik ve bağlam</p>
            </div>
          </div>
          <div className="space-y-3 pt-1 text-xs text-slate-300">
            <div className="bg-slate-950/60 p-3 rounded-lg border border-slate-800 space-y-1.5">
              <div className="flex justify-between items-center">
                <span className="text-slate-400">Kalite Standartı:</span>
                <span className="font-semibold text-slate-200">Bayesyen Ağırlıklı (R_B / 10)</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-slate-400">Halka Kotası:</span>
                <span className="font-semibold text-slate-200">10 Film + 10 Dizi Garantisi</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-slate-400">Geriletme Kuralı:</span>
                <span className="font-semibold text-rose-300">Her Atlamada Halka 2 + Ceza</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Aktif Havuz vs Arşivlenen Geçmiş Görünüm Seçici Sekmeleri */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-800 pb-4">
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setActiveViewTab('active')}
            className={`px-4 py-2 rounded-xl text-xs sm:text-sm font-semibold transition-all flex items-center gap-2 ${
              activeViewTab === 'active'
                ? 'bg-rose-600 text-white shadow-lg shadow-rose-950/40 ring-1 ring-rose-500'
                : 'bg-slate-900 text-slate-400 hover:text-white hover:bg-slate-800/80 border border-slate-800'
            }`}
          >
            <span>🌟 Aktif Aday Havuzu</span>
            <span className="bg-slate-950/60 px-2 py-0.5 rounded-full text-xs font-mono font-bold">
              {entriesList.length}
            </span>
          </button>

          <button
            type="button"
            onClick={() => setActiveViewTab('archived')}
            className={`px-4 py-2 rounded-xl text-xs sm:text-sm font-semibold transition-all flex items-center gap-2 ${
              activeViewTab === 'archived'
                ? 'bg-slate-700 text-white shadow-lg ring-1 ring-slate-500'
                : 'bg-slate-900 text-slate-400 hover:text-white hover:bg-slate-800/80 border border-slate-800'
            }`}
          >
            <span>📦 Arşivlenen Havuz Geçmişi</span>
            <span className="bg-slate-950/60 px-2 py-0.5 rounded-full text-xs font-mono font-bold">
              {archivedList.length}
            </span>
          </button>
        </div>

        {/* Film / Dizi filtresi */}
        <div className="inline-flex p-1 rounded-xl bg-slate-900 border border-slate-800 text-xs">
          <button
            type="button"
            className={`px-3 py-1.5 rounded-lg font-medium transition-colors ${
              mediaFilter === 'all' ? 'bg-rose-600 text-white shadow-sm' : 'text-slate-400 hover:text-white'
            }`}
            onClick={() => setMediaFilter('all')}
          >
            Tümü
          </button>
          <button
            type="button"
            className={`px-3 py-1.5 rounded-lg font-medium transition-colors ${
              mediaFilter === 'movie' ? 'bg-rose-600 text-white shadow-sm' : 'text-slate-400 hover:text-white'
            }`}
            onClick={() => setMediaFilter('movie')}
          >
            Filmler
          </button>
          <button
            type="button"
            className={`px-3 py-1.5 rounded-lg font-medium transition-colors ${
              mediaFilter === 'tv' ? 'bg-rose-600 text-white shadow-sm' : 'text-slate-400 hover:text-white'
            }`}
            onClick={() => setMediaFilter('tv')}
          >
            Diziler
          </button>
        </div>
      </div>

      {activeViewTab === 'active' ? (
        <>
          {/* 4 Konsantrik Halka Seçici */}
          <div className="space-y-4">
            <div>
              <h2 className="text-xl font-bold text-white flex items-center gap-2">
                <span>Konsantrik Zevk Halkaları</span>
              </h2>
              <p className="text-xs text-slate-400">
                Aktif havuzdaki yapımlar zevk uyumluluğuna ve atlanma geçmişine göre halkalara yerleşir
              </p>
            </div>

            {/* 3 Halka Kartları */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              {ringsMeta.map((meta) => {
                const count = ringCounts[meta.id] || 0;
                const isSelected = normalizeTasteRing(selectedRing) === normalizeTasteRing(meta.id);
                return (
                  <button
                    key={meta.id}
                    type="button"
                    onClick={() => setSelectedRing(meta.id)}
                    className={`text-left p-4 rounded-xl border transition-all relative overflow-hidden group ${
                      isSelected
                        ? `bg-slate-900/95 border-emerald-500 ring-2 ring-emerald-500/30 shadow-lg shadow-emerald-950/20`
                        : `bg-slate-900/50 border-slate-800 hover:border-slate-700 hover:bg-slate-900/80`
                    }`}
                  >
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-xl">{meta.icon}</span>
                      <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-md border ${meta.badgeColor}`}>
                        {meta.priority}
                      </span>
                    </div>
                    <h4 className="font-bold text-slate-100 text-sm group-hover:text-emerald-300 transition-colors">
                      {meta.name}
                    </h4>
                    <p className="text-xs text-slate-400 mb-3">{meta.sub}</p>
                    <div className="flex items-center justify-between text-xs font-semibold pt-2 border-t border-slate-800/80">
                      <span className="text-slate-400">Haritadaki Yapım:</span>
                      <span className="text-white bg-slate-800 px-2 py-0.5 rounded font-mono">
                        {count}
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Seçilen Halkadaki Yapımlar Grid */}
          <div className="space-y-4 pt-2">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div className="flex items-center gap-3">
                <span className="text-lg">
                  {ringsMeta.find((r) => r.id === selectedRing)?.icon}
                </span>
                <div>
                  <h3 className="font-bold text-white text-base">
                    {ringsMeta.find((r) => r.id === selectedRing)?.name} İçerikleri
                  </h3>
                  <p className="text-xs text-slate-400">
                    {ringsMeta.find((r) => r.id === selectedRing)?.desc}
                  </p>
                </div>
              </div>
              <span className="text-xs text-slate-400 font-mono bg-slate-900 px-3 py-1 rounded-full border border-slate-800">
                {activeRingEntries.length} Yapım
              </span>
            </div>

            {activeRingEntries.length === 0 ? (
              <div className="text-center py-12 bg-slate-900/40 border border-slate-800/80 rounded-2xl">
                <span className="text-4xl block mb-2">🔭</span>
                <p className="text-sm text-slate-300 font-medium">Bu halkada henüz aktif aday bulunmuyor.</p>
                <p className="text-xs text-slate-500 mt-1">
                  "Zevk Haritasını Yenile" butonuna tıklayarak havuzdaki adayları haritaya işleyebilirsiniz.
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
                {activeRingEntries.slice(0, 30).map((entry) => {
                  const poster = getPoster(entry);
                  const year = releaseYear(entry);
                  const pillars = entry.pillars || { genreStoryScore: 75, castCreatorsScore: 70, discoveryQualityScore: 75 };
                  const key = entry.mediaKey || makeMediaKey(entry);

                  return (
                    <article
                      key={key}
                      className="bg-slate-900 border border-slate-800 hover:border-slate-700 rounded-xl overflow-hidden shadow-md flex flex-col group transition-all"
                    >
                      {/* Poster Area */}
                      <div
                        className="aspect-[2/3] relative bg-slate-950 cursor-pointer overflow-hidden"
                        onClick={() => onOpenDetails(entry)}
                      >
                        {poster ? (
                          <img
                            src={poster}
                            alt={entry.title}
                            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                            loading="lazy"
                          />
                        ) : (
                          <div className="w-full h-full flex flex-col items-center justify-center p-3 text-center text-slate-500">
                            <span className="text-2xl mb-1">🎬</span>
                            <span className="text-xs line-clamp-2">{entry.title}</span>
                          </div>
                        )}

                        {/* Uyum ve Öncelik Rozetleri */}
                        <div className="absolute top-2 left-2 z-10 flex flex-col gap-1 items-start">
                          <span
                            className="bg-rose-600/90 backdrop-blur-md text-white text-[11px] font-bold px-2 py-0.5 rounded shadow flex items-center gap-1 tabular-nums"
                            title={`Saf Zevk Uyumu: Uyum: ${entry.tasteScore ?? entry.matchScore}/100 (İçeriğin kullanıcı profiline kalıcı zevk uyumu)`}
                          >
                            <span>Uyum: {entry.tasteScore ?? entry.matchScore}/100</span>
                          </span>
                          {entry.priorityScore != null && entry.priorityScore < (entry.tasteScore ?? entry.matchScore) && (
                            <span
                              className="bg-slate-900/90 border border-amber-500/50 backdrop-blur-md text-amber-300 text-[10px] font-mono font-bold px-1.5 py-0.2 rounded shadow tabular-nums"
                              title={`Gösterim / atlanma cezası sonrası seçim önceliği: ${entry.priorityScore}/100 (Saf zevk uyumu ${entry.tasteScore ?? entry.matchScore}/100 korunuyor)`}
                            >
                              Öncelik: {entry.priorityScore}/100
                            </span>
                          )}
                        </div>

                        {/* Puan Derinliği (Score Coverage) */}
                        <div className="absolute bottom-2 left-2 z-10 pointer-events-none">
                          <span
                            className={`backdrop-blur-md text-[9px] font-semibold px-1.5 py-0.5 rounded shadow ${
                              entry.scoreCoverage === 'enriched'
                                ? 'bg-amber-500/85 text-amber-100 border border-amber-400/40'
                                : 'bg-slate-900/85 text-slate-300 border border-slate-700/60'
                            }`}
                            title={
                              entry.scoreCoverage === 'enriched'
                                ? 'Ayrıntılı Puanlama: Oyuncu, yönetmen ve TMDB kadro kredileriyle yüksek derinlikte hesaplandı'
                                : 'Temel Puanlama: Katalog türleri ve genel metaverilerle standart derinlikte hesaplandı'
                            }
                          >
                            {entry.scoreCoverage === 'enriched' ? '✨ Kadro Derinliği' : '📋 Temel Katalog'}
                          </span>
                        </div>

                        {/* Tür / Format */}
                        <div className="absolute top-2 right-2 z-10">
                          <span className="bg-slate-900/80 backdrop-blur-md text-slate-200 text-[10px] font-semibold px-1.5 py-0.5 rounded uppercase">
                            {entry.mediaType === 'tv' ? 'Dizi' : 'Film'}
                          </span>
                        </div>

                        {/* Quick status button stack */}
                        <div
                          className="absolute bottom-2 right-2 flex gap-1 z-10"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <button
                            type="button"
                            className="w-7 h-7 rounded-full bg-slate-900/90 hover:bg-rose-600 text-white flex items-center justify-center shadow text-xs transition-colors"
                            title="İzleneceklere ekle"
                            onClick={() => onSetStatus(entry, 'watchlist')}
                          >
                            +
                          </button>
                          <button
                            type="button"
                            className="w-7 h-7 rounded-full bg-slate-900/90 hover:bg-emerald-600 text-white flex items-center justify-center shadow text-xs transition-colors"
                            title="İzlendi olarak işaretle"
                            onClick={() => onSetStatus(entry, 'completed')}
                          >
                            ✓
                          </button>
                        </div>
                      </div>

                      {/* Info Area */}
                      <div className="p-3 flex-1 flex flex-col justify-between space-y-2">
                        <div>
                          <h4
                            className="text-xs font-bold text-white line-clamp-1 hover:text-rose-400 cursor-pointer transition-colors"
                            onClick={() => onOpenDetails(entry)}
                            title={entry.title}
                          >
                            {entry.title}
                          </h4>
                          <div className="flex items-center gap-2 text-[11px] text-slate-400 mt-0.5">
                            <span>{year}</span>
                            {entry.vote_average ? (
                              <span>⭐ {entry.vote_average.toFixed(1)}</span>
                            ) : null}
                            <span className="text-[10px] font-mono text-slate-500">
                              · {entry.scoreCoverage === 'enriched' ? '✨ Ayrıntılı' : '📋 Temel'}
                            </span>
                          </div>
                        </div>

                        {/* 3 Sütun Mini Barları */}
                        <div className="space-y-1 pt-1 border-t border-slate-800/80 text-[10px]">
                          <div className="flex items-center justify-between text-slate-400">
                            <span>📖 Tür/Hikâye</span>
                            <span className="font-mono text-slate-300">%{pillars.genreStoryScore}</span>
                          </div>
                          <div className="w-full bg-slate-800 rounded-full h-1">
                            <div
                              className="bg-rose-500 h-1 rounded-full"
                              style={{ width: `${pillars.genreStoryScore}%` }}
                            ></div>
                          </div>

                          <div className="flex items-center justify-between text-slate-400 pt-0.5">
                            <span>🎭 Kadro</span>
                            <span className="font-mono text-slate-300">%{pillars.castCreatorsScore}</span>
                          </div>
                          <div className="w-full bg-slate-800 rounded-full h-1">
                            <div
                              className="bg-amber-500 h-1 rounded-full"
                              style={{ width: `${pillars.castCreatorsScore}%` }}
                            ></div>
                          </div>

                          <div className="flex items-center justify-between text-slate-400 pt-0.5">
                            <span>⭐ Keşif/Kalite</span>
                            <span className="font-mono text-slate-300">%{pillars.discoveryQualityScore}</span>
                          </div>
                          <div className="w-full bg-slate-800 rounded-full h-1">
                            <div
                              className="bg-sky-500 h-1 rounded-full"
                              style={{ width: `${pillars.discoveryQualityScore}%` }}
                            ></div>
                          </div>
                        </div>

                        {/* Gösterim, Öncelik & Halka Durumu */}
                        <div className="space-y-1 pt-1 border-t border-slate-800/60">
                          {entry.demotionPenalty > 0 && (
                            <div className="flex items-center justify-between text-[10px] text-amber-300 bg-amber-500/10 px-1.5 py-0.5 rounded border border-amber-500/20">
                              <span>⚡ Seçim Önceliği:</span>
                              <span className="font-mono font-bold">%{entry.priorityScore ?? entry.matchScore} (-{entry.demotionPenalty}p)</span>
                            </div>
                          )}
                          <div className="text-[10px] text-slate-400 flex items-center justify-between">
                            <span
                              title={
                                entry.firstShownAt
                                  ? `Toplam ${entry.shownCount || 0} gösterim (İlk: ${new Date(entry.firstShownAt).toLocaleDateString('tr-TR')} · Son: ${entry.lastShownAt ? new Date(entry.lastShownAt).toLocaleDateString('tr-TR') : '-'}${entry.archivedImpressionCount ? ` · Arşivlenen: ${entry.archivedImpressionCount}` : ''})`
                                  : `Toplam ${entry.shownCount || 0} gösterim`
                              }
                            >
                              👁️ {entry.shownCount || 0} gösterim
                            </span>
                            {inferLifecycleRing(key, entry, lastKeys) === 'ring0' ? (
                              <span className="text-emerald-400 font-medium">🌟 Yeni</span>
                            ) : inferLifecycleRing(key, entry, lastKeys) === 'ring1' ? (
                              <span className="text-amber-400 font-medium">⏳ Dinleniyor</span>
                            ) : (
                              <span className="text-sky-400 font-medium">🔄 Yedek ({entry.skippedCount || 1}x)</span>
                            )}
                          </div>
                        </div>
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </div>
        </>
      ) : (
        /* Arşivlenen Havuz Geçmişi Görünümü */
        <div className="space-y-6">
          <div className="p-5 rounded-2xl bg-slate-900/90 border border-slate-800 text-xs text-slate-300 space-y-2.5 shadow-lg">
            <div className="flex items-center gap-2.5 text-amber-300 font-bold text-sm">
              <span className="text-xl">📦</span>
              <span>Havuz Dışı Kalan İçerikler ve Korunan Gösterim Geçmişi</span>
            </div>
            <p className="leading-relaxed">
              TMDB katalog havuzu güncellendikçe veya kullanıcı zevk profili değiştikçe bazı yapımlar aktif 500 Film + 500 Dizi havuzunun dışına çıkabilir. 
              CineTrack, bu yapımların geçmişte kaç kez gösterildiğini ({filteredArchivedEntries.reduce((sum, e) => sum + (e.shownCount || 0), 0)} toplam gösterim), halka geriletmelerini ve ceza puanlarını unutmaz; arşive taşıyarak aktif öneri sayacının (1000 aday) her zaman doğru kalmasını sağlar.
            </p>
            <p className="text-slate-400">
              Bu yapımlar havuz yeniden yenilendiğinde tekrar aday listesine girerse, önceki gösterim geçmişleri ve halka durumları eksiksiz korunarak kaldığı yerden devam eder.
            </p>
          </div>

          <div className="flex items-center justify-between border-b border-slate-800 pb-3">
            <h3 className="font-bold text-white text-base flex items-center gap-2">
              <span>Arşivdeki Yapımlar ({filteredArchivedEntries.length})</span>
            </h3>
            <span className="text-xs text-slate-400 font-mono bg-slate-900 px-3 py-1 rounded-full border border-slate-800">
              {filteredArchivedEntries.length} İçerik
            </span>
          </div>

          {filteredArchivedEntries.length === 0 ? (
            <div className="text-center py-12 bg-slate-900/40 border border-slate-800/80 rounded-2xl">
              <span className="text-4xl block mb-2">✨</span>
              <p className="text-sm text-slate-300 font-medium">Henüz arşivlenmiş havuz dışı içerik bulunmuyor.</p>
              <p className="text-xs text-slate-500 mt-1">
                Katalog adayları yenilendiğinde aktif havuzdan çıkan içerikler geçmişleriyle birlikte burada listelenecektir.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
              {filteredArchivedEntries.slice(0, 30).map((entry) => {
                const poster = getPoster(entry);
                const year = releaseYear(entry);
                const key = entry.mediaKey || makeMediaKey(entry);

                return (
                  <article
                    key={key}
                    className="bg-slate-900/70 border border-slate-800/80 hover:border-slate-700 rounded-xl overflow-hidden shadow flex flex-col group transition-all opacity-85 hover:opacity-100"
                  >
                    <div
                      className="aspect-[2/3] relative bg-slate-950 cursor-pointer overflow-hidden"
                      onClick={() => onOpenDetails(entry)}
                    >
                      {poster ? (
                        <img
                          src={poster}
                          alt={entry.title}
                          className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                          loading="lazy"
                        />
                      ) : (
                        <div className="w-full h-full flex flex-col items-center justify-center p-3 text-center text-slate-500">
                          <span className="text-2xl mb-1">🎬</span>
                          <span className="text-xs line-clamp-2">{entry.title}</span>
                        </div>
                      )}

                      <div className="absolute top-2 left-2 z-10">
                        <span className="bg-slate-800/90 backdrop-blur-md text-slate-200 text-[10px] font-semibold px-2 py-0.5 rounded shadow border border-slate-700">
                          📦 Havuz Dışı
                        </span>
                      </div>

                      <div className="absolute top-2 right-2 z-10">
                        <span className="bg-slate-900/80 backdrop-blur-md text-slate-300 text-[10px] font-semibold px-1.5 py-0.5 rounded uppercase">
                          {entry.mediaType === 'tv' ? 'Dizi' : 'Film'}
                        </span>
                      </div>

                      <div
                        className="absolute bottom-2 right-2 flex gap-1 z-10"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <button
                          type="button"
                          className="w-7 h-7 rounded-full bg-slate-900/90 hover:bg-rose-600 text-white flex items-center justify-center shadow text-xs transition-colors"
                          title="İzleneceklere ekle"
                          onClick={() => onSetStatus(entry, 'watchlist')}
                        >
                          +
                        </button>
                        <button
                          type="button"
                          className="w-7 h-7 rounded-full bg-slate-900/90 hover:bg-emerald-600 text-white flex items-center justify-center shadow text-xs transition-colors"
                          title="İzlendi olarak işaretle"
                          onClick={() => onSetStatus(entry, 'completed')}
                        >
                          ✓
                        </button>
                      </div>
                    </div>

                    <div className="p-3 flex-1 flex flex-col justify-between space-y-2">
                      <div>
                        <h4
                          className="text-xs font-bold text-slate-200 line-clamp-1 hover:text-rose-400 cursor-pointer transition-colors"
                          onClick={() => onOpenDetails(entry)}
                          title={entry.title}
                        >
                          {entry.title}
                        </h4>
                        <div className="flex items-center gap-2 text-[11px] text-slate-400 mt-0.5">
                          <span>{year}</span>
                          <span>🎯 %{entry.tasteScore ?? entry.matchScore} Uyum</span>
                          {entry.priorityScore != null && entry.priorityScore < (entry.tasteScore ?? entry.matchScore) && (
                            <span className="text-amber-400 font-mono text-[10px]">· ⚡ %{entry.priorityScore}</span>
                          )}
                        </div>
                      </div>

                      <div className="text-[10px] bg-slate-950/60 p-2 rounded border border-slate-800 text-slate-400 space-y-1">
                        <div className="flex justify-between">
                          <span>Kayıt Nedeni:</span>
                          <span className="text-slate-300 font-medium">Havuz Rotasyonu</span>
                        </div>
                        <div className="flex justify-between">
                          <span>Geçmiş Gösterim:</span>
                          <span className="text-amber-400 font-mono font-medium">{entry.shownCount || 0} kez</span>
                        </div>
                        {entry.firstShownAt && (
                          <div className="flex justify-between text-[9px] text-slate-500">
                            <span>İlk / Son:</span>
                            <span>{new Date(entry.firstShownAt).toLocaleDateString('tr-TR')} — {entry.lastShownAt ? new Date(entry.lastShownAt).toLocaleDateString('tr-TR') : '-'}</span>
                          </div>
                        )}
                        <div className="flex justify-between">
                          <span>Puan Derinliği:</span>
                          <span className={entry.scoreCoverage === 'enriched' ? 'text-amber-300' : 'text-slate-400'}>
                            {entry.scoreCoverage === 'enriched' ? '✨ Kadro' : '📋 Temel'}
                          </span>
                        </div>
                        <div className="flex justify-between">
                          <span>Son Halka Durumu:</span>
                          <span className="text-slate-300">{inferLifecycleRing(key, entry, lastKeys)}</span>
                        </div>
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Mimari Açıklama Kartı */}
      <div className="bg-slate-900/60 border border-slate-800/80 rounded-2xl p-6 text-xs text-slate-400 space-y-2">
        <h4 className="font-bold text-slate-200 text-sm flex items-center gap-2">
          <span>ℹ️ Halka Sistemi, Zevk Uyumu ve Puan Derinliği Mimarisi</span>
        </h4>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 pt-2">
          <div className="bg-slate-950/40 p-3 rounded-lg border border-slate-800">
            <strong className="text-emerald-300 block mb-1">🌟 Halka 0 — Yeni Eşleşme</strong>
            Bu profil için henüz vitrinde gösterilmemiş taze adaylar. Normal öneri sıralamasında 1. önceliktedir.
          </div>
          <div className="bg-slate-950/40 p-3 rounded-lg border border-slate-800">
            <strong className="text-amber-300 block mb-1">⏳ Halka 1 — Yakın Zamanda Gösterildi</strong>
            Önceki grupta gösterilmiş içerikler dinlendirilir. Aynı önerilerin art arda çıkmaması için bir sonraki grupta gösterilmez.
          </div>
          <div className="bg-slate-950/40 p-3 rounded-lg border border-slate-800">
            <strong className="text-sky-300 block mb-1">🔄 Halka 2 — Daha Önce Atlandı</strong>
            Gerçek eşleşme puanı (%91 gibi) korunur. Yeni adaylar (Halka 0) 10+10 kotasını dolduramazsa devreye girer.
          </div>
          <div className="bg-slate-950/40 p-3 rounded-lg border border-slate-800">
            <strong className="text-rose-300 block mb-1">🎯 Uyum vs ⚡ Öncelik & Derinlik</strong>
            Atlanan içeriklerin saf zevk uyumu (%92) ceza puanıyla düşürülmez; yalnızca seçim önceliği (%82) etkilenir. Kadro kredisi olanlar ✨ Kadro Derinliği rozeti taşır.
          </div>
        </div>
      </div>
    </div>
  );
};

export default TasteMapView;

