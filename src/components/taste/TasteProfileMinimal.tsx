// ===========================================================================
// Cinethos — Masaüstü "Zevkim" minimal özeti
// Tam profili tek ekrana sığdırmadan en güçlü eğilimleri gösterir.
// ===========================================================================

import React, { useMemo, useState } from 'react';
import {
  AlertTriangle,
  ChevronRight,
  Minimize2,
  RefreshCw,
  Sparkles,
  TrendingDown,
  TrendingUp,
} from 'lucide-react';
import { TAXONOMY_V01 } from '../../core/taste/taxonomy.ts';
import {
  estimateMetricEvidenceCount,
  getMetricDisplayTitle,
  resolveEffectiveMetricView,
} from '../../core/taste/metric-labels.ts';
import { useTasteProfile } from '../../hooks/useTasteProfile.ts';
import { TasteProfileDashboard } from './TasteProfileDashboard.tsx';

const STRONG_TREND_COUNT = 5;
const AVOIDED_TREND_COUNT = 3;

interface TrendMetric {
  id: string;
  title: string;
  affinity: number;
  isExcluded: boolean;
}

function formatAffinity(value: number): string {
  const rounded = Math.round(value);
  return rounded > 0 ? `+${rounded}` : String(rounded);
}

function AffinityBar({ metric, tone }: { metric: TrendMetric; tone: 'gold' | 'danger' }) {
  const width = Math.min(100, Math.abs(metric.affinity));
  const barColor = tone === 'gold' ? 'bg-cinema-gold' : 'bg-cinema-danger';
  const textColor = tone === 'gold' ? 'text-cinema-gold' : 'text-cinema-danger';

  return (
    <li className="flex items-center justify-between gap-3">
      <span className="text-sm text-cinema-textPrimary truncate">{metric.title}</span>
      <span className="flex items-center gap-2 shrink-0">
        <span className="hidden sm:block h-1.5 w-24 rounded-full bg-white/10 overflow-hidden">
          <span className={`block h-full rounded-full ${barColor}`} style={{ width: `${width}%` }} />
        </span>
        <span className={`metric-value text-xs font-bold tabular-nums ${textColor}`}>
          {metric.isExcluded ? 'Hariç' : formatAffinity(metric.affinity)}
        </span>
      </span>
    </li>
  );
}

