import React, { useEffect, useMemo, useState } from 'react';
import type { SavedItem } from '../core/cinetrack-core.ts';
import {
  detectDuplicateSavedItems,
  type DuplicatePairCandidate,
} from '../core/duplicate-detector.ts';

const NO_CANDIDATES: DuplicatePairCandidate[] = [];

interface DuplicateMergePanelProps {
  items: SavedItem[];
  onMergePair?: (
    keepId: SavedItem['id'],
    dropId: SavedItem['id'],
    mediaType: 'movie' | 'tv'
  ) => void;
}

function statusLabelTr(status: SavedItem['status']): string {
  if (status === 'completed') return 'İzlendi';
  if (status === 'watching') return 'İzleniyor';
  return 'İzlenecek';
}

export const DuplicateMergePanel: React.FC<DuplicateMergePanelProps> = ({
  items,
  onMergePair,
}) => {
  const [dismissedIds, setDismissedIds] = useState<Record<string, boolean>>({});
  const [candidates, setCandidates] = useState<DuplicatePairCandidate[]>(NO_CANDIDATES);

  // Tarama binlerce kaydı karşılaştırır; render sırasında yapılırsa listenin açılışını
  // bloklar. Liste boyandıktan ve kullanıcı listeyi değiştirmeyi bırakıp sonra hesaplanır.
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      if (!cancelled) setCandidates(items.length > 1 ? detectDuplicateSavedItems(items) : NO_CANDIDATES);
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [items]);
  const visibleCandidates = useMemo(
    () => candidates.filter((pair) => !dismissedIds[pair.pairId]),
    [candidates, dismissedIds]
  );

  if (!onMergePair || visibleCandidates.length === 0) {
    return null;
  }

  const renderPairRow = (pair: DuplicatePairCandidate) => {
    const primaryYear = (
      pair.primaryItem.release_date ||
      pair.primaryItem.first_air_date ||
      ''
    ).slice(0, 4);
    const secondaryYear = (
      pair.secondaryItem.release_date ||
      pair.secondaryItem.first_air_date ||
      ''
    ).slice(0, 4);

    return (
      <div key={pair.pairId} className="duplicate-pair-row tabular-nums">
        <div className="duplicate-pair-info">
          <div className="duplicate-pair-titles">
            <strong>{pair.primaryItem.title || pair.primaryItem.name}</strong>
            <span className="duplicate-id-meta">
              ({primaryYear || '—'} · #{String(pair.primaryItem.id)} ·{' '}
              {statusLabelTr(pair.primaryItem.status)}
              {typeof pair.primaryItem.personal_rating === 'number'
                ? ` · ★${pair.primaryItem.personal_rating}`
                : ''}
              )
            </span>
            <span className="duplicate-arrow" aria-hidden="true">
              ↔
            </span>
            <strong>{pair.secondaryItem.title || pair.secondaryItem.name}</strong>
            <span className="duplicate-id-meta">
              ({secondaryYear || '—'} · #{String(pair.secondaryItem.id)} ·{' '}
              {statusLabelTr(pair.secondaryItem.status)}
              {typeof pair.secondaryItem.personal_rating === 'number'
                ? ` · ★${pair.secondaryItem.personal_rating}`
                : ''}
              )
            </span>
          </div>
          <div className="duplicate-pair-reason">{pair.reason}</div>
        </div>

        <div className="duplicate-pair-actions">
          <button
            type="button"
            className="btn btn-primary btn-sm whitespace-nowrap"
            onClick={() =>
              onMergePair(pair.primaryItem.id, pair.secondaryItem.id, pair.mediaType)
            }
          >
            Bunları Birleştir
          </button>
          <button
            type="button"
            className="btn btn-sm whitespace-nowrap"
            onClick={() =>
              setDismissedIds((prev) => ({ ...prev, [pair.pairId]: true }))
            }
          >
            Yoksay
          </button>
        </div>
      </div>
    );
  };

  return (
    <section
      className="duplicate-merge-panel"
      aria-label="Olası Çift Kayıt Bildirimi"
    >
      <header className="duplicate-merge-header">
        <div>
          <h4 className="duplicate-merge-title tabular-nums">
            Olası Çift Kayıt Algılandı ({visibleCandidates.length})
          </h4>
          <p className="duplicate-merge-subtitle">
            Farklı ID veya dil başlığıyla kaydedilmiş aynı yapımlar bulundu. Onayınızla puan,
            durum ve ilerleme kayıpsız birleştirilir.
          </p>
        </div>
      </header>

      <div className="duplicate-merge-list">
        {visibleCandidates.slice(0, 5).map(renderPairRow)}
      </div>
    </section>
  );
};
