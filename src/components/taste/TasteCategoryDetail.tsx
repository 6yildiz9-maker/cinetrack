// ===========================================================================
// CineTrack — Kategori Altı Toplu Görünüm
// Bir kategori içindeki tüm metrikleri liste halinde gösterir
// ===========================================================================

import React, { useState } from "react";
import type { TasteProfile, MetricDefinition } from "../../core/taste/types";
import { TasteMetricDetail } from "./TasteMetricDetail";
import {
  postManualOverride,
  deleteManualOverride,
  type OverrideRequest,
} from "../../services/taste-api";

interface CategoryMetricEntry {
  definition: MetricDefinition;
  profileMetric: TasteProfile["metrics"][string] | null;
}

interface TasteCategoryDetailProps {
  categoryId: string;
  metrics: CategoryMetricEntry[];
  profile: TasteProfile;
}

export function TasteCategoryDetail({
  categoryId,
  metrics,
  profile: _profile,
}: TasteCategoryDetailProps) {
  void _profile;
  const [expandedMetricId, setExpandedMetricId] = useState<string | null>(null);
  const [overrideLoading, setOverrideLoading] = useState(false);

  const handleOverride = async (req: OverrideRequest) => {
    setOverrideLoading(true);
    try {
      await postManualOverride(req);
    } finally {
      setOverrideLoading(false);
    }
  };

  const handleRemoveOverride = async (metricId: string) => {
    setOverrideLoading(true);
    try {
      await deleteManualOverride(metricId);
    } finally {
      setOverrideLoading(false);
    }
  };

  if (metrics.length === 0) {
    return (
      <p className="category-detail--empty">
        Bu kategoride henüz metrik yok.
      </p>
    );
  }

  // Afiniteye göre sırala (en yüksek önce)
  const sorted = [...metrics].sort((a, b) => {
    const aAff = a.profileMetric?.affinity ?? 0;
    const bAff = b.profileMetric?.affinity ?? 0;
    return bAff - aAff;
  });

  return (
    <div className="category-detail" aria-label={`${categoryId} kategorisi`}>
      {overrideLoading && (
        <div role="status" aria-live="polite" className="category-detail__overlay">
          İşleniyor…
        </div>
      )}

      <ul className="category-detail__list">
        {sorted.map(({ definition, profileMetric }) => {
          const affinity = profileMetric?.affinity ?? 0;
          const status = profileMetric?.status ?? "unknown";
          const isExpanded = expandedMetricId === definition.id;
          const hasOverride = !!profileMetric?.manualOverride;

          return (
            <li
              key={definition.id}
              className={`category-metric-row ${isExpanded ? "category-metric-row--expanded" : ""}`}
            >
              <button
                type="button"
                className="category-metric-row__header"
                aria-expanded={isExpanded}
                aria-controls={`metric-panel-${definition.id}`}
                onClick={() =>
                  setExpandedMetricId(isExpanded ? null : definition.id)
                }
              >
                <span className="category-metric-row__name">
                  {definition.definition}
                  {hasOverride && (
                    <span
                      className="category-metric-row__override-badge"
                      title="Manuel kontrol uygulandı"
                      aria-label="Manuel kontrol"
                    >
                      ✎
                    </span>
                  )}
                </span>
                <span
                  className={`category-metric-row__affinity category-metric-row__affinity--${
                    affinity > 20 ? "pos" : affinity < -20 ? "neg" : "neu"
                  }`}
                  aria-label={`Afinite: ${affinity}`}
                >
                  {affinity > 0 ? "+" : ""}
                  {affinity}
                </span>
                <span className="category-metric-row__status">{status}</span>
              </button>

              {isExpanded && (
                <div
                  id={`metric-panel-${definition.id}`}
                  className="category-metric-row__panel"
                  role="region"
                >
                  <TasteMetricDetail
                    metricId={definition.id}
                    onOverride={handleOverride}
                    onRemoveOverride={handleRemoveOverride}
                  />
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
