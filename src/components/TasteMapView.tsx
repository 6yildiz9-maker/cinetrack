import React, { useState, useMemo } from 'react';
import {
  PersistentTasteMapData,
  TasteRing,
  TasteMapEntry,
  TasteProfileSummary,
  getTasteRingLabel,
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
}) => {
  const [selectedRing, setSelectedRing] = useState<TasteRing>('ring0');
  const [mediaFilter, setMediaFilter] = useState<'all' | 'movie' | 'tv'>('all');

  const entriesList = useMemo(() => {
    return Object.values(tasteMap?.entries || {});
  }, [tasteMap]);

  // Ring counts
  const ringCounts = useMemo(() => {
    const counts: Record<string, number> = { ring0: 0, ring1: 0, ring2: 0 };
    for (const e of entriesList) {
      const norm = normalizeTasteRing(e.ring);
      counts[norm] = (counts[norm] || 0) + 1;
    }
    return counts;
  }, [entriesList]);

  // Filtered entries for selected ring
  const activeRingEntries = useMemo(() => {
    return entriesList
      .filter((e) => {
        const norm = normalizeTasteRing(e.ring);
        const targetNorm = normalizeTasteRing(selectedRing);
        if (norm !== targetNorm) return false;
        if (mediaFilter === 'all') return true;
        return e.mediaType === mediaFilter;
      })
      .sort((a, b) => b.matchScore - a.matchScore);
  }, [entriesList, selectedRing, mediaFilter]);

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
              <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold ${
                isDemo
                  ? 'bg-amber-500/15 border border-amber-500/30 text-amber-300'
                  : 'bg-emerald-500/15 border border-emerald-500/30 text-emerald-300'
              }`}>
                <span className={`w-2 h-2 rounded-full ${isDemo ? 'bg-amber-400' : 'bg-emerald-400'}`}></span>
                <span>{isDemo ? '🟡 Demo Modu (Örnek Havuz)' : '🟢 Canlı Profil (Kişisel Veri)'}</span>
              </span>
              <span>·</span>
              <span className="flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-emerald-400"></span>
                <span>Haritalanan Aday: <strong className="text-slate-200">{entriesList.length}</strong> (500 Film + 500 Dizi)</span>
              </span>
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
                <span className="font-semibold text-rose-300">2 Atlamada 1 Halka Gerileme</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* 4 Konsantrik Halka Seçici */}
      <div className="space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h2 className="text-xl font-bold text-white flex items-center gap-2">
              <span>Konsantrik Zevk Halkaları</span>
            </h2>
            <p className="text-xs text-slate-400">
              Yapımlar zevk uyumluluğuna ve atlanma geçmişine göre halkalara yerleşir
            </p>
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
            <p className="text-sm text-slate-300 font-medium">Bu halkada henüz aday bulunmuyor.</p>
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

                    {/* Uyum Rozeti */}
                    <div className="absolute top-2 left-2 z-10">
                      <span className="bg-rose-600/90 backdrop-blur-md text-white text-[11px] font-bold px-2 py-0.5 rounded shadow">
                        🎯 %{entry.matchScore}
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

                    {/* Gösterim & Halka Durumu */}
                    <div className="text-[10px] text-slate-400 pt-1 flex items-center justify-between">
                      <span>👁️ {entry.shownCount || 0} gösterim</span>
                      {normalizeTasteRing(entry.ring) === 'ring0' ? (
                        <span className="text-emerald-400 font-medium">🌟 Yeni</span>
                      ) : normalizeTasteRing(entry.ring) === 'ring1' ? (
                        <span className="text-amber-400 font-medium">⏳ Dinleniyor</span>
                      ) : (
                        <span className="text-sky-400 font-medium">🔄 Yedek ({entry.skippedCount || 1}x)</span>
                      )}
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </div>

      {/* Mimari Açıklama Kartı */}
      <div className="bg-slate-900/60 border border-slate-800/80 rounded-2xl p-6 text-xs text-slate-400 space-y-2">
        <h4 className="font-bold text-slate-200 text-sm flex items-center gap-2">
          <span>ℹ️ Halka Sistemi ve Zevk Haritası Mimarisi Nasıl Çalışır?</span>
        </h4>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 pt-2">
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
        </div>
      </div>
    </div>
  );
};
