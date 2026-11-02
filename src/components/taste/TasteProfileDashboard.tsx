// ===========================================================================
// CineTrack — "Sinema Kimliğim" Ana Ekranı (Derin Sinema Kabuk Tasarımı)
// Takımyıldızı (Constellation Grid) + Kategori Filtreleri + Kanıt Modalı
// ===========================================================================

import React, { useMemo, useState } from "react";
import { AnimatePresence } from "framer-motion";
import {
  AlertTriangle,
  ChevronRight,
  Filter,
  RefreshCw,
  Sliders,
  Sparkles,
} from "lucide-react";
import { TAXONOMY_V01 } from "../../core/taste/taxonomy.ts";
import {
  estimateMetricEvidenceCount,
  getCategoryDisplayLabel,
  getMetricDisplayTitle,
  getStatusLabelTr,
  resolveEffectiveMetricView,
} from "../../core/taste/metric-labels.ts";
import { useTasteProfile } from "../../hooks/useTasteProfile.ts";
import { GlassCard } from "../ui/GlassCard.tsx";
import { TasteMetricDetail } from "./TasteMetricDetail.tsx";

const CATEGORIES = [
  { id: "all", label: "Tümü" },
  { id: "genre", label: "Tür" },
  { id: "mood", label: "Atmosfer" },
  { id: "narrative", label: "Anlatı" },
  { id: "concept", label: "Tema" },
  { id: "character", label: "Karakter" },
  { id: "style", label: "Stil" },
  { id: "setting", label: "Ortam" },
  { id: "origin", label: "Köken" },
  { id: "format", label: "Format" },
];

export interface TasteProfileDashboardProps {
  /** Profil modalı içinde gömülü kullanıldığında daha sıkı kenar boşluğu uygular */
  compact?: boolean;
}

