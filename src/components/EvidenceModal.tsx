import React, { useState } from 'react';

export interface EvidenceDetailData {
  title: string;
  category?: string;
  score: number; // 0-100
  confidence?: 'high' | 'medium' | 'low';
  description?: string;
  howWeKnow?: string;
  positiveEvidence?: Array<{
    id: number | string;
    media_type: 'movie' | 'tv';
    title: string;
    poster_path?: string | null;
    year?: string | number;
    contribution: string;
  }>;
  negativeEvidence?: Array<{
    id: number | string;
    media_type: 'movie' | 'tv';
    title: string;
    poster_path?: string | null;
    year?: string | number;
    contribution: string;
  }>;
  relatedMetrics?: Array<{ id: string; name: string; score: number }>;
  userAdjustment?: 'boost' | 'reduce' | 'pin' | 'ignore' | null;
}

interface EvidenceModalProps {
  isOpen: boolean;
  data: EvidenceDetailData | null;
  onClose: () => void;
  onSelectMedia?: (item: any) => void;
  onAdjustMetric?: (metricTitle: string, action: 'boost' | 'reduce' | 'pin' | 'ignore' | 'reset') => void;
}

export const EvidenceModal: React.FC<EvidenceModalProps> = ({
  isOpen,
  data,
  onClose,
  onSelectMedia,
  onAdjustMetric,
}) => {
  const [objectionSent, setObjectionSent] = useState(false);
  const [currentAdjustment, setCurrentAdjustment] = useState<'boost' | 'reduce' | 'pin' | 'ignore' | null>(
    data?.userAdjustment || null
  );

  if (!isOpen || !data) return null;

  const scoreColor =
    data.score >= 80 ? '#6fbf8a' : data.score >= 60 ? '#d3b579' : data.score >= 40 ? '#63b8ab' : '#8b9099';

  const circumference = 2 * Math.PI * 28;
  const strokeDashoffset = circumference - (data.score / 100) * circumference;

  const handleAction = (action: 'boost' | 'reduce' | 'pin' | 'ignore' | 'reset') => {
    if (action === 'reset') {
      setCurrentAdjustment(null);
    } else {
      setCurrentAdjustment(action);
    }
    onAdjustMetric?.(data.title, action);
  };

  const handleObjection = () => {
    setObjectionSent(true);
    try {
      const stored = JSON.parse(localStorage.getItem('cinetrack_evidence_objections') || '[]');
      stored.push({ title: data.title, at: new Date().toISOString() });
      localStorage.setItem('cinetrack_evidence_objections', JSON.stringify(stored));
    } catch { /* opsiyonel adım: hata ana akışı etkilemez */ }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-[#0a0b0e]/85 backdrop-blur-xl animate-fade-in"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="evidenceModalTitle"
    >
      <div
        className="relative w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-3xl bg-[#13151a]/95 border border-white/7 shadow-[0_25px_60px_rgba(0,0,0,0.85)] p-6 md:p-8 text-[#eef0f2]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Close Button */}
        <button
          type="button"
          onClick={onClose}
          className="absolute top-5 right-5 p-2 rounded-xl text-[#8b9099] hover:text-[#eef0f2] hover:bg-white/5 transition-colors"
          aria-label="Kapat"
        >
          <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M18 6 6 18M6 6l12 12" strokeLinecap="round" />
          </svg>
        </button>

        {/* Header: Title + Circular Score */}
        <div className="flex items-start gap-4 mb-6 pr-8">
          {/* Circular Progress Gauge */}
          <div className="relative w-16 h-16 shrink-0 flex items-center justify-center">
            <svg className="w-16 h-16 -rotate-90">
              <circle
                cx="32"
                cy="32"
                r="28"
                stroke="rgba(255,255,255,0.07)"
                strokeWidth="5"
                fill="none"
              />
              <circle
                cx="32"
                cy="32"
                r="28"
                stroke={scoreColor}
                strokeWidth="5"
                fill="none"
                strokeDasharray={circumference}
                strokeDashoffset={strokeDashoffset}
                strokeLinecap="round"
                className="transition-all duration-700 ease-out"
              />
            </svg>
            <div className="absolute inset-0 flex flex-col items-center justify-center font-mono">
              <span className="text-sm font-bold leading-none text-[#eef0f2]">%{data.score}</span>
              <span className="text-[9px] text-[#8b9099] tracking-tight">UYUM</span>
            </div>
          </div>

          <div>
            <div className="flex items-center gap-2 mb-1">
              {data.category && (
                <span className="text-[10px] font-mono uppercase tracking-wider px-2 py-0.5 rounded-md bg-white/5 border border-white/7 text-[#8b9099]">
                  {data.category}
                </span>
              )}
              {data.confidence && (
                <span
                  className={`text-[10px] font-mono uppercase tracking-wider px-2 py-0.5 rounded-md border ${
                    data.confidence === 'high'
                      ? 'bg-[#6fbf8a]/15 border-[#6fbf8a]/35 text-[#6fbf8a]'
                      : data.confidence === 'medium'
                      ? 'bg-[#d3b579]/15 border-[#d3b579]/35 text-[#d3b579]'
                      : 'bg-white/5 border-white/7 text-[#8b9099]'
                  }`}
                >
                  {data.confidence === 'high' ? 'Güçlü Kanıt' : data.confidence === 'medium' ? 'Çıkarım' : 'Az Veri'}
                </span>
              )}
            </div>
            <h2 id="evidenceModalTitle" className="text-xl md:text-2xl font-serif font-bold text-[#eef0f2] tracking-tight">
              {data.title}
            </h2>
            <p className="text-sm text-[#8b9099] mt-1 leading-relaxed">
              {data.description || 'Bu metrik, izleme geçmişinizdeki tematik ve ton benzerliklerinden türetilmiştir.'}
            </p>
          </div>
        </div>

        {/* "Bunu Nasıl Bildin?" Bilgi Notu */}
        <div className="mb-6 p-4 rounded-2xl bg-[#0a0b0e]/70 border border-[#63b8ab]/25 text-xs leading-relaxed text-[#8b9099]">
          <div className="flex items-center gap-2 text-[#63b8ab] font-semibold mb-1">
            <span>💡</span>
            <span>Bunu Nasıl Bildik?</span>
          </div>
          <p>
            {data.howWeKnow ||
              'İzlediğiniz, yüksek puan verdiğiniz veya listenize eklediğiniz yapımların senaryo tonu, yönetmen dili ve kavramsal etiketleri vektörel uzayda analiz edildi. Profiliniz bu temaya belirgin bir afinite gösteriyor.'}
          </p>
        </div>

        {/* ✅ Tercihini Güçlendiren İçerikler */}
        {data.positiveEvidence && data.positiveEvidence.length > 0 && (
          <div className="mb-5">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-[#6fbf8a] mb-2 flex items-center gap-1.5">
              <span>✅</span> Tercihini Güçlendiren Yapımlar ({data.positiveEvidence.length})
            </h3>
            <div className="space-y-2">
              {data.positiveEvidence.map((item) => (
                <div
                  key={`${item.media_type}:${item.id}`}
                  onClick={() => onSelectMedia?.(item)}
                  className="flex items-center justify-between p-2.5 rounded-xl bg-[#0a0b0e]/50 border border-white/5 hover:border-[#6fbf8a]/35 hover:bg-white/5 transition-colors cursor-pointer group"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    {item.poster_path ? (
                      <img
                        src={`https://image.tmdb.org/t/p/w92${item.poster_path}`}
                        alt={item.title}
                        className="w-8 h-12 object-cover rounded-md shrink-0 border border-white/7"
                      />
                    ) : (
                      <div className="w-8 h-12 rounded-md bg-[#13151a] flex items-center justify-center text-xs text-cinema-textTertiary">
                        🎬
                      </div>
                    )}
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-[#eef0f2] group-hover:text-[#6fbf8a] transition-colors truncate">
                        {item.title}
                      </div>
                      <div className="text-[11px] text-[#8b9099] font-mono">{item.year || '—'}</div>
                    </div>
                  </div>
                  <span className="text-xs font-medium text-[#6fbf8a] font-mono shrink-0 pl-2">
                    {item.contribution}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ❌ Tercihini Zayıflatan İçerikler */}
        {data.negativeEvidence && data.negativeEvidence.length > 0 && (
          <div className="mb-5">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-[#e0645e] mb-2 flex items-center gap-1.5">
              <span>❌</span> Tercihini Zayıflatan İçerikler ({data.negativeEvidence.length})
            </h3>
            <div className="space-y-2">
              {data.negativeEvidence.map((item) => (
                <div
                  key={`${item.media_type}:${item.id}`}
                  onClick={() => onSelectMedia?.(item)}
                  className="flex items-center justify-between p-2.5 rounded-xl bg-[#0a0b0e]/50 border border-white/5 hover:border-[#e0645e]/35 hover:bg-white/5 transition-colors cursor-pointer group"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-[#eef0f2] group-hover:text-[#e0645e] transition-colors truncate">
                        {item.title}
                      </div>
                      <div className="text-[11px] text-[#8b9099] font-mono">{item.year || '—'}</div>
                    </div>
                  </div>
                  <span className="text-xs font-medium text-[#e0645e] font-mono shrink-0 pl-2">
                    {item.contribution}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* 🔗 İlgili Metrikler */}
        {data.relatedMetrics && data.relatedMetrics.length > 0 && (
          <div className="mb-6">
            <span className="text-xs font-semibold uppercase tracking-wider text-[#8b9099] mb-2 block">
              🔗 Bağlantılı Zevk Düğümleri
            </span>
            <div className="flex flex-wrap gap-2">
              {data.relatedMetrics.map((rm) => (
                <span
                  key={rm.id}
                  className="px-2.5 py-1 rounded-lg bg-[#0a0b0e]/60 border border-white/7 text-xs text-[#8b9099] font-mono"
                >
                  {rm.name} · %{rm.score}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* ⚙️ Manuel Kontrol Paneli */}
        <div className="pt-4 border-t border-white/7">
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs font-semibold text-[#8b9099] flex items-center gap-1.5">
              <span>⚙️</span> Bu Özelliği Yönet
            </span>
            {currentAdjustment && (
              <button
                type="button"
                onClick={() => handleAction('reset')}
                className="text-[11px] text-[#d3b579] hover:underline transition-colors"
              >
                Varsayılana Sıfırla
              </button>
            )}
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4">
            <button
              type="button"
              onClick={() => handleAction('boost')}
              className={`p-2 rounded-xl text-xs font-medium border transition-all ${
                currentAdjustment === 'boost'
                  ? 'bg-[#6fbf8a]/20 text-[#6fbf8a] border-[#6fbf8a]'
                  : 'bg-[#0a0b0e]/40 text-[#8b9099] border-white/7 hover:border-[#6fbf8a]/40 hover:text-[#eef0f2]'
              }`}
            >
              🚀 Güçlendir
            </button>
            <button
              type="button"
              onClick={() => handleAction('reduce')}
              className={`p-2 rounded-xl text-xs font-medium border transition-all ${
                currentAdjustment === 'reduce'
                  ? 'bg-[#d3b579]/20 text-[#d3b579] border-[#d3b579]'
                  : 'bg-[#0a0b0e]/40 text-[#8b9099] border-white/7 hover:border-[#d3b579]/40 hover:text-[#eef0f2]'
              }`}
            >
              📉 Azalt
            </button>
            <button
              type="button"
              onClick={() => handleAction('pin')}
              className={`p-2 rounded-xl text-xs font-medium border transition-all ${
                currentAdjustment === 'pin'
                  ? 'bg-[#63b8ab]/20 text-[#63b8ab] border-[#63b8ab]'
                  : 'bg-[#0a0b0e]/40 text-[#8b9099] border-white/7 hover:border-[#63b8ab]/40 hover:text-[#eef0f2]'
              }`}
            >
              📌 Sabitle
            </button>
            <button
              type="button"
              onClick={() => handleAction('ignore')}
              className={`p-2 rounded-xl text-xs font-medium border transition-all ${
                currentAdjustment === 'ignore'
                  ? 'bg-[#e0645e]/20 text-[#e0645e] border-[#e0645e]'
                  : 'bg-[#0a0b0e]/40 text-[#8b9099] border-white/7 hover:border-[#e0645e]/40 hover:text-[#eef0f2]'
              }`}
            >
              🚫 İlgisiz
            </button>
          </div>

          {/* İtiraz Butonu ("Bu film aslında X değil") */}
          <div className="flex items-center justify-between text-xs text-[#8b9099]">
            {objectionSent ? (
              <span className="text-[#6fbf8a] flex items-center gap-1">
                <span>✓</span> İtirazınız kaydedildi, profil algoritması güncellendi.
              </span>
            ) : (
              <button
                type="button"
                onClick={handleObjection}
                className="text-[#8b9099] hover:text-[#e0645e] underline underline-offset-2 transition-colors"
              >
                ⚠️ "Bu çıkarım profilimi tam yansıtmıyor" (İtiraz et)
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-xl bg-white/10 hover:bg-white/15 text-[#eef0f2] font-medium transition-colors"
            >
              Kapat
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
