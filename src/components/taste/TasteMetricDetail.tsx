// ===========================================================================
// CineTrack — Derin Sinema Metrik Detay & Kanıt Listesi Modalı ("Bunu Nasıl Bildik?")
// Gerçek zenginleştirilmiş katalog kanıtları + V1.5 "Bu yapımda yok" itiraz aksiyonu
// ===========================================================================

import React, { useCallback, useEffect, useState } from "react";
import { motion } from "framer-motion";
import {
  AlertCircle,
  Film,
  FlagOff,
  GitBranch,
  Info,
  TrendingDown,
  TrendingUp,
  X,
} from "lucide-react";
import type { TasteProfile } from "../../core/taste/types.ts";
import type {
  EvidenceItem,
  MetricExplanation,
} from "../../core/taste/profile-explainer.ts";
import {
  getCategoryDisplayLabel,
  getMetricDisplayTitle,
  getStatusLabelTr,
  resolveEffectiveMetricView,
} from "../../core/taste/metric-labels.ts";
import {
  fetchMetricDetail,
  postFeatureObjection,
  subscribeTasteProfileUpdated,
  type OverrideRequest,
} from "../../services/taste-api.ts";
import { imageUrl } from "../../utils/helpers.ts";
import { TastePreferenceEditor } from "./TastePreferenceEditor.tsx";

export interface TasteMetricDetailProps {
  metricId: string;
  onClose?: () => void;
  onOverride?: (req: OverrideRequest) => Promise<void>;
  onRemoveOverride?: (metricId: string) => Promise<void>;
}

const EvidenceThumbnail: React.FC<{ posterPath?: string | null; title: string }> = ({
  posterPath,
  title,
}) => {
  const [failed, setFailed] = useState(false);
  const src = posterPath && !failed ? imageUrl(posterPath, "w92") : "";

  if (!src) {
    return (
      <div className="w-10 h-14 bg-cinema-surfaceHover border border-white/10 rounded-lg flex items-center justify-center shrink-0">
        <Film className="w-4 h-4 text-cinema-textMuted" aria-hidden="true" />
      </div>
    );
  }

  return (
    <img
      src={src}
      alt={title}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className="w-10 h-14 object-cover rounded-lg border border-white/10 shrink-0"
    />
  );
};

interface EvidenceRowProps {
  item: EvidenceItem;
  tone: "positive" | "negative" | "neutral";
  objectingId: string | null;
  onObjectFeature: (contentId: string) => void;
}

const EvidenceRow: React.FC<EvidenceRowProps> = ({
  item,
  tone,
  objectingId,
  onObjectFeature,
}) => {
  const resolvedTitle = item.title || item.contentId;
  const mediaLabel =
    item.mediaType === "tv"
      ? "Dizi"
      : item.mediaType === "movie"
        ? "Film"
        : item.contentId.startsWith("tv:")
          ? "Dizi"
          : "Film";
  const metaParts: string[] = [];
  if (item.year) metaParts.push(String(item.year));
  metaParts.push(mediaLabel);
  if (typeof item.personalRating === "number" && item.personalRating > 0) {
    metaParts.push(`Puanın: ${item.personalRating}/10`);
  }

  const signedContribution = Math.round(item.contribution * 100);
  const formattedContribution =
    signedContribution > 0 ? `+${signedContribution}` : `${signedContribution}`;

  const rowClasses =
    tone === "positive"
      ? "bg-cinema-bg/70 border-white/5 hover:border-cinema-gold/30"
      : tone === "negative"
        ? "bg-cinema-bg/70 border-white/5 hover:border-cinema-danger/30 opacity-90"
        : "bg-cinema-bg/60 border-white/5";

  const scoreColor =
    tone === "positive"
      ? "text-cinema-gold"
      : tone === "negative"
        ? "text-cinema-danger"
        : "text-cinema-textMuted";

  const isBusy = objectingId === item.contentId;

  return (
    <div
      className={`flex items-center justify-between gap-3 p-3 rounded-xl border transition-colors ${rowClasses}`}
    >
      <div className="flex items-center gap-3 min-w-0">
        <EvidenceThumbnail posterPath={item.posterPath} title={resolvedTitle} />
        <div className="min-w-0">
          <div className="text-sm font-medium text-cinema-textPrimary truncate">
            {resolvedTitle}
          </div>
          <div className="text-xs text-cinema-textMuted truncate">
            {metaParts.join(" · ")}
          </div>
        </div>
      </div>

      <div className="flex items-center gap-3 shrink-0">
        <div className="text-right">
          <div className={`metric-value text-sm font-bold ${scoreColor}`}>
            {formattedContribution}
          </div>
          <div className="text-[11px] text-cinema-textMuted">Etki</div>
        </div>
        <button
          type="button"
          disabled={isBusy}
          onClick={() => onObjectFeature(item.contentId)}
          title="Bu yapımda bu özellik/etiket bulunmuyorsa kanıtlardan çıkar"
          aria-label={`${resolvedTitle} için bu özellik etiketine itiraz et`}
          className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-white/10 bg-white/5 hover:bg-cinema-danger/15 hover:border-cinema-danger/40 hover:text-cinema-danger text-[11px] font-medium text-cinema-textMuted transition-colors disabled:opacity-50"
        >
          <FlagOff className="w-3.5 h-3.5" aria-hidden="true" />
          <span className="hidden sm:inline">
            {isBusy ? "Kaldırılıyor…" : "Bu yapımda yok"}
          </span>
        </button>
      </div>
    </div>
  );
};

