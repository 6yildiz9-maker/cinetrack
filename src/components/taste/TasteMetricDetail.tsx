// ===========================================================================
// CineTrack — Metrik Detay Bileşeni
// Afinite + kanıt listesi + manuel kontrol
// "Bunu nasıl bildin?" prensibine uygun (L10)
// ===========================================================================

import React, { useEffect, useState } from "react";
import type { TasteProfile } from "../../core/taste/types";
import type { MetricExplanation } from "../../core/taste/profile-explainer";
import {
  fetchMetricDetail,
  subscribeTasteProfileUpdated,
  type OverrideRequest,
} from "../../services/taste-api";
import { TasteEvidenceList } from "./TasteEvidenceList";
import { TastePreferenceEditor } from "./TastePreferenceEditor";

interface TasteMetricDetailProps {
  metricId: string;
  onOverride: (req: OverrideRequest) => Promise<void>;
  onRemoveOverride: (metricId: string) => Promise<void>;
}

export function TasteMetricDetail({
  metricId,
  onOverride,
  onRemoveOverride,
}: TasteMetricDetailProps) {
  const [metric, setMetric] = useState<TasteProfile["metrics"][string] | null>(null);
  const [explanation, setExplanation] = useState<MetricExplanation | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const loadDetail = (silent: boolean) => {
      if (!silent) {
        setLoading(true);
      }
      setError(null);
      fetchMetricDetail(metricId)
        .then(({ metric: m, explanation: ex }) => {
          if (!active) return;
          setMetric(m);
          setExplanation(ex);
        })
        .catch((err: unknown) => {
          if (!active) return;
          setError(err instanceof Error ? err.message : "Metrik yüklenemedi");
        })
        .finally(() => {
          if (active && !silent) setLoading(false);
        });
    };

    loadDetail(false);
    const unsub = subscribeTasteProfileUpdated(() => {
      loadDetail(true);
    });
    return () => {
      active = false;
      unsub();
    };
  }, [metricId]);

  if (loading) {
    return (
      <div className="metric-detail metric-detail--loading" role="status" aria-busy="true">
        <p>Yükleniyor…</p>
      </div>
    );
  }

  if (error || !metric || !explanation) {
    return (
      <div className="metric-detail metric-detail--error" role="alert">
        <p>{error ?? "Metrik bulunamadı"}</p>
      </div>
    );
  }

  const affinityLabel =
    metric.affinity > 20
      ? "Sever"
      : metric.affinity < -20
      ? "Sevmez"
      : "Nötr";

  return (
    <article className="metric-detail" aria-label={explanation.definition.definition}>
      <header className="metric-detail__header">
        <h2 className="metric-detail__title">{explanation.definition.definition}</h2>
        <div className="metric-detail__affinity" aria-label={`Afinite: ${metric.affinity}`}>
          <span className="metric-detail__affinity-value">{metric.affinity}</span>
          <span className="metric-detail__affinity-label">{affinityLabel}</span>
        </div>
        <div className="metric-detail__status">
          Durum: <strong>{metric.status}</strong>
        </div>
      </header>

      {/* Kanıt listesi — "Bunu nasıl bildin?" */}
      <section className="metric-detail__evidence" aria-label="Kanıtlar">
        <h3>Bunu nasıl bildin?</h3>
        <TasteEvidenceList
          positiveEvidence={explanation.positiveEvidence}
          negativeEvidence={explanation.negativeEvidence}
          neutralEvidence={explanation.neutralEvidence}
        />
      </section>

      {/* Manuel kontrol */}
      <section className="metric-detail__controls" aria-label="Manuel kontrol">
        <TastePreferenceEditor
          metricId={metricId}
          currentOverride={metric.manualOverride}
          onOverride={onOverride}
          onRemoveOverride={onRemoveOverride}
        />
      </section>

      {/* İlgili metrikler */}
      {explanation.relatedMetrics.length > 0 && (
        <section className="metric-detail__related" aria-label="İlgili metrikler">
          <h3>İlgili Metrikler</h3>
          <ul>
            {explanation.relatedMetrics.map((rm) => (
              <li key={rm.metricId}>
                {rm.metricId} — {rm.affinity} ({rm.relationship})
              </li>
            ))}
          </ul>
        </section>
      )}
    </article>
  );
}