export const TasteProfileMinimal: React.FC = () => {
  const { profile, status, error, reload } = useTasteProfile();
  const [expanded, setExpanded] = useState(false);

  const summary = useMemo(() => {
    const scoredDefs = TAXONOMY_V01.filter((def) => def.scoringEnabled);
    let knownCount = 0;
    let evidenceTotal = 0;
    const trends: TrendMetric[] = [];

    for (const def of scoredDefs) {
      const rawMetric = profile?.metrics?.[def.id] ?? null;
      const view = resolveEffectiveMetricView(rawMetric);
      evidenceTotal += estimateMetricEvidenceCount(rawMetric);

      if (view.effectiveStatus === 'unknown' && !view.hasOverride) continue;
      knownCount += 1;
      trends.push({
        id: def.id,
        title: getMetricDisplayTitle(def.id),
        affinity: view.effectiveAffinity,
        isExcluded: view.isExcluded,
      });
    }

    const strong = trends
      .filter((metric) => !metric.isExcluded && metric.affinity > 0)
      .sort((left, right) => right.affinity - left.affinity)
      .slice(0, STRONG_TREND_COUNT);

    const avoided = trends
      .filter((metric) => metric.isExcluded || metric.affinity < 0)
      .sort((left, right) => {
        const leftValue = left.isExcluded ? -1000 : left.affinity;
        const rightValue = right.isExcluded ? -1000 : right.affinity;
        return leftValue - rightValue;
      })
      .slice(0, AVOIDED_TREND_COUNT);

    return {
      totalCount: scoredDefs.length,
      knownCount,
      evidenceTotal,
      strong,
      avoided,
    };
  }, [profile]);

  if (expanded) {
    return (
      <div className="space-y-3">
        <div className="flex justify-end">
          <button type="button" className="btn-ghost text-xs" onClick={() => setExpanded(false)}>
            <Minimize2 className="w-3.5 h-3.5" aria-hidden="true" />
            <span>Minimal görünüm</span>
          </button>
        </div>
        <TasteProfileDashboard />
      </div>
    );
  }

  if (status === 'loading' && !profile) {
    return (
      <div
        className="glass-panel rounded-2xl p-8 text-center text-sm text-cinema-textMuted"
        role="status"
        aria-busy="true"
      >
        Zevkin hesaplanıyor…
      </div>
    );
  }

  if ((status === 'error' || error) && !profile) {
    return (
      <div
        className="glass-panel rounded-2xl p-6 flex flex-wrap items-center justify-between gap-4 border border-cinema-danger/40"
        role="alert"
      >
        <div className="flex items-center gap-3 text-sm text-cinema-danger">
          <AlertTriangle className="w-5 h-5 shrink-0" />
          <span>Zevk profili yüklenemedi: {error}</span>
        </div>
        <button type="button" onClick={() => void reload()} className="btn-ghost text-xs">
          Yeniden Dene
        </button>
      </div>
    );
  }

  return (
    <section aria-label="Zevkim özeti" className="w-full text-cinema-textPrimary py-2 space-y-4">
      <header className="rounded-2xl border border-white/10 bg-cinema-surface/80 p-5 sm:p-6 flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="inline-flex items-center gap-2 text-cinema-gold text-[11px] font-semibold uppercase tracking-widest">
            <Sparkles className="w-3.5 h-3.5" aria-hidden="true" />
            <span>Algoritmik Zevk Profili</span>
          </div>
          <h1 className="text-2xl sm:text-3xl font-display font-bold tracking-tight mt-1">
            Zevkim
          </h1>
          <p className="mt-1 text-sm text-cinema-textMuted">
            İzlediklerinden damıtılan sinema parmak izin.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="px-3.5 py-2 rounded-xl bg-cinema-bg/70 border border-white/10 text-right">
            <div className="text-[11px] text-cinema-textMuted">Aktif Metrik</div>
            <div className="metric-value text-base font-bold text-cinema-gold tabular-nums">
              {summary.knownCount}/{summary.totalCount}
            </div>
          </div>
          <div className="px-3.5 py-2 rounded-xl bg-cinema-bg/70 border border-white/10 text-right">
            <div className="text-[11px] text-cinema-textMuted">Kanıt</div>
            <div className="metric-value text-base font-bold text-cinema-textPrimary tabular-nums">
              {summary.evidenceTotal}
            </div>
          </div>
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
      </header>

      {summary.knownCount === 0 ? (
        <div className="glass-panel rounded-2xl p-6 text-sm text-cinema-textMuted">
          Henüz yeterli sinyal yok. Birkaç yapım izleyip puanladıkça zevk profilin burada
          belirginleşecek.
        </div>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          <article className="glass-panel rounded-2xl p-4 sm:p-5">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-cinema-gold">
              <TrendingUp className="w-4 h-4" aria-hidden="true" />
              Güçlü Eğilimler
            </h2>
            {summary.strong.length > 0 ? (
              <ul className="mt-3 space-y-2.5">
                {summary.strong.map((metric) => (
                  <AffinityBar key={metric.id} metric={metric} tone="gold" />
                ))}
              </ul>
            ) : (
              <p className="mt-3 text-xs text-cinema-textMuted">
                Henüz belirgin bir olumlu eğilim oluşmadı.
              </p>
            )}
          </article>

          <article className="glass-panel rounded-2xl p-4 sm:p-5">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-cinema-danger">
              <TrendingDown className="w-4 h-4" aria-hidden="true" />
              Kaçındıkların
            </h2>
            {summary.avoided.length > 0 ? (
              <ul className="mt-3 space-y-2.5">
                {summary.avoided.map((metric) => (
                  <AffinityBar key={metric.id} metric={metric} tone="danger" />
                ))}
              </ul>
            ) : (
              <p className="mt-3 text-xs text-cinema-textMuted">
                Belirgin bir kaçınma sinyali yok.
              </p>
            )}
          </article>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-cinema-textMuted">
          {summary.knownCount} metrikte sinyal var. Detaylı görünümde kanıtları inceleyip
          algoritmayı yönlendirebilirsin.
        </p>
        <button type="button" className="btn-ghost text-xs" onClick={() => setExpanded(true)}>
          <span>Tüm profili gör</span>
          <ChevronRight className="w-3.5 h-3.5" aria-hidden="true" />
        </button>
      </div>
    </section>
  );
};

export default TasteProfileMinimal;
