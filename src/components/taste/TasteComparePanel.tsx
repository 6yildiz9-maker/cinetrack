import React, { useMemo } from "react";
import { ArrowLeftRight, ChevronRight, Film, Tv } from "lucide-react";
import type { TasteProfile } from "../../core/taste/types.ts";
import { TAXONOMY_V01 } from "../../core/taste/taxonomy.ts";
import {
  getCategoryDisplayLabel,
  getMetricDisplayTitle,
} from "../../core/taste/metric-labels.ts";
import { GlassCard } from "../ui/GlassCard.tsx";

export interface TasteComparePanelProps {
  movieProfile: TasteProfile | null;
  seriesProfile: TasteProfile | null;
  movieCount: number;
  seriesCount: number;
  onSelectMetric: (metricId: string) => void;
}

export const TasteComparePanel: React.FC<TasteComparePanelProps> = ({
  movieProfile,
  seriesProfile,
  movieCount,
  seriesCount,
  onSelectMetric,
}) => {
  const rows = useMemo(() => {
    const sharedDefs = TAXONOMY_V01.filter(
      (def) =>
        def.scoringEnabled &&
        def.applicableMedia.includes("movie") &&
        def.applicableMedia.includes("tv")
    );

    return sharedDefs
      .map((def) => {
        const mMetric = movieProfile?.metrics?.[def.id];
        const sMetric = seriesProfile?.metrics?.[def.id];
        const mKnown = Boolean(mMetric && mMetric.status !== "unknown");
        const sKnown = Boolean(sMetric && sMetric.status !== "unknown");
        const movieScore = mKnown ? mMetric!.affinity : 0;
        const seriesScore = sKnown ? sMetric!.affinity : 0;
        const diff = movieScore - seriesScore;
        return {
          id: def.id,
          title: getMetricDisplayTitle(def.id),
          category: getCategoryDisplayLabel(def.categoryId),
          mKnown,
          sKnown,
          movieScore,
          seriesScore,
          absDiff: Math.abs(diff),
          diff,
        };
      })
      .filter((r) => r.mKnown || r.sKnown)
      .sort((a, b) => {
        const bothA = a.mKnown && a.sKnown ? 1 : 0;
        const bothB = b.mKnown && b.sKnown ? 1 : 0;
        if (bothA !== bothB) return bothB - bothA;
        return b.absDiff - a.absDiff;
      });
  }, [movieProfile, seriesProfile]);

  const seriesOnlyRows = useMemo(() => {
    return TAXONOMY_V01.filter(
      (def) =>
        def.scoringEnabled &&
        !def.applicableMedia.includes("movie") &&
        def.applicableMedia.includes("tv")
    ).map((def) => {
      const sMetric = seriesProfile?.metrics?.[def.id];
      return {
        id: def.id,
        title: getMetricDisplayTitle(def.id),
        known: Boolean(sMetric && sMetric.status !== "unknown"),
        score: sMetric?.affinity ?? 0,
      };
    });
  }, [seriesProfile]);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="rounded-2xl bg-cinema-surface/60 border border-white/10 p-5 flex items-center justify-between">
          <div>
            <div className="flex items-center gap-2 text-xs text-cinema-gold font-medium">
              <Film className="w-4 h-4" aria-hidden="true" />
              <span>Film Profili (İzole)</span>
            </div>
            <div className="text-sm text-cinema-textMuted mt-1">
              Yalnızca film izleme ve puanlama sinyallerinden üretilir
            </div>
          </div>
          <div className="text-right">
            <div className="metric-value text-2xl font-bold text-cinema-textPrimary">
              {movieCount}
            </div>
            <div className="text-[11px] text-cinema-textMuted">Film Kanıtı</div>
          </div>
        </div>

        <div className="rounded-2xl bg-cinema-surface/60 border border-white/10 p-5 flex items-center justify-between">
          <div>
            <div className="flex items-center gap-2 text-xs text-cinema-cyan font-medium">
              <Tv className="w-4 h-4" aria-hidden="true" />
              <span>Dizi Profili (İzole)</span>
            </div>
            <div className="text-sm text-cinema-textMuted mt-1">
              Yalnızca dizi izleme ve bölüm/puan sinyallerinden üretilir
            </div>
          </div>
          <div className="text-right">
            <div className="metric-value text-2xl font-bold text-cinema-textPrimary">
              {seriesCount}
            </div>
            <div className="text-[11px] text-cinema-textMuted">Dizi Kanıtı</div>
          </div>
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="glass-panel rounded-2xl p-8 text-center text-sm text-cinema-textMuted">
          Film ve dizi zevk farklarını karşılaştırmak için hem film hem de dizi puanladığında ayrışan eğilimler burada vurgulanır.
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {rows.map((row) => {
            const isDivergent = row.mKnown && row.sKnown && row.absDiff >= 15;
            const leanLabel = !row.mKnown
              ? "Yalnızca dizilerde kanıt var"
              : !row.sKnown
                ? "Yalnızca filmlerde kanıt var"
                : row.diff > 10
                  ? "Filmlerde daha baskın"
                  : row.diff < -10
                    ? "Dizilerde daha baskın"
                    : "İki medyada dengeli";

            return (
              <GlassCard
                key={row.id}
                glow={isDivergent ? "gold" : "none"}
                ariaLabel={`${row.title} film ve dizi karşılaştırma kanıtlarını aç`}
                onClick={() => onSelectMetric(row.id)}
                className="flex flex-col justify-between group"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-[11px] font-mono uppercase tracking-wider text-cinema-textMuted">
                      {row.category} · {leanLabel}
                    </div>
                    <h4 className="text-base font-semibold text-cinema-textPrimary group-hover:text-cinema-gold transition-colors mt-1">
                      {row.title}
                    </h4>
                  </div>

                  {isDivergent && (
                    <span className="inline-flex items-center gap-1 text-[11px] font-mono tabular-nums text-cinema-gold">
                      <ArrowLeftRight className="w-3.5 h-3.5" aria-hidden="true" />
                      <span>Fark {row.absDiff}</span>
                    </span>
                  )}
                </div>

                <div className="mt-4 pt-3 border-t border-white/5 flex items-center justify-between gap-4">
                  <div className="flex items-center gap-5">
                    <div>
                      <div className="text-[11px] text-cinema-textMuted">Film</div>
                      <div className="metric-value text-lg font-bold text-cinema-gold">
                        {row.mKnown
                          ? row.movieScore > 0
                            ? `+${row.movieScore}`
                            : row.movieScore
                          : "—"}
                      </div>
                    </div>
                    <div>
                      <div className="text-[11px] text-cinema-textMuted">Dizi</div>
                      <div className="metric-value text-lg font-bold text-cinema-cyan">
                        {row.sKnown
                          ? row.seriesScore > 0
                            ? `+${row.seriesScore}`
                            : row.seriesScore
                          : "—"}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-1 text-xs text-cinema-textMuted group-hover:text-cinema-textPrimary">
                    <span>Kanıtlar</span>
                    <ChevronRight className="w-4 h-4" aria-hidden="true" />
                  </div>
                </div>
              </GlassCard>
            );
          })}
        </div>
      )}

      {seriesOnlyRows.length > 0 && (
        <div className="rounded-2xl bg-cinema-surface/40 border border-white/10 p-5">
          <h4 className="text-xs font-mono uppercase tracking-wider text-cinema-textMuted mb-3">
            Yalnızca Dizilere Özgü Biçim Metrikleri
          </h4>
          <div className="flex flex-wrap gap-3">
            {seriesOnlyRows.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => onSelectMetric(item.id)}
                className="px-4 py-2.5 rounded-xl bg-cinema-bg/70 border border-white/10 hover:border-cinema-cyan/40 transition-colors flex items-center gap-3 text-left"
              >
                <span className="text-sm font-medium text-cinema-textPrimary">
                  {item.title}
                </span>
                <span className="metric-value text-sm font-bold text-cinema-cyan">
                  {item.known ? (item.score > 0 ? `+${item.score}` : item.score) : "Veri Yok"}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