export const TasteProfileDashboard: React.FC<TasteProfileDashboardProps> = ({
  compact = false,
}) => {
  const { profile, status, error, reload, applyOverride, removeOverride } =
    useTasteProfile();
  const [selectedCategory, setSelectedCategory] = useState<string>("all");
  const [onlyWithSignal, setOnlyWithSignal] = useState<boolean>(false);
  const [activeMetricId, setActiveMetricId] = useState<string | null>(null);

  const enrichedMetrics = useMemo(() => {
    const scoredDefs = TAXONOMY_V01.filter((def) => def.scoringEnabled);
    return scoredDefs
      .map((def) => {
        const rawMetric = profile?.metrics?.[def.id] ?? null;
        const view = resolveEffectiveMetricView(rawMetric);
        const evidenceCount = estimateMetricEvidenceCount(rawMetric);
        return {
          def,
          rawMetric,
          view,
          title: getMetricDisplayTitle(def.id),
          categoryLabel: getCategoryDisplayLabel(def.categoryId),
          statusLabel: getStatusLabelTr(view.effectiveStatus),
          evidenceCount,
        };
      })
      .sort((a, b) => {
        if (a.view.hasOverride !== b.view.hasOverride) {
          return a.view.hasOverride ? -1 : 1;
        }
        const aKnown = a.view.effectiveStatus !== "unknown" ? 1 : 0;
        const bKnown = b.view.effectiveStatus !== "unknown" ? 1 : 0;
        if (aKnown !== bKnown) return bKnown - aKnown;
        return Math.abs(b.view.effectiveAffinity) - Math.abs(a.view.effectiveAffinity);
      });
  }, [profile]);

  const knownCount = useMemo(
    () =>
      enrichedMetrics.filter(
        (m) => m.view.effectiveStatus !== "unknown" || m.view.hasOverride
      ).length,
    [enrichedMetrics]
  );

  const overrideCount = useMemo(
    () => enrichedMetrics.filter((m) => m.view.hasOverride).length,
    [enrichedMetrics]
  );

  const filteredMetrics = useMemo(() => {
    return enrichedMetrics.filter((item) => {
      if (selectedCategory !== "all" && item.def.categoryId !== selectedCategory) {
        return false;
      }
      if (
        onlyWithSignal &&
        item.view.effectiveStatus === "unknown" &&
        !item.view.hasOverride
      ) {
        return false;
      }
      return true;
    });
  }, [enrichedMetrics, selectedCategory, onlyWithSignal]);

  if (status === "loading" && !profile) {
    return (
      <div
        className="glass-panel rounded-2xl p-8 text-center text-sm text-cinema-textMuted"
        role="status"
        aria-busy="true"
      >
        Sinema kimliğin hesaplanıyor…
      </div>
    );
  }

  if ((status === "error" || error) && !profile) {
    return (
      <div
        className="glass-panel rounded-2xl p-6 flex flex-wrap items-center justify-between gap-4 border border-cinema-danger/40"
        role="alert"
      >
        <div className="flex items-center gap-3 text-sm text-cinema-danger">
          <AlertTriangle className="w-5 h-5 shrink-0" />
          <span>Zevk profili yüklenemedi: {error}</span>
        </div>
        <button
          type="button"
          onClick={() => void reload()}
          className="btn-ghost text-xs"
        >
          Yeniden Dene
        </button>
      </div>
    );
  }

  return (
    <section
      aria-label="Sinema Kimliğim"
      className={
        compact
          ? "text-cinema-textPrimary space-y-5"
          : "w-full text-cinema-textPrimary py-4 sm:py-6 space-y-8"
      }
    >
      {/* Hero & Özet Üst Bölümü */}
      <header className="relative overflow-hidden rounded-2xl border border-white/10 bg-cinema-surface/80 p-6 sm:p-8">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-2xl">
            <div className="inline-flex items-center gap-2 text-cinema-gold text-xs font-semibold uppercase tracking-widest mb-2">
              <Sparkles className="w-3.5 h-3.5" aria-hidden="true" />
              <span>Algoritmik Zevk Profili</span>
            </div>

            {compact ? (
              <h3 className="text-2xl sm:text-3xl font-display font-bold tracking-tight text-cinema-textPrimary">
                Sinema Kimliğim
              </h3>
            ) : (
              <h1 className="text-3xl sm:text-5xl font-display font-bold tracking-tight text-cinema-textPrimary">
                Sinema Kimliğim
              </h1>
            )}

            <p className="mt-2 text-sm text-cinema-textMuted leading-relaxed">
              İzlediğin ve puanladığın yapımlardan damıtılan kişisel sinema parmak izin. Her metriğe tıklayarak arkasındaki kanıtları inceleyebilir ve algoritmayı manuel yönlendirebilirsin.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <div className="px-3.5 py-2 rounded-xl bg-cinema-bg/70 border border-white/10 text-right">
              <div className="text-[11px] text-cinema-textMuted">Aktif Metrik</div>
              <div className="metric-value text-base font-bold text-cinema-gold">
                {knownCount}/{enrichedMetrics.length}
              </div>
            </div>

            {overrideCount > 0 && (
              <div className="px-3.5 py-2 rounded-xl bg-cinema-cyanDim border border-cinema-cyan/30 text-right">
                <div className="text-[11px] text-cinema-cyan">Manuel Kontrol</div>
                <div className="metric-value text-base font-bold text-cinema-cyan">
                  {overrideCount}
                </div>
              </div>
            )}

            <button
              type="button"
              onClick={() => void reload()}
              aria-label="Zevk profilini yenile"
              className="btn-ghost text-xs px-3.5 py-2.5"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span>Yenile</span>
            </button>
          </div>
        </div>
      </header>

      {/* Kategori Sekmeleri & Hızlı Görünüm Anahtarı */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div
          className="flex items-center gap-2 overflow-x-auto pb-1 max-w-full"
          role="tablist"
          aria-label="Zevk kategorileri"
        >
          <Filter
            className="w-4 h-4 text-cinema-textMuted mr-1 shrink-0"
            aria-hidden="true"
          />
          {CATEGORIES.map((cat) => {
            const isSelected = selectedCategory === cat.id;
            return (
              <button
                key={cat.id}
                role="tab"
                type="button"
                aria-selected={isSelected}
                onClick={() => setSelectedCategory(cat.id)}
                className={`px-3.5 py-2 rounded-xl text-xs font-semibold transition-all whitespace-nowrap ${
                  isSelected
                    ? "bg-cinema-gold text-cinema-bg shadow-glowGold"
                    : "bg-cinema-surface text-cinema-textMuted hover:text-cinema-textPrimary border border-cinema-border"
                }`}
              >
                {cat.label}
              </button>
            );
          })}
        </div>

        <button
          type="button"
          aria-pressed={onlyWithSignal}
          onClick={() => setOnlyWithSignal((v) => !v)}
          className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-medium border transition-colors ${
            onlyWithSignal
              ? "bg-cinema-cyanDim border-cinema-cyan/40 text-cinema-cyan"
              : "bg-cinema-surface border-cinema-border text-cinema-textMuted hover:text-cinema-textPrimary"
          }`}
        >
          <Sliders className="w-3.5 h-3.5" aria-hidden="true" />
          <span>{onlyWithSignal ? "Sadece Kanıtlılar" : "Tüm Metrikler"}</span>
        </button>
      </div>

      {/* Takımyıldızı Metrik Kartları (Constellation Grid) */}
      {filteredMetrics.length === 0 ? (
        <div className="glass-panel rounded-2xl p-8 text-center space-y-3">
          <p className="text-sm text-cinema-textMuted">
            Seçili kategoride henüz sinyal üretmiş metrik bulunmuyor.
          </p>
          {onlyWithSignal && (
            <button
              type="button"
              onClick={() => setOnlyWithSignal(false)}
              className="btn-ghost text-xs"
            >
              Tüm Metrikleri Göster
            </button>
          )}
        </div>
      ) : (
        <div
          className={
            compact
              ? "grid grid-cols-1 md:grid-cols-2 gap-4"
              : "grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5"
          }
        >
          {filteredMetrics.map((item) => {
            const { def, view, title, categoryLabel, statusLabel, evidenceCount } =
              item;
            const glowType = view.isExcluded
              ? "none"
              : view.effectiveAffinity >= 60
                ? "gold"
                : view.effectiveAffinity <= -40
                  ? "cyan"
                  : "none";

            const scoreColor = view.isExcluded
              ? "text-cinema-danger"
              : view.effectiveAffinity > 0
                ? "text-cinema-gold"
                : view.effectiveAffinity < 0
                  ? "text-cinema-danger"
                  : "text-cinema-textMuted";

            return (
              <GlassCard
                key={def.id}
                glow={glowType}
                ariaLabel={`${title} metriği detaylarını ve kanıtlarını aç`}
                onClick={() => setActiveMetricId(def.id)}
                className="flex flex-col justify-between group"
              >
                <div>
                  <div className="flex items-center justify-between gap-2 mb-3">
                    <span className="text-[11px] font-semibold uppercase tracking-wider text-cinema-textMuted">
                      {categoryLabel}
                    </span>
                    <div className="flex items-center gap-2 text-[11px]">
                      {view.hasOverride && (
                        <span className="text-cinema-cyan font-semibold">
                          Manuel
                        </span>
                      )}
                      <span
                        className={`font-medium ${
                          view.effectiveStatus === "directional"
                            ? "text-cinema-gold"
                            : view.effectiveStatus === "mixed"
                              ? "text-cinema-cyan"
                              : view.effectiveStatus === "excluded"
                                ? "text-cinema-danger"
                                : "text-cinema-textMuted"
                        }`}
                      >
                        {statusLabel}
                      </span>
                    </div>
                  </div>

                  <h4 className="text-lg font-semibold text-cinema-textPrimary group-hover:text-cinema-gold transition-colors">
                    {title}
                  </h4>
                  <p className="text-xs text-cinema-textMuted mt-1 line-clamp-2 leading-relaxed">
                    {def.definition}
                  </p>
                </div>

                <div className="mt-5 pt-4 border-t border-white/5 flex items-end justify-between gap-3">
                  <div>
                    <div className="text-[11px] text-cinema-textMuted mb-0.5">
                      Eğilim Skoru
                    </div>
                    <div className={`metric-value text-2xl font-bold ${scoreColor}`}>
                      {view.isExcluded
                        ? "Hariç"
                        : view.effectiveAffinity > 0
                          ? `+${view.effectiveAffinity}`
                          : view.effectiveAffinity}
                    </div>
                  </div>

                  <div className="flex items-center gap-1 text-xs text-cinema-textMuted group-hover:text-cinema-textPrimary transition-colors">
                    <span className="tabular-nums">{evidenceCount} kanıt</span>
                    <ChevronRight
                      className="w-4 h-4 transform group-hover:translate-x-0.5 transition-transform"
                      aria-hidden="true"
                    />
                  </div>
                </div>
              </GlassCard>
            );
          })}
        </div>
      )}

      {/* Kanıt ve Manuel Kontrol Modalı */}
      <AnimatePresence>
        {activeMetricId && (
          <TasteMetricDetail
            metricId={activeMetricId}
            onClose={() => setActiveMetricId(null)}
            onOverride={applyOverride}
            onRemoveOverride={removeOverride}
          />
        )}
      </AnimatePresence>
    </section>
  );
};

export default TasteProfileDashboard;
