import React, { useEffect, useState, useCallback } from 'react';
import {
  computeStockHealthMetrics,
  type StockHealthMetrics,
} from '../services/stock-health-service';

interface StockHealthPanelProps {
  isOpen: boolean;
  onClose: () => void;
  stockSignature?: string;
}

export const StockHealthPanel: React.FC<StockHealthPanelProps> = ({
  isOpen,
  onClose,
  stockSignature = '',
}) => {
  const [metrics, setMetrics] = useState<StockHealthMetrics | null>(null);
  const [loading, setLoading] = useState<boolean>(false);

  const refreshMetrics = useCallback(async () => {
    setLoading(true);
    try {
      const computed = await computeStockHealthMetrics();
      setMetrics(computed);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isOpen) {
      void refreshMetrics();
    }
  }, [isOpen, stockSignature, refreshMetrics]);

  if (!isOpen) return null;

  return (
    <section
      className="stock-health-panel tabular-nums"
      aria-label="Stok Kalitesi ve Önbellek Sağlığı"
    >
      <header className="stock-health-header">
        <div>
          <h4 className="stock-health-title">Stok Kalitesi & Depo Sağlığı</h4>
          <p className="stock-health-subtitle">
            MMR çeşitlilik denetimi, özellik vektörü doluluğu ve yerel önbellek kotaları
          </p>
        </div>
        <div className="stock-health-actions">
          <button
            type="button"
            className="btn btn-sm whitespace-nowrap"
            disabled={loading}
            onClick={() => void refreshMetrics()}
          >
            {loading ? 'Ölçülüyor…' : 'Yenile'}
          </button>
          <button
            type="button"
            className="btn btn-sm whitespace-nowrap"
            onClick={onClose}
            aria-label="Stok sağlık panelini kapat"
          >
            Kapat
          </button>
        </div>
      </header>

      {metrics && (
        <div className="stock-health-grid">
          {/* 1. MMR Diversity */}
          <div className="stock-health-card">
            <span className="stock-health-label">MMR Çeşitlilik Skoru</span>
            <strong className="stock-health-value">
              %{metrics.diversityScorePercent} çeşitlilik
            </strong>
            <span className="stock-health-meta">
              Ort. ikili benzerlik: {metrics.avgPairwiseSimilarity.toFixed(3)} ·{' '}
              {metrics.clusterThresholdCompliant ? 'Küme sınırı (<0.88) uygun' : 'Küme yoğun'}
            </span>
            <svg
              className="stock-health-bar-svg"
              viewBox="0 0 100 6"
              preserveAspectRatio="none"
              aria-hidden="true"
            >
              <rect className="stock-health-bar-track" x="0" y="0" width="100" height="6" rx="3" />
              <rect
                className="stock-health-bar-fill fill-emerald"
                x="0"
                y="0"
                width={Math.max(2, metrics.diversityScorePercent)}
                height="6"
                rx="3"
              />
            </svg>
          </div>

          {/* 2. Encoding & Enrichment Fill */}
          <div className="stock-health-card">
            <span className="stock-health-label">Vektör & Kadro Doluluğu</span>
            <strong className="stock-health-value">
              %{metrics.encodedFillPercent} vektör · %{metrics.enrichedCreditsPercent} zengin
            </strong>
            <span className="stock-health-meta">
              {metrics.totalStockCount} stok ({metrics.moviesCount} film + {metrics.tvCount} dizi) ·{' '}
              Boşta kota: {metrics.idleQuotaUsed}/{metrics.idleQuotaLimit}
            </span>
            <svg
              className="stock-health-bar-svg"
              viewBox="0 0 100 6"
              preserveAspectRatio="none"
              aria-hidden="true"
            >
              <rect className="stock-health-bar-track" x="0" y="0" width="100" height="6" rx="3" />
              <rect
                className="stock-health-bar-fill fill-indigo"
                x="0"
                y="0"
                width={Math.max(2, metrics.encodedFillPercent)}
                height="6"
                rx="3"
              />
            </svg>
          </div>

          {/* 3. Encodings Depot Usage */}
          <div className="stock-health-card">
            <span className="stock-health-label">ct:encodings Depo Kotası</span>
            <strong className="stock-health-value">
              {metrics.encodingsDepotCount} / {metrics.encodingsDepotMax}
            </strong>
            <span className="stock-health-meta">
              LRU tavan kullanım oranı: %{metrics.encodingsUsagePercent}
            </span>
            <svg
              className="stock-health-bar-svg"
              viewBox="0 0 100 6"
              preserveAspectRatio="none"
              aria-hidden="true"
            >
              <rect className="stock-health-bar-track" x="0" y="0" width="100" height="6" rx="3" />
              <rect
                className="stock-health-bar-fill fill-sky"
                x="0"
                y="0"
                width={Math.max(2, metrics.encodingsUsagePercent)}
                height="6"
                rx="3"
              />
            </svg>
          </div>

          {/* 4. Poster Cache Usage */}
          <div className="stock-health-card">
            <span className="stock-health-label">Poster Önbelleği (200 MiB)</span>
            <strong className="stock-health-value">
              {metrics.posterCacheSizeMb} / {metrics.posterCacheMaxMb} MiB
            </strong>
            <span className="stock-health-meta">
              {metrics.posterCacheCount} önbellek görseli · %{metrics.posterCacheUsagePercent} dolu
            </span>
            <svg
              className="stock-health-bar-svg"
              viewBox="0 0 100 6"
              preserveAspectRatio="none"
              aria-hidden="true"
            >
              <rect className="stock-health-bar-track" x="0" y="0" width="100" height="6" rx="3" />
              <rect
                className="stock-health-bar-fill fill-amber"
                x="0"
                y="0"
                width={Math.max(2, metrics.posterCacheUsagePercent)}
                height="6"
                rx="3"
              />
            </svg>
          </div>
        </div>
      )}
    </section>
  );
};
