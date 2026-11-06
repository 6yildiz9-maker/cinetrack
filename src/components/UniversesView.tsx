import React, { useState, useMemo } from 'react';
import {
  SavedItem,
  Preferences,
  FavoriteActorInfo,
  PoolCandidateItem,
} from '../core/cinetrack-core';
import {
  computeUserSeriesUniverses,
  UserSeriesUniverse,
} from '../services/series-service';
import { RelationshipExplorer } from './RelationshipExplorer';

interface UniversesViewProps {
  profileId: string;
  savedItems: SavedItem[];
  preferences: Preferences;
  favoriteActors?: FavoriteActorInfo[];
  genreNames?: Record<number, string>;
  onRefreshGraph: (mediaFilter: any) => Promise<PoolCandidateItem[]>;
  onOpenDetails: (item: any) => void;
  onQuickSave: (item: any) => void;
}

export type UniversesSubTab =
  | 'franchises'
  | 'connections'
  | 'cast-network'
  | 'taste-graph'
  | 'blind-spots';

interface CuratedFranchise {
  id: string;
  name: string;
  universe: string;
  backdrop: string;
  description: string;
  sampleItems: Array<{ title: string; year: string; poster?: string; status?: string }>;
}

export const UniversesView: React.FC<UniversesViewProps> = ({
  profileId,
  savedItems,
  preferences,
  favoriteActors = [],
  genreNames = {},
  onRefreshGraph,
  onOpenDetails,
  onQuickSave,
}) => {
  const [activeSubTab, setActiveSubTab] = useState<UniversesSubTab>('franchises');

  // Compute actual series universes from user's watchlist/watched
  const userUniverses = useMemo<UserSeriesUniverse[]>(() => {
    try {
      return computeUserSeriesUniverses(savedItems, {
        includeStubs: true,
        dislikedKeys: preferences.disliked,
      });
    } catch {
      return [];
    }
  }, [savedItems, preferences.disliked]);

  // Major legendary franchises catalogue
  const curatedFranchises: CuratedFranchise[] = useMemo(() => [
    {
      id: 'dune',
      name: 'Dune Evreni',
      universe: 'Frank Herbert / Denis Villeneuve',
      backdrop: 'https://image.tmdb.org/t/p/w1280/lzWHmY2F6BLLIIL5Wzp6g61pswh.jpg',
      description: 'Arrakis çöl gezegeninde baharat ve imparatorluk hegemonyası savaşı.',
      sampleItems: [
        { title: 'Dune: Çöl Gezegeni', year: '2021', poster: '/d5NXSklXo0qyIYkgV94XAgMIckC.jpg', status: 'completed' },
        { title: 'Dune: Bölüm İki', year: '2024', poster: '/1pdfLvkbY9ohJlCjQH2CZjjYVvJ.jpg', status: 'completed' },
        { title: 'Dune: Kehanet', year: '2024', poster: '/x65zVb5B9vJgQ3j8E54Vj9X5h5K.jpg', status: 'watchlist' },
      ],
    },
    {
      id: 'lotr',
      name: 'Orta Dünya (Middle-earth)',
      universe: 'J.R.R. Tolkien / Peter Jackson',
      backdrop: 'https://image.tmdb.org/t/p/w1280/x2RS3uTcsJJ9Ifj2z82Aq6gQxPG.jpg',
      description: 'Tek Yüzük, Mordor ve Üçüncü Çağ efsanesi.',
      sampleItems: [
        { title: 'Yüzüklerin Efendisi: Yüzük Kardeşliği', year: '2001', poster: '/6oom5QYQ2yQTMJIbnvbkBL9cDK6.jpg', status: 'completed' },
        { title: 'Yüzüklerin Efendisi: İki Kule', year: '2002', poster: '/rrGlNlzFTrXFNGHXsB6Mm949IR.jpg', status: 'completed' },
        { title: 'Yüzüklerin Efendisi: Kralın Dönüşü', year: '2003', poster: '/rCzpDGLbOoPwLjy3OAm5NUPOTrC.jpg', status: 'completed' },
      ],
    },
    {
      id: 'mcu',
      name: 'Marvel Sinematik Evreni (MCU)',
      universe: 'Marvel Studios / Kevin Feige',
      backdrop: 'https://image.tmdb.org/t/p/w1280/mDfGiamx5B9ThapAhA7BsVH3z7v.jpg',
      description: 'Sonsuzluk Taşları, Çoklu Evren ve kahramanlar panteonu.',
      sampleItems: [
        { title: 'Iron Man', year: '2008', poster: '/78lPtwv72eTNqFW9COBYI0dWDJa.jpg' },
        { title: 'Yenilmezler: Sonsuzluk Savaşı', year: '2018', poster: '/7WsyChQLEftFiDOVTGkv3hFpyyt.jpg' },
        { title: 'Loki', year: '2021', poster: '/voHUmluznx9whflFz8vgVlsUR4e.jpg' },
      ],
    },
    {
      id: 'batman',
      name: 'Gotham & Kara Şövalye',
      universe: 'DC / Christopher Nolan & Matt Reeves',
      backdrop: 'https://image.tmdb.org/t/p/w1280/hkBaDkMWbLaf8B1lsWsKX7Ew3Xq.jpg',
      description: 'Gotham sokaklarındaki suç ve psikolojik adalet savaşı.',
      sampleItems: [
        { title: 'Kara Şövalye', year: '2008', poster: '/qJ2tW6WMUDux911r6m7haRef0WH.jpg' },
        { title: 'The Batman', year: '2022', poster: '/74xTEgt7R36Fpooo50r9T25onhq.jpg' },
        { title: 'The Penguin', year: '2024', poster: '/aV5m8zE7Fq4V3qZp5dM0t9B1Z8r.jpg' },
      ],
    },
    {
      id: 'alien',
      name: 'Alien & Predator Evreni',
      universe: 'Ridley Scott / James Cameron',
      backdrop: 'https://image.tmdb.org/t/p/w1280/8ZTVqvKDQ8emSGUEMjsS4yHAwrp.jpg',
      description: 'Derin uzayda biyomekanik dehşet ve hayatta kalma mücadelesi.',
      sampleItems: [
        { title: 'Alien', year: '1979', poster: '/vfrQk5IPloGg1v9Rzbh2Eg3VGyM.jpg' },
        { title: 'Aliens', year: '1986', poster: '/mJC18B34wZfKj9bQx6eN1fQWd7V.jpg' },
        { title: 'Alien: Romulus', year: '2024', poster: '/b33nnKl1GSFbao8l3urDDgr4YxF.jpg' },
      ],
    },
    {
      id: 'blade-runner',
      name: 'Blade Runner Evreni',
      universe: 'Philip K. Dick / Ridley Scott & Denis Villeneuve',
      backdrop: 'https://image.tmdb.org/t/p/w1280/sAtoMqDVhNDQBc3QJL3RF6hlxGq.jpg',
      description: 'Replikantlar, anılar ve insaniyetin siberpunk sınırları.',
      sampleItems: [
        { title: 'Blade Runner', year: '1982', poster: '/63N9uy8nd9j7Eog2axPQ855q7Z2.jpg' },
        { title: 'Blade Runner 2049', year: '2017', poster: '/gajva2L0rPYkEWjzgFlBXCAVBE5.jpg' },
      ],
    },
  ], []);

  // Blind spots / Keşif Alanları data
  const blindSpots = useMemo(() => [
    {
      id: 'bs-1',
      title: '70’ler Amerikan Yeni Dalgası (New Hollywood)',
      era: '1967 - 1980',
      reason: 'Listenizdeki modern yönetmenlerin ilham aldığı auteur dönemi.',
      representative: ['Taksi Şoförü (1976)', 'Kıyamet (Apocalypse Now)', 'Çin Mahallesi'],
      color: '#d3b579',
    },
    {
      id: 'bs-2',
      title: 'Kore Sinemasının Altın Çağı & İntikam Üçlemesi',
      era: '2000 - 2015',
      reason: 'Karanlık gerilim zevkinizle %94 örtüşen ama listenizde az yer bulan coğrafya.',
      representative: ['İhtiyar Delikanlı (Oldboy)', 'Cinayet Günlüğü (Memories of Murder)', 'Şüphe (Burning)'],
      color: '#63b8ab',
    },
    {
      id: 'bs-3',
      title: 'Alman Dışavurumculuğu & Erken Dönem Gölge Estetiği',
      era: '1920 - 1935',
      reason: 'Sevdiğiniz neon-noir ve klostrofobik stillerin kökeni.',
      representative: ['Metropolis', 'Dr. Caligari’nin Muayenehanesi', 'M (Bir Şehir Katilini Arıyor)'],
      color: '#a58fd0',
    },
    {
      id: 'bs-4',
      title: 'Japon Siberpunk & Beden Dehşeti',
      era: '1988 - 1999',
      reason: 'Yüksek teknoloji distopya kavramlarını felsefi derinlikle işleyen kült akım.',
      representative: ['Akira', 'Ghost in the Shell', 'Tetsuo: The Iron Man'],
      color: '#e0645e',
    },
  ], []);

  return (
    <div className="universes-view w-full max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-8 animate-fade-in text-slate-100">
      {/* Universes Header & Sub-Nav */}
      <div className="flex flex-wrap items-center justify-between gap-4 pb-2 border-b border-white/10">
        <div>
          <span className="text-[11px] font-semibold uppercase tracking-widest text-cinema-purple">
            Sinematik Evrenler & Bağlantı Ağları
          </span>
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-cinema-textPrimary flex items-center gap-2">
            <span>🌐 Evrenler</span>
            <span className="text-xs px-2.5 py-1 rounded-full bg-cinema-purple/10 text-cinema-purple border border-cinema-purple/30 font-medium">
              Çok Boyutlu Ağ
            </span>
          </h1>
        </div>

        {/* 5 Sub-Tabs Navigation */}
        <div className="flex items-center gap-1 p-1 rounded-2xl bg-cinema-surface border border-white/7 backdrop-blur-md overflow-x-auto max-w-full">
          <button
            type="button"
            className={`px-3.5 py-2 rounded-xl text-xs sm:text-sm font-semibold transition-all whitespace-nowrap cursor-pointer ${
              activeSubTab === 'franchises'
                ? 'bg-cinema-purple/15 text-cinema-purple border border-cinema-purple/40 shadow-[0_0_15px_rgba(165,143,208,0.18)]'
                : 'text-cinema-textMuted hover:text-cinema-textPrimary'
            }`}
            onClick={() => setActiveSubTab('franchises')}
          >
            🌌 Franchise / Koleksiyonlar
          </button>
          <button
            type="button"
            className={`px-3.5 py-2 rounded-xl text-xs sm:text-sm font-semibold transition-all whitespace-nowrap cursor-pointer ${
              activeSubTab === 'connections'
                ? 'bg-cinema-purple/15 text-cinema-purple border border-cinema-purple/40 shadow-[0_0_15px_rgba(165,143,208,0.18)]'
                : 'text-cinema-textMuted hover:text-cinema-textPrimary'
            }`}
            onClick={() => setActiveSubTab('connections')}
          >
            🎭 Seri Bağlantıları
          </button>
          <button
            type="button"
            className={`px-3.5 py-2 rounded-xl text-xs sm:text-sm font-semibold transition-all whitespace-nowrap cursor-pointer ${
              activeSubTab === 'cast-network'
                ? 'bg-cinema-purple/15 text-cinema-purple border border-cinema-purple/40 shadow-[0_0_15px_rgba(165,143,208,0.18)]'
                : 'text-cinema-textMuted hover:text-cinema-textPrimary'
            }`}
            onClick={() => setActiveSubTab('cast-network')}
          >
            👥 Oyuncu & Yönetmen Ağı
          </button>
          <button
            type="button"
            className={`px-3.5 py-2 rounded-xl text-xs sm:text-sm font-semibold transition-all whitespace-nowrap cursor-pointer ${
              activeSubTab === 'taste-graph'
                ? 'bg-cinema-purple/15 text-cinema-purple border border-cinema-purple/40 shadow-[0_0_15px_rgba(165,143,208,0.18)]'
                : 'text-cinema-textMuted hover:text-cinema-textPrimary'
            }`}
            onClick={() => setActiveSubTab('taste-graph')}
          >
            🕸️ Zevk Ağı (2D Grafik)
          </button>
          <button
            type="button"
            className={`px-3.5 py-2 rounded-xl text-xs sm:text-sm font-semibold transition-all whitespace-nowrap cursor-pointer ${
              activeSubTab === 'blind-spots'
                ? 'bg-cinema-purple/15 text-cinema-purple border border-cinema-purple/40 shadow-[0_0_15px_rgba(165,143,208,0.18)]'
                : 'text-cinema-textMuted hover:text-cinema-textPrimary'
            }`}
            onClick={() => setActiveSubTab('blind-spots')}
          >
            🔍 Keşif Alanları
          </button>
        </div>
      </div>

      {/* SUB-TAB 1: FRANCHISE / KOLEKSİYONLAR */}
      {activeSubTab === 'franchises' && (
        <div className="space-y-6">
          <div className="flex items-center justify-between">
            <p className="text-xs text-cinema-textMuted">
              Kült sinema evrenleri, çok parçalı sagalar ve izleme listenizdeki koleksiyon bağlantıları.
            </p>
            <span className="text-xs text-cinema-purple font-mono">
              {curatedFranchises.length} Büyük Evren
            </span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {curatedFranchises.map((f) => (
              <div
                key={f.id}
                className="group relative rounded-3xl overflow-hidden bg-cinema-surface border border-white/7 hover:border-cinema-purple/40 transition-all duration-300 shadow-xl flex flex-col justify-between"
              >
                {/* Backdrop header */}
                <div className="relative h-44 w-full overflow-hidden bg-[#0a0b0e]">
                  <img
                    src={f.backdrop}
                    alt={f.name}
                    className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500 opacity-60"
                  />
                  <div className="absolute inset-0 bg-gradient-to-t from-[#0a0b0e] via-[#0a0b0e]/40 to-transparent" />
                  <div className="absolute bottom-3 left-4 right-4">
                    <span className="text-[10px] font-mono tracking-wider uppercase px-2 py-0.5 rounded bg-cinema-purple/15 text-cinema-purple border border-cinema-purple/30">
                      {f.universe}
                    </span>
                    <h3 className="text-xl font-bold text-cinema-textPrimary mt-1 group-hover:text-cinema-purple transition-colors">
                      {f.name}
                    </h3>
                  </div>
                </div>

                {/* Content body */}
                <div className="p-5 space-y-4 flex-1 flex flex-col justify-between">
                  <p className="text-xs text-cinema-textMuted leading-relaxed">
                    {f.description}
                  </p>

                  <div className="space-y-2 pt-2 border-t border-white/5">
                    <span className="text-[11px] font-semibold text-cinema-textMuted uppercase tracking-wider">
                      Önemli Parçalar:
                    </span>
                    <div className="space-y-1.5">
                      {f.sampleItems.map((item, idx) => (
                        <div
                          key={idx}
                          className="flex items-center justify-between text-xs py-1 px-2.5 rounded-lg bg-[#0a0b0e]/60 border border-white/5"
                        >
                          <span className="text-cinema-textPrimary truncate pr-2 font-medium">
                            {item.title}
                          </span>
                          <span className="text-[10px] font-mono text-cinema-textMuted shrink-0">
                            {item.year}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* SUB-TAB 2: SERİ BAĞLANTILARI */}
      {activeSubTab === 'connections' && (
        <div className="space-y-6">
          <div className="p-5 rounded-2xl bg-cinema-surface border border-white/7 flex flex-wrap items-center justify-between gap-4">
            <div>
              <h3 className="font-bold text-cinema-textPrimary">İzleme Listenizdeki Seri Evrenleri</h3>
              <p className="text-xs text-cinema-textMuted mt-1">
                Listenize eklediğiniz veya izlediğiniz filmlerin devam halkaları, öncülleri (prequels) ve eksik parçaları.
              </p>
            </div>
            <span className="px-3 py-1 rounded-xl bg-cinema-purple/15 text-cinema-purple border border-cinema-purple/30 text-xs font-mono">
              {userUniverses.length} Aktif Seri Tespit Edildi
            </span>
          </div>

          {userUniverses.length === 0 ? (
            <div className="p-12 text-center rounded-3xl bg-cinema-surface border border-white/5 space-y-3">
              <span className="text-3xl">🎭</span>
              <h4 className="text-base font-semibold text-cinema-textPrimary">Henüz Seri Bağlantısı Bulunmuyor</h4>
              <p className="text-xs text-cinema-textMuted max-w-md mx-auto">
                Listenize çok parçalı filmler (örneğin Dune, Matrix, Yüzüklerin Efendisi, Kara Şövalye) eklediğinizde eksik halkalar otomatik olarak burada sıralanacaktır.
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              {userUniverses.map((u, idx) => (
                <div
                  key={idx}
                  className="p-5 rounded-2xl bg-cinema-surface border border-white/7 space-y-3 hover:border-cinema-purple/30 transition-all"
                >
                  <div className="flex items-center justify-between">
                    <h4 className="font-bold text-cinema-textPrimary text-base">{u.displayName || u.collection?.name || 'Seri'}</h4>
                    <span className="text-xs text-cinema-textMuted">
                      {u.userOwnedParts.length} İzlenen / {u.userOwnedParts.length + u.userMissingParts.length} Toplam
                    </span>
                  </div>

                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-2">
                    {u.userOwnedParts.map((p, pIdx) => (
                      <div
                        key={pIdx}
                        className="p-2.5 rounded-xl bg-[#0a0b0e]/70 border border-[#6fbf8a]/35 text-xs"
                      >
                        <div className="text-[10px] text-[#6fbf8a] font-semibold mb-1">✓ Listenizde</div>
                        <div className="font-medium text-cinema-textPrimary truncate">{p.title || p.name}</div>
                        <div className="text-[10px] text-cinema-textMuted mt-0.5">
                          {p.release_date?.slice(0, 4) || p.first_air_date?.slice(0, 4) || ''}
                        </div>
                      </div>
                    ))}
                    {u.userMissingParts.map((p, pIdx) => (
                      <div
                        key={pIdx}
                        onClick={() => onOpenDetails(p)}
                        className="p-2.5 rounded-xl bg-[#0a0b0e]/40 border border-cinema-gold/35 hover:border-cinema-gold text-xs cursor-pointer transition-colors"
                      >
                        <div className="text-[10px] text-cinema-gold font-semibold mb-1">⏳ Eksik Halka (İncele)</div>
                        <div className="font-medium text-cinema-textPrimary truncate">{p.title || p.name}</div>
                        <div className="text-[10px] text-cinema-textMuted mt-0.5">
                          {p.release_date?.slice(0, 4) || p.first_air_date?.slice(0, 4) || ''}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* SUB-TAB 3: OYUNCU & YÖNETMEN AĞI */}
      {activeSubTab === 'cast-network' && (
        <div className="space-y-6">
          <div className="p-5 rounded-2xl bg-cinema-surface border border-white/7 flex items-center justify-between">
            <div>
              <h3 className="font-bold text-cinema-textPrimary">Yaratıcı Zihinler & Oyuncu Kümeleri</h3>
              <p className="text-xs text-cinema-textMuted mt-1">
                Listenizdeki yapımları birbirine bağlayan favori oyuncularınız ve yönetmen iş birlikleri.
              </p>
            </div>
            <span className="text-xs font-mono text-cinema-cyan">
              {favoriteActors.length} Favori Oyuncu Takipte
            </span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {favoriteActors.map((actor) => (
              <div
                key={actor.id}
                className="p-4 rounded-2xl bg-cinema-surface border border-white/7 hover:border-cinema-cyan/35 transition-all flex items-center gap-4"
              >
                <div className="w-14 h-14 rounded-full overflow-hidden bg-[#0a0b0e] shrink-0 border border-white/7">
                  {actor.profile_path ? (
                    <img
                      src={`https://image.tmdb.org/t/p/w185${actor.profile_path}`}
                      alt={actor.name}
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-cinema-textMuted text-lg">
                      👤
                    </div>
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <h4 className="font-bold text-cinema-textPrimary truncate text-sm">{actor.name}</h4>
                  <div className="text-xs text-cinema-textMuted mt-0.5">
                    {actor.known_for_department || 'Oyunculuk'}
                  </div>
                  <span className="inline-block mt-1 text-[10px] text-cinema-cyan font-mono">
                    ★ Ağ Merkezinde
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* SUB-TAB 4: ZEVK AĞI (INTERACTIVE 2D FORCE-GRAPH) */}
      {activeSubTab === 'taste-graph' && (
        <div className="space-y-4">
          <div className="p-4 rounded-2xl bg-cinema-surface border border-white/7 text-xs text-cinema-textMuted flex items-center justify-between">
            <span>
              <strong className="text-cinema-textPrimary">İnteraktif Zevk Ağı:</strong> Düğümler arasındaki mesafeler tür, yönetmen, oyuncu ve içerik vektörü benzerliğini ifade eder. Düğümlere tıklayarak yapım detaylarına ulaşabilirsiniz.
            </span>
          </div>

          <div className="rounded-3xl overflow-hidden border border-white/7 bg-[#0a0b0e] shadow-2xl min-h-[600px]">
            <RelationshipExplorer
              mode="relationships"
              profileId={profileId}
              savedItems={savedItems}
              preferences={preferences}
              candidates={[]}
              favoriteActors={favoriteActors}
              genreNames={genreNames}
              onRefresh={onRefreshGraph}
              onOpenDetails={onOpenDetails}
              onQuickSave={onQuickSave}
            />
          </div>
        </div>
      )}

      {/* SUB-TAB 5: KEŞİF ALANLARI (BLIND SPOTS) */}
      {activeSubTab === 'blind-spots' && (
        <div className="space-y-6">
          <div className="p-5 rounded-2xl bg-cinema-surface border border-white/7">
            <h3 className="font-bold text-cinema-textPrimary">Keşfedilmemiş Sinematik Topraklar (Kör Noktalar)</h3>
            <p className="text-xs text-cinema-textMuted mt-1">
              Listenizdeki yoğunluk haritasına göre ilgi duyabileceğiniz ancak henüz derinlemesine adım atmadığınız dönemler ve sinema akımları.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {blindSpots.map((spot) => (
              <div
                key={spot.id}
                className="p-6 rounded-3xl bg-cinema-surface border border-white/7 hover:border-cinema-gold/30 transition-all space-y-4"
              >
                <div className="flex items-center justify-between">
                  <span
                    className="text-[10px] font-mono px-2 py-0.5 rounded border font-semibold"
                    style={{ borderColor: `${spot.color}40`, color: spot.color, backgroundColor: `${spot.color}15` }}
                  >
                    {spot.era}
                  </span>
                  <span className="text-xs text-cinema-textMuted">Keşif Potansiyeli: %92</span>
                </div>

                <h4 className="text-lg font-bold text-cinema-textPrimary">{spot.title}</h4>
                <p className="text-xs text-cinema-textMuted leading-relaxed">{spot.reason}</p>

                <div className="pt-2 border-t border-white/5 space-y-2">
                  <span className="text-[11px] font-semibold text-cinema-textMuted uppercase tracking-wider">
                    Örnek Başlangıç Yapımları:
                  </span>
                  <div className="flex flex-wrap gap-2">
                    {spot.representative.map((r, i) => (
                      <span
                        key={i}
                        className="text-xs px-2.5 py-1 rounded-lg bg-[#0a0b0e] border border-white/7 text-cinema-textPrimary"
                      >
                        {r}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default UniversesView;
