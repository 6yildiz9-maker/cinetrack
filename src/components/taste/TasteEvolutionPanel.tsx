import React from "react";
import { Calendar, TrendingDown, TrendingUp } from "lucide-react";
import type {
  MonthlyTasteSnapshotClient,
  TasteDriftAlertClient,
} from "../../services/taste-api";
import { getMetricDisplayTitle } from "../../core/taste/metric-labels";
import { GlassCard } from "../ui/GlassCard";

export interface TasteEvolutionPanelProps {
  snapshots: MonthlyTasteSnapshotClient[];
  drifts: TasteDriftAlertClient[];
  onSelectMetric: (metricId: string) => void;
}

const MONTH_NAMES_TR: Record<string, string> = {
  "01": "Ocak",
  "02": "Şubat",
  "03": "Mart",
  "04": "Nisan",
  "05": "Mayıs",
  "06": "Haziran",
  "07": "Temmuz",
  "08": "Ağustos",
  "09": "Eylül",
  "10": "Ekim",
  "11": "Kasım",
  "12": "Aralık",
};

function formatYearMonthTr(ym: string): string {
  const [year, month] = ym.split("-");
  if (!year || !month) return ym;
  return `${MONTH_NAMES_TR[month] || month} ${year}`;
}

export const TasteEvolutionPanel: React.FC<TasteEvolutionPanelProps> = ({
  snapshots,
  drifts,
  onSelectMetric,
}) => {
  return (
    <div className="space-y-6">
      {/* Zevk Kayması (Drift) Bildirimleri */}
      <div className="space-y-3">
        <div>
          <h3 className="text-base font-semibold text-cinema-textPrimary">
            Güncel Zevk Kayması (Drift) Sinyalleri
          </h3>
          <p className="text-xs text-cinema-textMuted mt-0.5">
            Son dönem izlemelerinle uzun vadeli sinema alışkanlığın arasındaki anlamlı yön değişimleri
          </p>
        </div>

        {drifts.length === 0 ? (
          <div className="rounded-2xl bg-cinema-surface/50 border border-white/10 p-5 text-xs text-cinema-textMuted">
            Uzun vadeli zevk profilin ile güncel izlemelerin şu an uyumlu ilerliyor; belirgin bir zevk kayması algılanmadı.
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {drifts.map((drift) => {
              const isRising = drift.delta > 0;
              return (
                <GlassCard
                  key={drift.metricId}
                  glow={isRising ? "gold" : "cyan"}
                  ariaLabel={`${getMetricDisplayTitle(drift.metricId)} zevk evrimi detayını aç`}
                  onClick={() => onSelectMetric(drift.metricId)}
                  className="space-y-3"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-semibold text-cinema-textPrimary">
                      {getMetricDisplayTitle(drift.metricId)}
                    </span>
                    <span
                      className={`inline-flex items-center gap-1 metric-value text-xs font-bold ${
                        isRising ? "text-cinema-gold" : "text-cinema-cyan"
                      }`}
                    >
                      {isRising ? (
                        <TrendingUp className="w-3.5 h-3.5" aria-hidden="true" />
                      ) : (
                        <TrendingDown className="w-3.5 h-3.5" aria-hidden="true" />
                      )}
                      <span>{drift.delta > 0 ? `+${drift.delta}` : drift.delta}</span>
                    </span>
                  </div>
                  <div className="text-xs text-cinema-textMuted flex items-center justify-between pt-2 border-t border-white/5">
                    <span className="metric-value">
                      Uzun vade:{" "}
                      {drift.longTermAffinity > 0
                        ? `+${drift.longTermAffinity}`
                        : drift.longTermAffinity}
                    </span>
                    <span className="metric-value text-cinema-textPrimary">
                      Güncel:{" "}
                      {drift.recentAffinity > 0
                        ? `+${drift.recentAffinity}`
                        : drift.recentAffinity}
                    </span>
                  </div>
                </GlassCard>
              );
            })}
          </div>
        )}
      </div>

      {/* Aylık Snapshot Zaman Çizelgesi */}
      <div className="space-y-3">
        <div>
          <h3 className="text-base font-semibold text-cinema-textPrimary">
            Aylık Zevk İzi (Snapshot Zaman Çizelgesi)
          </h3>
          <p className="text-xs text-cinema-textMuted mt-0.5">
            Zaman damgalı kütüphane kayıtlarından üretilen kümülatif aylık baskın özellikler
          </p>
        </div>

        {snapshots.length === 0 ? (
          <div className="rounded-2xl bg-cinema-surface/50 border border-white/10 p-6 text-xs text-cinema-textMuted">
            Henüz tarihli etkileşim kaydı bulunmuyor. Yeni film veya dizileri puanladıkça aylık snapshot geçmişi otomatik oluşur.
          </div>
        ) : (
          <div className="space-y-3">
            {[...snapshots].reverse().map((snap) => (
              <div
                key={snap.month}
                className="rounded-2xl bg-cinema-surface/60 border border-white/10 p-4 flex flex-wrap items-center justify-between gap-4"
              >
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-xl bg-white/5 border border-white/10 flex items-center justify-center text-cinema-gold shrink-0">
                    <Calendar className="w-4 h-4" aria-hidden="true" />
                  </div>
                  <div>
                    <div className="text-sm font-semibold text-cinema-textPrimary">
                      {formatYearMonthTr(snap.month)}
                    </div>
                    <div className="text-xs text-cinema-textMuted tabular-nums">
                      {snap.contentCount} içerik · {snap.eventCount} sinyal kaydı
                    </div>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  {snap.topMetrics.length === 0 ? (
                    <span className="text-xs text-cinema-textMuted">
                      Başlangıç kalibrasyonu
                    </span>
                  ) : (
                    snap.topMetrics.map((tm) => (
                      <button
                        key={tm.metricId}
                        type="button"
                        onClick={() => onSelectMetric(tm.metricId)}
                        className="px-3 py-1.5 rounded-lg bg-cinema-bg/80 border border-white/10 hover:border-cinema-gold/40 text-xs text-cinema-textPrimary transition-colors flex items-center gap-2 whitespace-nowrap"
                      >
                        <span>{getMetricDisplayTitle(tm.metricId)}</span>
                        <span className="metric-value text-cinema-gold font-semibold">
                          +{tm.affinity}
                        </span>
                      </button>
                    ))
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