export const TasteMetricDetail: React.FC<TasteMetricDetailProps> = ({
  metricId,
  onClose,
  onOverride,
  onRemoveOverride,
}) => {
  const [metric, setMetric] = useState<TasteProfile["metrics"][string] | null>(null);
  const [explanation, setExplanation] = useState<MetricExplanation | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [objectingId, setObjectingId] = useState<string | null>(null);
  const [objectionNotice, setObjectionNotice] = useState<string | null>(null);

  const loadDetail = useCallback(
    (silent: boolean) => {
      if (!silent) {
        setLoading(true);
      }
      setError(null);
      fetchMetricDetail(metricId)
        .then(({ metric: m, explanation: ex }) => {
          setMetric(m);
          setExplanation(ex);
        })
        .catch((err: unknown) => {
          setError(err instanceof Error ? err.message : "Metrik detayı yüklenemedi");
        })
        .finally(() => {
          if (!silent) {
            setLoading(false);
          }
        });
    },
    [metricId]
  );

  useEffect(() => {
    setObjectionNotice(null);
    loadDetail(false);
    const unsub = subscribeTasteProfileUpdated(() => {
      loadDetail(true);
    });
    return () => {
      unsub();
    };
  }, [loadDetail]);

  useEffect(() => {
    if (!onClose) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const handleObjectFeature = async (contentId: string) => {
    setObjectingId(contentId);
    setObjectionNotice(null);
    try {
      await postFeatureObjection(contentId, metricId);
      setObjectionNotice(
        "İtiraz kaydedildi: İçerik bu metriğin kanıtlarından çıkarıldı ve profil güncellendi."
      );
      loadDetail(true);
    } catch {
      setObjectionNotice("İtiraz kaydedilirken bir sorun oluştu.");
    } finally {
      setObjectingId(null);
    }
  };

  const renderBody = () => {
    if (loading) {
      return (
        <div className="p-8 text-center text-sm text-cinema-textMuted" role="status" aria-busy="true">
          Metrik kanıtları ve eğilim analizi yükleniyor…
        </div>
      );
    }

    if (error || !metric || !explanation) {
      return (
        <div className="p-8 flex items-center gap-3 text-sm text-cinema-danger" role="alert">
          <AlertCircle className="w-5 h-5 shrink-0" />
          <span>{error ?? "Metrik bilgisi bulunamadı."}</span>
        </div>
      );
    }

    const view = resolveEffectiveMetricView(metric);
    const displayTitle = getMetricDisplayTitle(metricId);
    const categoryLabel = getCategoryDisplayLabel(explanation.definition.categoryId);
    const hasAnyEvidence =
      explanation.positiveEvidence.length > 0 ||
      explanation.negativeEvidence.length > 0 ||
      explanation.neutralEvidence.length > 0;

    return (
      <>
        {/* Üst Başlık */}
        <div className="p-6 border-b border-white/10 flex items-start justify-between gap-4 bg-cinema-surface">
          <div>
            <span className="text-xs font-semibold uppercase tracking-widest text-cinema-gold">
              {categoryLabel} · {getStatusLabelTr(view.effectiveStatus)}
            </span>
            <h2
              id="taste-metric-modal-title"
              className="text-2xl font-display font-bold text-cinema-textPrimary mt-1"
            >
              {displayTitle}
            </h2>
            <p className="text-sm text-cinema-textMuted mt-1 leading-relaxed">
              {explanation.definition.definition}
            </p>
          </div>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              aria-label="Kapat"
              className="p-2 rounded-xl bg-white/5 hover:bg-white/10 text-cinema-textMuted hover:text-cinema-textPrimary transition-colors shrink-0"
            >
              <X className="w-5 h-5" />
            </button>
          )}
        </div>

        {/* Kaydırılabilir Gövde */}
        <div className="p-6 overflow-y-auto space-y-6 flex-1">
          {/* Afinite Özeti */}
          <div className="flex flex-wrap items-center justify-between gap-4 p-4 rounded-xl bg-white/5 border border-white/10">
            <div>
              <div className="text-xs text-cinema-textMuted">
                {view.hasOverride ? "Aktif Eğilim Skoru (Manuel Ayarlı)" : "Otomatik Hesaplanan Afinite"}
              </div>
              <div
                className={`metric-value text-3xl font-bold mt-0.5 ${
                  view.isExcluded
                    ? "text-cinema-danger"
                    : view.effectiveAffinity > 0
                      ? "text-cinema-gold"
                      : view.effectiveAffinity < 0
                        ? "text-cinema-danger"
                        : "text-cinema-textPrimary"
                }`}
              >
                {view.isExcluded
                  ? "Hariç"
                  : view.effectiveAffinity > 0
                    ? `+${view.effectiveAffinity}`
                    : view.effectiveAffinity}
              </div>
              {view.hasOverride && (
                <div className="text-xs text-cinema-textMuted mt-1">
                  Algoritmik temel skor:{" "}
                  <span className="metric-value text-cinema-textPrimary font-semibold">
                    {view.computedAffinity > 0
                      ? `+${view.computedAffinity}`
                      : view.computedAffinity}
                  </span>
                </div>
              )}
            </div>

            <div className="max-w-xs text-right">
              <div className="flex items-center justify-end gap-1.5 text-xs text-cinema-cyan mb-1 font-medium">
                <Info className="w-3.5 h-3.5 shrink-0" />
                <span className="metric-value">
                  Uzun Vadeli: {metric.longTermAffinity > 0 ? `+${metric.longTermAffinity}` : metric.longTermAffinity} · Güncel: {metric.recentAffinity > 0 ? `+${metric.recentAffinity}` : metric.recentAffinity}
                </span>
              </div>
              <p className="text-xs text-cinema-textMuted leading-relaxed">
                Skor; izlediğin, tamamladığın ve puanladığın yapımların ağırlıklı sinyallerinden hesaplanır.
              </p>
            </div>
          </div>

          {/* Manuel Kontrol Paneli */}
          <TastePreferenceEditor
            metricId={metricId}
            currentValue={metric.affinity}
            currentOverride={metric.manualOverride}
            onOverride={onOverride}
            onRemoveOverride={onRemoveOverride}
          />

          {objectionNotice && (
            <div
              className="p-3 rounded-xl bg-cinema-cyanDim border border-cinema-cyan/30 text-xs text-cinema-cyan"
              role="status"
              aria-live="polite"
            >
              {objectionNotice}
            </div>
          )}

          {/* Bunu Nasıl Bildik? — Kanıt Listesi */}
          <div className="space-y-5">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-semibold text-cinema-textPrimary">
                Bunu Nasıl Bildik?
              </h3>
              <span className="text-[11px] text-cinema-textMuted">
                Hatalı etiketlenmiş yapımları &ldquo;Bu yapımda yok&rdquo; ile çıkarabilirsin
              </span>
            </div>

            {!hasAnyEvidence && (
              <div className="p-5 rounded-xl bg-cinema-bg/60 border border-white/5 text-xs text-cinema-textMuted leading-relaxed">
                Bu metrik için henüz yeterli izleme veya puanlama kanıtı birikmedi. Kütüphanendeki yapımları puanladıkça kanıtlar burada otomatik listelenir; dilersen yukarıdan manuel tercih belirleyebilirsin.
              </div>
            )}

            {explanation.positiveEvidence.length > 0 && (
              <div>
                <h4 className="text-xs font-semibold text-cinema-textPrimary flex items-center gap-2 mb-2.5">
                  <TrendingUp className="w-4 h-4 text-cinema-gold" />
                  <span>Tercihini Güçlendiren İçerikler</span>
                </h4>
                <div className="space-y-2">
                  {explanation.positiveEvidence.map((item) => (
                    <EvidenceRow
                      key={item.contentId}
                      item={item}
                      tone="positive"
                      objectingId={objectingId}
                      onObjectFeature={(cid) => void handleObjectFeature(cid)}
                    />
                  ))}
                </div>
              </div>
            )}

            {explanation.negativeEvidence.length > 0 && (
              <div>
                <h4 className="text-xs font-semibold text-cinema-textPrimary flex items-center gap-2 mb-2.5">
                  <TrendingDown className="w-4 h-4 text-cinema-danger" />
                  <span>Tercihini Zayıflatan İçerikler</span>
                </h4>
                <div className="space-y-2">
                  {explanation.negativeEvidence.map((item) => (
                    <EvidenceRow
                      key={item.contentId}
                      item={item}
                      tone="negative"
                      objectingId={objectingId}
                      onObjectFeature={(cid) => void handleObjectFeature(cid)}
                    />
                  ))}
                </div>
              </div>
            )}

            {explanation.positiveEvidence.length === 0 &&
              explanation.negativeEvidence.length === 0 &&
              explanation.neutralEvidence.length > 0 && (
                <div>
                  <h4 className="text-xs font-semibold text-cinema-textPrimary mb-2.5">
                    Dengeli / Nötr Sinyaller
                  </h4>
                  <div className="space-y-2">
                    {explanation.neutralEvidence.map((item) => (
                      <EvidenceRow
                        key={item.contentId}
                        item={item}
                        tone="neutral"
                        objectingId={objectingId}
                        onObjectFeature={(cid) => void handleObjectFeature(cid)}
                      />
                    ))}
                  </div>
                </div>
              )}
          </div>

          {/* İlgili Metrikler */}
          {explanation.relatedMetrics.length > 0 && (
            <div className="pt-4 border-t border-white/10">
              <h4 className="text-xs font-semibold uppercase tracking-wider text-cinema-textMuted flex items-center gap-1.5 mb-3">
                <GitBranch className="w-3.5 h-3.5 text-cinema-cyan" />
                <span>İlişkili Metrikler</span>
              </h4>
              <div className="flex flex-wrap gap-2">
                {explanation.relatedMetrics.map((rm) => (
                  <div
                    key={rm.metricId}
                    className="px-3 py-1.5 rounded-lg bg-cinema-bg/70 border border-white/10 text-xs text-cinema-textPrimary flex items-center gap-2"
                  >
                    <span>{getMetricDisplayTitle(rm.metricId)}</span>
                    <span className="metric-value text-cinema-gold font-semibold">
                      {rm.affinity > 0 ? `+${rm.affinity}` : rm.affinity}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </>
    );
  };

  if (!onClose) {
    return (
      <article
        aria-labelledby="taste-metric-modal-title"
        className="glass-panel rounded-2xl overflow-hidden flex flex-col border border-white/10"
      >
        {renderBody()}
      </article>
    );
  }

  return (
    <motion.div
      role="presentation"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md"
    >
      <motion.div
        role="dialog"
        aria-modal="true"
        aria-labelledby="taste-metric-modal-title"
        initial={{ scale: 0.96, y: 16, opacity: 0 }}
        animate={{ scale: 1, y: 0, opacity: 1 }}
        exit={{ scale: 0.96, y: 16, opacity: 0 }}
        transition={{ duration: 0.2 }}
        className="glass-panel w-full max-w-2xl rounded-2xl overflow-hidden flex flex-col max-h-[88vh] border border-white/15"
      >
        {renderBody()}
      </motion.div>
    </motion.div>
  );
};
