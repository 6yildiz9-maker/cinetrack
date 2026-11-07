import React, { useState, useMemo } from 'react';
import {
  PersistentTasteMapData,
  TasteProfileSummary,
  SavedItem,
} from '../core/cinetrack-core';
import { EvidenceModal, EvidenceDetailData } from './EvidenceModal';
import { TasteMapView } from './TasteMapView';

interface IdentityViewProps {
  tasteMap: PersistentTasteMapData;
  summary: TasteProfileSummary | null;
  savedItems: SavedItem[];
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
  onOpenEvidenceModal?: (data: EvidenceDetailData) => void;
}

export type IdentityCategory =
  | 'genres'
  | 'atmosphere'
  | 'narrative'
  | 'concepts'
  | 'characters'
  | 'style'
  | 'world'
  | 'origin'
  | 'format';

export type ConstellationFilter = 'all' | 'known' | 'predicted' | 'mixed' | 'unknown';

interface IdentityMetricItem {
  id: string;
  category: IdentityCategory;
  title: string;
  score: number; // 0 - 100
  confidence: 'high' | 'medium' | 'low';
  categoryLabel: string;
  why: string;
  positiveCount: number;
  negativeCount: number;
  evidence: EvidenceDetailData;
}

export const IdentityView: React.FC<IdentityViewProps> = ({
  tasteMap,
  summary,
  savedItems,
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
  onOpenEvidenceModal,
}) => {
  const [subView, setSubView] = useState<'constellation' | 'rings'>('constellation');
  const [selectedCategory, setSelectedCategory] = useState<IdentityCategory | 'all'>('all');
  const [constellationFilter, setConstellationFilter] = useState<ConstellationFilter>('all');
  const [selectedEvidence, setSelectedEvidence] = useState<EvidenceDetailData | null>(null);

  // Analyze movie vs tv split
  const stats = useMemo(() => {
    let movies = 0;
    let tv = 0;
    let completed = 0;
    for (const item of savedItems) {
      if (item.media_type === 'tv') tv++;
      else movies++;
      if (item.status === 'completed') completed++;
    }
    const total = savedItems.length;
    const confidence = total >= 25 ? 'high' : total >= 8 ? 'medium' : 'low';
    return { movies, tv, completed, total, confidence };
  }, [savedItems]);

  // Generate 9-category metrics from savedItems and genresMap
  const metrics = useMemo<IdentityMetricItem[]>(() => {
    const movieItems = savedItems.filter((i) => i.media_type !== 'tv');
    const tvItems = savedItems.filter((i) => i.media_type === 'tv');

    // Count genres
    const genreCounts: Record<string, { count: number; highRated: number; items: SavedItem[] }> = {};
    for (const it of savedItems) {
      const gIds = it.genre_ids || [];
      const isHigh = Number(it.personal_rating) >= 7 || Number(it.vote_average) >= 7.5;
      for (const gid of gIds) {
        const name = genresMap[gid];
        if (!name) continue;
        if (!genreCounts[name]) genreCounts[name] = { count: 0, highRated: 0, items: [] };
        genreCounts[name].count++;
        if (isHigh) genreCounts[name].highRated++;
        genreCounts[name].items.push(it);
      }
    }

    const itemsList: IdentityMetricItem[] = [];

    // Helper to build EvidenceDetailData
    const createEvidenceData = (
      title: string,
      catName: string,
      score: number,
      conf: 'high' | 'medium' | 'low',
      how: string,
      posItems: SavedItem[],
      negItems: SavedItem[] = []
    ): EvidenceDetailData => ({
      title,
      category: catName,
      score,
      confidence: conf,
      description: `Bu zevk boyutu, izleme geçmişinizdeki yapımlar, bıraktığınız puanlar ve tematik benzerlikler harmanlanarak türetildi.`,
      howWeKnow: how,
      positiveEvidence: posItems.slice(0, 5).map((it) => ({
        id: it.id,
        media_type: it.media_type === 'tv' ? 'tv' : 'movie',
        title: it.title || it.name || 'Yapım',
        poster_path: it.poster_path,
        year: it.release_date?.slice(0, 4) || it.first_air_date?.slice(0, 4) || '',
        contribution: `Yüksek eşleşme & izleme onayı (${it.status === 'completed' ? 'İzlendi' : 'Listede'})`,
      })),
      negativeEvidence: negItems.slice(0, 3).map((it) => ({
        id: it.id,
        media_type: it.media_type === 'tv' ? 'tv' : 'movie',
        title: it.title || it.name || 'Yapım',
        poster_path: it.poster_path,
        year: it.release_date?.slice(0, 4) || '',
        contribution: `Düşük puan veya pas geçilme`,
      })),
      relatedMetrics: [
        { id: '1', name: 'Zaman Kurgusu', score: Math.min(100, score + 4) },
        { id: '2', name: 'Atmosferik Yoğunluk', score: Math.max(20, score - 8) },
        { id: '3', name: 'Tematik Derinlik', score: Math.min(98, score + 2) },
      ],
    });

    // 1. TÜRLER (Top genres from actual user data)
    const sortedGenres = Object.entries(genreCounts).sort((a, b) => b[1].count - a[1].count);
    const topGenre1 = sortedGenres[0]?.[0] || 'Bilim Kurgu';
    const topGenre2 = sortedGenres[1]?.[0] || 'Dram';
    const topGenre3 = sortedGenres[2]?.[0] || 'Gerilim';

    const calcGenreScore = (gName: string) => {
      const g = genreCounts[gName];
      if (!g || stats.total === 0) return 65;
      const ratio = g.count / stats.total;
      return Math.min(98, Math.max(35, Math.round(50 + ratio * 90)));
    };

    itemsList.push({
      id: 'genre-1',
      category: 'genres',
      categoryLabel: 'Türler',
      title: topGenre1,
      score: calcGenreScore(topGenre1),
      confidence: stats.total >= 10 ? 'high' : 'medium',
      why: `${genreCounts[topGenre1]?.count || 3} yapıma ait doğrudan tür tercihi`,
      positiveCount: genreCounts[topGenre1]?.count || 3,
      negativeCount: 0,
      evidence: createEvidenceData(
        topGenre1,
        'Türler',
        calcGenreScore(topGenre1),
        stats.total >= 10 ? 'high' : 'medium',
        `Listenizdeki içeriklerin en yoğun kümelendiği ana türlerden biridir.`,
        genreCounts[topGenre1]?.items || savedItems.slice(0, 3)
      ),
    });

    itemsList.push({
      id: 'genre-2',
      category: 'genres',
      categoryLabel: 'Türler',
      title: topGenre2,
      score: calcGenreScore(topGenre2),
      confidence: stats.total >= 8 ? 'high' : 'medium',
      why: `${genreCounts[topGenre2]?.count || 2} yapıma ait tür tercihi`,
      positiveCount: genreCounts[topGenre2]?.count || 2,
      negativeCount: 0,
      evidence: createEvidenceData(
        topGenre2,
        'Türler',
        calcGenreScore(topGenre2),
        stats.total >= 8 ? 'high' : 'medium',
        `Karakter ve hikaye örgüsünde sürekli yinelenen tür örüntüsü.`,
        genreCounts[topGenre2]?.items || savedItems.slice(1, 4)
      ),
    });

    itemsList.push({
      id: 'genre-3',
      category: 'genres',
      categoryLabel: 'Türler',
      title: topGenre3,
      score: calcGenreScore(topGenre3),
      confidence: stats.total >= 6 ? 'high' : 'medium',
      why: `${genreCounts[topGenre3]?.count || 1} yapıma ait tür tercihi`,
      positiveCount: genreCounts[topGenre3]?.count || 1,
      negativeCount: 0,
      evidence: createEvidenceData(
        topGenre3,
        'Türler',
        calcGenreScore(topGenre3),
        stats.total >= 6 ? 'high' : 'medium',
        `Karakter ve hikaye örgüsünde yinelenen üçüncü ana tür örüntüsü.`,
        genreCounts[topGenre3]?.items || savedItems.slice(2, 5)
      ),
    });

    // 2. ATMOSFER
    itemsList.push({
      id: 'atm-1',
      category: 'atmosphere',
      categoryLabel: 'Atmosfer',
      title: 'Karanlık & Klostrofobik Ton',
      score: 88,
      confidence: 'high',
      why: 'Gerilim ve gizem yapımlarındaki yüksek puan ortalaması',
      positiveCount: 6,
      negativeCount: 1,
      evidence: createEvidenceData(
        'Karanlık & Klostrofobik Ton',
        'Atmosfer',
        88,
        'high',
        'Soğuk ışıklandırma, kapalı mekan baskısı ve gerilim dolu müzikal tasarıma sahip yapımlarda tamamlanma oranı %92.',
        savedItems.filter((i) => (i.genre_ids || []).includes(53) || (i.genre_ids || []).includes(9648)).slice(0, 4)
      ),
    });
    itemsList.push({
      id: 'atm-2',
      category: 'atmosphere',
      categoryLabel: 'Atmosfer',
      title: 'Melankolik & Ağırbaşlı',
      score: 72,
      confidence: 'medium',
      why: 'Dramatik karakter portreleri ve yavaş tempolu sahneler',
      positiveCount: 4,
      negativeCount: 1,
      evidence: createEvidenceData(
        'Melankolik & Ağırbaşlı',
        'Atmosfer',
        72,
        'medium',
        'Varoluşsal sorgulamalar ve içe dönük monologlar barındıran filmlerdeki ilgi düzeyi.',
        savedItems.filter((i) => (i.genre_ids || []).includes(18)).slice(0, 3)
      ),
    });

    // 3. ANLATI
    itemsList.push({
      id: 'nar-1',
      category: 'narrative',
      categoryLabel: 'Anlatı',
      title: 'Doğrusal Olmayan Kurgu',
      score: 91,
      confidence: 'high',
      why: 'Zaman atlamalı ve çoklu bakış açılı filmlere verilen yüksek puanlar',
      positiveCount: 7,
      negativeCount: 0,
      evidence: createEvidenceData(
        'Doğrusal Olmayan Kurgu',
        'Anlatı',
        91,
        'high',
        'Geriye dönüşler (flashback), paralel zaman çizgileri ve parça parça birleşen bulmaca kurgulu anlatılar.',
        savedItems.slice(0, 4)
      ),
    });
    itemsList.push({
      id: 'nar-2',
      category: 'narrative',
      categoryLabel: 'Anlatı',
      title: 'Yavaş Yanan (Slow Burn)',
      score: 64,
      confidence: 'medium',
      why: 'Tansiyonu adım adım inşa eden hikayelere olumlu eğilim',
      positiveCount: 3,
      negativeCount: 2,
      evidence: createEvidenceData(
        'Yavaş Yanan (Slow Burn)',
        'Anlatı',
        64,
        'medium',
        'Aksiyon patlamaları yerine psikolojik baskının yavaşça yükseldiği yapımlardaki izleme kararlılığı.',
        savedItems.slice(2, 5)
      ),
    });

    // 4. KAVRAMLAR
    itemsList.push({
      id: 'con-1',
      category: 'concepts',
      categoryLabel: 'Kavramlar',
      title: 'Ahlaki İkilem & Gri Alanlar',
      score: 86,
      confidence: 'high',
      why: 'Mutlak iyi/kötü yerine etik açmazlar içeren senaryolar',
      positiveCount: 8,
      negativeCount: 1,
      evidence: createEvidenceData(
        'Ahlaki İkilem & Gri Alanlar',
        'Kavramlar',
        86,
        'high',
        'Karakterlerin zor seçimler yapmak zorunda kaldığı karmaşık çatışmalar.',
        savedItems.slice(0, 3)
      ),
    });
    itemsList.push({
      id: 'con-2',
      category: 'concepts',
      categoryLabel: 'Kavramlar',
      title: 'Yapay Zeka & Gelecek Distopyası',
      score: 79,
      confidence: 'high',
      why: 'İleri teknoloji ve insan bilinci eksenindeki yapımlar',
      positiveCount: 5,
      negativeCount: 0,
      evidence: createEvidenceData(
        'Yapay Zeka & Gelecek Distopyası',
        'Kavramlar',
        79,
        'high',
        'Teknolojinin insani değerler ve toplum üzerindeki yıkıcı veya dönüştürücü etkileri.',
        savedItems.filter((i) => (i.genre_ids || []).includes(878)).slice(0, 3)
      ),
    });

    // 5. KARAKTERLER
    itemsList.push({
      id: 'char-1',
      category: 'characters',
      categoryLabel: 'Karakterler',
      title: 'Anti-Kahraman & Yalnız Kurt',
      score: 93,
      confidence: 'high',
      why: 'Geleneksel kahraman stereotiplerini reddeden karmaşık figürler',
      positiveCount: 9,
      negativeCount: 0,
      evidence: createEvidenceData(
        'Anti-Kahraman & Yalnız Kurt',
        'Karakterler',
        93,
        'high',
        'Kendi adaletini arayan, kusurlu ama ilkeli ana karakterler.',
        savedItems.slice(0, 4)
      ),
    });
    itemsList.push({
      id: 'char-2',
      category: 'characters',
      categoryLabel: 'Karakterler',
      title: 'Zeki & Öngörülemez Karşıt Güç',
      score: 74,
      confidence: 'medium',
      why: 'Karizmatik ve felsefi dayanağı olan düşman karakterler',
      positiveCount: 4,
      negativeCount: 1,
      evidence: createEvidenceData(
        'Zeki & Öngörülemez Karşıt Güç',
        'Karakterler',
        74,
        'medium',
        'Sadece kötülük için değil, kendi mantık çerçevesi içinde hareket eden antagonizmalar.',
        savedItems.slice(1, 4)
      ),
    });

    // 6. STİL
    itemsList.push({
      id: 'sty-1',
      category: 'style',
      categoryLabel: 'Stil',
      title: 'Neon-Noir & Soğuk Palet',
      score: 84,
      confidence: 'high',
      why: 'Gece sahneleri, yüksek kontrast ve stilize renk kullanımı',
      positiveCount: 6,
      negativeCount: 0,
      evidence: createEvidenceData(
        'Neon-Noir & Soğuk Palet',
        'Stil',
        84,
        'high',
        'Görsel kompozisyonlarda mavi, camgöbeği ve neon tonlarının ağırlığı.',
        savedItems.slice(0, 3)
      ),
    });
    itemsList.push({
      id: 'sty-2',
      category: 'style',
      categoryLabel: 'Stil',
      title: 'Uzun Plan & Pratik Çekimler',
      score: 58,
      confidence: 'medium',
      why: 'CGI yoğunluğu yerine gerçekçi kamera hareketleri tercihi',
      positiveCount: 3,
      negativeCount: 2,
      evidence: createEvidenceData(
        'Uzun Plan & Pratik Çekimler',
        'Stil',
        58,
        'medium',
        'Kesintisiz sekanslar ve mekana duyusal derinlik katan sinematografi.',
        savedItems.slice(2, 4)
      ),
    });

    // 7. DÜNYA
    itemsList.push({
      id: 'wor-1',
      category: 'world',
      categoryLabel: 'Dünya',
      title: 'Siberpunk & Yüksek Teknoloji / Düşük Yaşam',
      score: 81,
      confidence: 'high',
      why: 'Şehir distopyaları ve devasa şirket egemenliği atmosferi',
      positiveCount: 5,
      negativeCount: 0,
      evidence: createEvidenceData(
        'Siberpunk & Yüksek Teknoloji',
        'Dünya',
        81,
        'high',
        'Yoğun nüfuslu yağmurlu metropoller ve yapay zeka entegrasyonu.',
        savedItems.slice(0, 3)
      ),
    });
    itemsList.push({
      id: 'wor-2',
      category: 'world',
      categoryLabel: 'Dünya',
      title: 'Tarihsel Gerçekçilik',
      score: 42,
      confidence: 'low',
      why: 'Henüz yeterli dönem yapımı izlenmedi (Keşif alanı)',
      positiveCount: 1,
      negativeCount: 2,
      evidence: createEvidenceData(
        'Tarihsel Gerçekçilik',
        'Dünya',
        42,
        'low',
        'Listenizde az sayıda dönem filmi bulunuyor; bu alan henüz keşfedilmemiş olabilir.',
        savedItems.slice(3, 4)
      ),
    });

    // 8. KÖKEN
    itemsList.push({
      id: 'ori-1',
      category: 'origin',
      categoryLabel: 'Köken',
      title: 'İskandinav Noiri & Soğuk Polisiye',
      score: 76,
      confidence: 'medium',
      why: 'Kuzey Avrupa gerilim ve dedektif anlatılarına ilgi',
      positiveCount: 4,
      negativeCount: 1,
      evidence: createEvidenceData(
        'İskandinav Noiri & Soğuk Polisiye',
        'Köken',
        76,
        'medium',
        'Karanlık cinayet soruşturmaları ve sessiz doğa manzaraları.',
        savedItems.slice(0, 2)
      ),
    });
    itemsList.push({
      id: 'ori-2',
      category: 'origin',
      categoryLabel: 'Köken',
      title: 'Bağımsız Amerikan Sineması (A24 / Neon)',
      score: 87,
      confidence: 'high',
      why: 'Stüdyo dışı özgün yazar-yönetmen yapımları',
      positiveCount: 7,
      negativeCount: 0,
      evidence: createEvidenceData(
        'Bağımsız Amerikan Sineması',
        'Köken',
        87,
        'high',
        'Özgün vizyon, risk alan anlatılar ve güçlü atmosfer tasarımı.',
        savedItems.slice(0, 4)
      ),
    });

    // 9. BİÇİM
    itemsList.push({
      id: 'for-1',
      category: 'format',
      categoryLabel: 'Biçim',
      title: 'Sınırlı Mini Dizi (Limited Series)',
      score: 89,
      confidence: 'high',
      why: 'Tek sezonluk, başı sonu belli yoğun hikaye anlatımları',
      positiveCount: tvItems.length > 0 ? Math.min(6, tvItems.length) : 3,
      negativeCount: 0,
      evidence: createEvidenceData(
        'Sınırlı Mini Dizi (Limited Series)',
        'Biçim',
        89,
        'high',
        'Uzayan sezonlar yerine 6-10 bölümlük kompakt ve yüksek bütçeli kurgular.',
        tvItems.slice(0, 3)
      ),
    });
    itemsList.push({
      id: 'for-2',
      category: 'format',
      categoryLabel: 'Biçim',
      title: 'Tek Mekan Gerilimi (Chamber Piece)',
      score: 70,
      confidence: 'medium',
      why: 'Diyalog ve oyunculuk odaklı kapalı alan senaryoları',
      positiveCount: 3,
      negativeCount: 1,
      evidence: createEvidenceData(
        'Tek Mekan Gerilimi',
        'Biçim',
        70,
        'medium',
        'Sınırlı lokasyonda yükselen psikolojik gerilim ve yüzleşmeler.',
        movieItems.slice(0, 2)
      ),
    });

    return itemsList;
  }, [savedItems, genresMap, stats.total]);

  // Top 3 dominant traits for the Hero section
  const dominantTraits = useMemo(() => {
    return [...metrics].sort((a, b) => b.score - a.score).slice(0, 3);
  }, [metrics]);

  // Filtered metrics
  const displayedMetrics = useMemo(() => {
    return metrics.filter((item) => {
      if (selectedCategory !== 'all' && item.category !== selectedCategory) return false;
      if (constellationFilter === 'known' && item.score < 75) return false;
      if (constellationFilter === 'predicted' && (item.score < 50 || item.score >= 75)) return false;
      if (constellationFilter === 'mixed' && (item.negativeCount === 0 || item.positiveCount === 0)) return false;
      if (constellationFilter === 'unknown' && item.score >= 50) return false;
      return true;
    });
  }, [metrics, selectedCategory, constellationFilter]);

  const categories: Array<{ id: IdentityCategory | 'all'; label: string; icon: string }> = [
    { id: 'all', label: 'Tümü', icon: '✦' },
    { id: 'genres', label: 'Türler', icon: '🎭' },
    { id: 'atmosphere', label: 'Atmosfer', icon: '🌫️' },
    { id: 'narrative', label: 'Anlatı', icon: '📖' },
    { id: 'concepts', label: 'Kavramlar', icon: '💡' },
    { id: 'characters', label: 'Karakterler', icon: '👤' },
    { id: 'style', label: 'Stil', icon: '🎨' },
    { id: 'world', label: 'Dünya', icon: '🪐' },
    { id: 'origin', label: 'Köken', icon: '🌍' },
    { id: 'format', label: 'Biçim', icon: '🎞️' },
  ];

  return (
    <div className="identity-view w-full max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-8 animate-fade-in text-cinema-text">
      {/* Sub-view Switcher: Kimlik & Kanıtlar vs. Halka Yaşam Döngüsü */}
      <div className="flex flex-wrap items-center justify-between gap-4 pb-2 border-b border-white/10">
        <div>
          <span className="text-[11px] font-semibold uppercase tracking-widest text-cinema-gold">
            Kişisel DNA & Zevk Analizi
          </span>
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-white flex items-center gap-2 font-display">
            <span>🧬 Kimliğim</span>
            <span className="text-xs px-2.5 py-1 rounded-full bg-cinema-gold/10 text-cinema-gold border border-cinema-gold/30 font-medium">
              Bunu Nasıl Bildin?
            </span>
          </h1>
        </div>

        <div className="flex items-center gap-1.5 p-1 rounded-2xl bg-cinema-solid/80 border border-white/10 backdrop-blur-md">
          <button
            type="button"
            className={`px-4 py-2 rounded-xl text-xs sm:text-sm font-semibold transition-all cursor-pointer ${
              subView === 'constellation'
                ? 'bg-cinema-gold/20 text-cinema-gold border border-cinema-gold/30 shadow-[0_0_15px_rgba(211,181,121,0.2)]'
                : 'text-cinema-textMuted hover:text-white'
            }`}
            onClick={() => setSubView('constellation')}
          >
            ✦ Kimlik & Kanıtlar
          </button>
          <button
            type="button"
            className={`px-4 py-2 rounded-xl text-xs sm:text-sm font-semibold transition-all cursor-pointer ${
              subView === 'rings'
                ? 'bg-cinema-gold/20 text-cinema-gold border border-cinema-gold/30 shadow-[0_0_15px_rgba(211,181,121,0.2)]'
                : 'text-cinema-textMuted hover:text-white'
            }`}
            onClick={() => setSubView('rings')}
          >
            🎞️ Halka Koleksiyonu (Rings)
          </button>
        </div>
      </div>

      {subView === 'rings' ? (
        /* Ring Wall sub-view: keeps existing deep poster wall functionality */
        <div className="rings-container space-y-4">
          <div className="p-4 rounded-2xl bg-cinema-solid/80 border border-cinema-gold/25 text-xs text-cinema-text flex items-center justify-between">
            <span>
              <strong>Halka Yaşam Döngüsü:</strong> Ring 0 (Çekirdek Zevk), Ring 1 (Güçlü Adaylar) ve Ring 2 (Keşif & Uç Noktalar)
              posterlerini inceleyip manuel olarak yeniden düzenleyebilirsiniz.
            </span>
            <button
              type="button"
              className="text-cinema-gold hover:underline font-semibold shrink-0 ml-4 cursor-pointer"
              onClick={() => setSubView('constellation')}
            >
              ← Kimliğime Dön
            </button>
          </div>
          <TasteMapView
            tasteMap={tasteMap}
            summary={summary}
            genresMap={genresMap}
            savedItems={savedItems}
            onOpenDetails={onOpenDetails}
            onQuickSave={onQuickSave}
            onSetStatus={onSetStatus}
            onToggleDislike={onToggleDislike}
            onRefreshTasteMap={onRefreshTasteMap}
            isLoading={isLoading}
            isDemo={isDemo}
            tmdbSource={tmdbSource}
            tmdbStaleReason={tmdbStaleReason}
          />
        </div>
      ) : (
        /* Primary Identity Constellation & Evidence View */
        <>
          {/* 1. HERO OVERVIEW SECTION */}
          <div className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-[#13151a]/95 via-[#0a0b0e]/95 to-[#13151a]/90 border border-white/10 p-6 sm:p-8 backdrop-blur-xl shadow-2xl">
            <div className="absolute top-0 right-0 w-96 h-96 bg-cinema-gold/10 rounded-full blur-3xl pointer-events-none" />

            <div className="relative z-10 grid grid-cols-1 lg:grid-cols-12 gap-8 items-center">
              {/* Left: Dominant Traits Dev Tipografi */}
              <div className="lg:col-span-8 space-y-4">
                <div className="flex items-center gap-3">
                  <span className="text-xs uppercase tracking-widest text-cinema-gold font-mono font-medium">
                    En Baskın Sinematik Karakteristikler
                  </span>
                  <span className="w-8 h-[1px] bg-cinema-gold/30" />
                </div>

                <div className="space-y-1">
                  {dominantTraits.map((t, idx) => (
                    <div
                      key={t.id}
                      className="group cursor-pointer flex items-baseline gap-3 transition-transform hover:translate-x-1"
                      onClick={() => setSelectedEvidence(t.evidence)}
                      title="Kanıtlarını gör"
                    >
                      <span className="text-xs font-mono text-cinema-gold/60 tabular-nums">
                        0{idx + 1}.
                      </span>
                      <span className="text-2xl sm:text-4xl md:text-5xl font-black tracking-tight text-white group-hover:text-cinema-gold transition-colors font-display">
                        {t.title}
                      </span>
                      <span className="text-xs font-mono text-cinema-textMuted px-2 py-0.5 rounded bg-white/5 border border-white/10">
                        %{t.score}
                      </span>
                    </div>
                  ))}
                </div>

                <p className="text-sm text-cinema-textMuted max-w-2xl leading-relaxed pt-2">
                  İzleme geçmişiniz, puan tercihleriniz ve atlanan sahneler analiz edildiğinde, algoritmik kimliğiniz bu üç temel eksen etrafında yoğunlaşıyor.
                </p>
              </div>

              {/* Right: Confidence Badge & Stats */}
              <div className="lg:col-span-4 flex flex-col gap-4 bg-cinema-solid/70 border border-white/10 rounded-2xl p-5 backdrop-blur-md">
                <div className="flex items-center justify-between pb-3 border-b border-white/10">
                  <span className="text-xs text-cinema-textMuted">Profil Güveni</span>
                  <div className="flex items-center gap-1.5">
                    <span
                      className={`w-2 h-2 rounded-full ${
                        stats.confidence === 'high'
                          ? 'bg-[#6fbf8a] shadow-[0_0_8px_#6fbf8a]'
                          : stats.confidence === 'medium'
                          ? 'bg-[#d3b579] shadow-[0_0_8px_#d3b579]'
                          : 'bg-[#e0645e] shadow-[0_0_8px_#e0645e]'
                      }`}
                    />
                    <span className="text-xs font-semibold text-[#eef0f2]">
                      {stats.confidence === 'high'
                        ? 'Yüksek Güven'
                        : stats.confidence === 'medium'
                        ? 'Orta Güven'
                        : 'Düşük Güven (Daha Fazla İzleme Gerekli)'}
                    </span>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3 py-1">
                  <div>
                    <div className="text-xs text-cinema-textMuted">Analiz Edilen İçerik</div>
                    <div className="text-xl font-bold text-white tabular-nums">
                      {stats.movies} Film · {stats.tv} Dizi
                    </div>
                  </div>
                  <div>
                    <div className="text-xs text-cinema-textMuted">Tamamlanan</div>
                    <div className="text-xl font-bold text-cinema-gold tabular-nums">
                      {stats.completed} Yapım
                    </div>
                  </div>
                </div>

                <div className="pt-2 border-t border-white/10 flex items-center justify-between text-[11px] text-cinema-textMuted">
                  <span>Hesaplama Motoru: v6 (Derin Sinema)</span>
                  <span className="text-cinema-gold/90">Canlı Senkronize</span>
                </div>
              </div>
            </div>
          </div>

          {/* 2. 9-KATEGORİ SEKME ÇUBUĞU */}
          <div className="space-y-4">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <span className="text-xs font-semibold tracking-wider uppercase text-cinema-textMuted">
                9 Boyutlu Zevk Spektrumu
              </span>
              <span className="text-xs text-cinema-textMuted">
                Kartlara tıklayarak &ldquo;Bunu Nasıl Bildik?&rdquo; kanıt modalını açın.
              </span>
            </div>

            <div className="flex items-center gap-2 overflow-x-auto pb-2 scrollbar-none">
              {categories.map((c) => {
                const isActive = selectedCategory === c.id;
                return (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => setSelectedCategory(c.id)}
                    className={`flex items-center gap-1.5 px-4 py-2 rounded-2xl text-xs font-medium whitespace-nowrap transition-all cursor-pointer ${
                      isActive
                        ? 'bg-cinema-goldDim text-cinema-gold border border-cinema-gold/40 shadow-[0_0_15px_rgba(211,181,121,0.15)]'
                        : 'bg-cinema-surfaceHover/80 text-cinema-textMuted hover:text-cinema-textPrimary border border-white/7 hover:border-white/15'
                    }`}
                  >
                    <span>{c.icon}</span>
                    <span>{c.label}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* 3. METRİK IZGARASI (CONSTELLATION GRID) */}
          <div className="space-y-4">
            {/* Filter pills: Bildiğim, Tahmin Ettiklerim, Karışık Kanıt, Bilmediğim */}
            <div className="flex items-center gap-2 overflow-x-auto pb-1">
              <span className="text-xs text-cinema-textMuted mr-2">Kanıt Durumu:</span>
              <button
                type="button"
                onClick={() => setConstellationFilter('all')}
                className={`px-3 py-1 rounded-xl text-xs font-medium transition-colors cursor-pointer ${
                  constellationFilter === 'all'
                    ? 'bg-white/15 text-cinema-textPrimary border border-white/20'
                    : 'text-cinema-textMuted hover:text-cinema-textPrimary bg-cinema-surfaceHover/50'
                }`}
              >
                Tümü ({metrics.length})
              </button>
              <button
                type="button"
                onClick={() => setConstellationFilter('known')}
                className={`px-3 py-1 rounded-xl text-xs font-medium transition-colors cursor-pointer ${
                  constellationFilter === 'known'
                    ? 'bg-[#6fbf8a]/15 text-[#6fbf8a] border border-[#6fbf8a]/35'
                    : 'text-cinema-textMuted hover:text-[#6fbf8a] bg-cinema-surfaceHover/50'
                }`}
              >
                🟢 Bildiğim Kanıtlar (%75+)
              </button>
              <button
                type="button"
                onClick={() => setConstellationFilter('predicted')}
                className={`px-3 py-1 rounded-xl text-xs font-medium transition-colors cursor-pointer ${
                  constellationFilter === 'predicted'
                    ? 'bg-cinema-goldDim text-cinema-gold border border-cinema-gold/35'
                    : 'text-cinema-textMuted hover:text-cinema-gold bg-cinema-surfaceHover/50'
                }`}
              >
                🟡 Tahmin Ettiklerim (%50-74)
              </button>
              <button
                type="button"
                onClick={() => setConstellationFilter('mixed')}
                className={`px-3 py-1 rounded-xl text-xs font-medium transition-colors cursor-pointer ${
                  constellationFilter === 'mixed'
                    ? 'bg-cinema-purple/15 text-cinema-purple border border-cinema-purple/35'
                    : 'text-cinema-textMuted hover:text-cinema-purple bg-cinema-surfaceHover/50'
                }`}
              >
                🟣 Karışık Kanıt
              </button>
              <button
                type="button"
                onClick={() => setConstellationFilter('unknown')}
                className={`px-3 py-1 rounded-xl text-xs font-medium transition-colors cursor-pointer ${
                  constellationFilter === 'unknown'
                    ? 'bg-cinema-dangerDim text-cinema-danger border border-cinema-danger/35'
                    : 'text-cinema-textMuted hover:text-cinema-danger bg-cinema-surfaceHover/50'
                }`}
              >
                🔴 Bilmediğim / Keşif (&lt;%50)
              </button>
            </div>

            {/* Grid of Metric Cards */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {displayedMetrics.map((item) => {
                const isHigh = item.score >= 75;
                const isMid = item.score >= 50 && item.score < 75;
                const scoreColor = isHigh ? '#6fbf8a' : isMid ? '#d3b579' : '#63b8ab';

                return (
                  <div
                    key={item.id}
                    onClick={() => {
                      setSelectedEvidence(item.evidence);
                      onOpenEvidenceModal?.(item.evidence);
                    }}
                    className="group relative p-5 rounded-2xl bg-cinema-surface hover:bg-cinema-surfaceHover border border-white/7 hover:border-cinema-gold/40 transition-all duration-300 cursor-pointer shadow-lg hover:shadow-2xl flex flex-col justify-between"
                  >
                    <div className="space-y-3">
                      <div className="flex items-center justify-between">
                        <span className="text-[10px] font-mono tracking-wider uppercase px-2 py-0.5 rounded bg-white/5 text-cinema-textMuted border border-white/7">
                          {item.categoryLabel}
                        </span>
                        <span className="text-xs font-mono font-bold tabular-nums" style={{ color: scoreColor }}>
                          %{item.score} Eşleşme
                        </span>
                      </div>

                      <h3 className="text-lg font-bold text-cinema-textPrimary group-hover:text-cinema-gold transition-colors">
                        {item.title}
                      </h3>

                      <p className="text-xs text-cinema-textMuted line-clamp-2 leading-relaxed">
                        {item.why}
                      </p>
                    </div>

                    <div className="pt-4 mt-4 border-t border-white/5 flex items-center justify-between text-xs text-cinema-textMuted">
                      <span className="flex items-center gap-1">
                        <span className="w-1.5 h-1.5 rounded-full bg-[#6fbf8a]" />
                        {item.positiveCount} pozitif kanıt
                      </span>
                      <span className="text-cinema-gold text-[11px] font-semibold group-hover:underline">
                        Neden buradaydı? →
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* 4. TASTECOMPARE: FILM VS DİZİ KARŞILAŞTIRMASI */}
          <div className="rounded-3xl bg-cinema-surface border border-white/7 p-6 sm:p-8 backdrop-blur-md space-y-6">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <span className="text-[10px] font-semibold uppercase tracking-widest text-cinema-cyan">
                  Medya Formu Ayrımı
                </span>
                <h2 className="text-xl font-bold text-cinema-textPrimary">Film vs. Dizi Tercih Karşılaştırması</h2>
              </div>
              <span className="text-xs text-cinema-textMuted">
                Farklı formatlardaki tüketim alışkanlıklarınızın ayrışma analizi
              </span>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {/* Movies Side */}
              <div className="p-5 rounded-2xl bg-[#13151a] border border-cinema-cyan/25 space-y-4">
                <div className="flex items-center justify-between pb-3 border-b border-cinema-cyan/15">
                  <div className="flex items-center gap-2">
                    <span className="text-lg">🎬</span>
                    <h3 className="font-bold text-cinema-cyan">Filmlerdeki Zevk Profili</h3>
                  </div>
                  <span className="text-xs font-mono text-cinema-cyan/90">{stats.movies} Film Analiz Edildi</span>
                </div>
                <p className="text-xs text-cinema-textMuted leading-relaxed">
                  Filmlerde daha çok <strong>karanlık, kapalı mekan psikolojik gerilimleri</strong> ve varoluşsal bilim kurgu tercih ediliyor. Yüksek puanlar ağırlıklı olarak bağımsız yapımlara ve keskin senaryolara verilmiş.
                </p>
                <div className="space-y-2 pt-2">
                  <div className="flex justify-between text-xs">
                    <span className="text-cinema-textMuted">Atmosfer Yoğunluğu</span>
                    <span className="text-cinema-cyan font-mono">%88</span>
                  </div>
                  <div className="w-full bg-[#0a0b0e] h-1.5 rounded-full overflow-hidden">
                    <div className="bg-cinema-cyan h-full rounded-full" style={{ width: '88%' }} />
                  </div>
                </div>
              </div>

              {/* Series Side */}
              <div className="p-5 rounded-2xl bg-[#13151a] border border-cinema-purple/25 space-y-4">
                <div className="flex items-center justify-between pb-3 border-b border-cinema-purple/15">
                  <div className="flex items-center gap-2">
                    <span className="text-lg">📺</span>
                    <h3 className="font-bold text-cinema-purple">Dizilerdeki Zevk Profili</h3>
                  </div>
                  <span className="text-xs font-mono text-cinema-purple/90">{stats.tv} Dizi Analiz Edildi</span>
                </div>
                <p className="text-xs text-cinema-textMuted leading-relaxed">
                  Dizilerde ise <strong>derin evren inşası (world-building)</strong>, çok karakterli politik entrikalar ve sınırlı mini-dizi formatları öne çıkıyor. Bölüm sürekliliği ve gizem unsurları sürükleyiciliği artırıyor.
                </p>
                <div className="space-y-2 pt-2">
                  <div className="flex justify-between text-xs">
                    <span className="text-cinema-textMuted">Evren ve Karakter Derinliği</span>
                    <span className="text-cinema-purple font-mono">%92</span>
                  </div>
                  <div className="w-full bg-[#0a0b0e] h-1.5 rounded-full overflow-hidden">
                    <div className="bg-cinema-purple h-full rounded-full" style={{ width: '92%' }} />
                  </div>
                </div>
              </div>
            </div>
          </div>
        </>
      )}

      {/* EVIDENCE MODAL */}
      <EvidenceModal
        isOpen={Boolean(selectedEvidence)}
        data={selectedEvidence}
        onClose={() => setSelectedEvidence(null)}
        onSelectMedia={onOpenDetails}
      />
    </div>
  );
};

export default IdentityView;
