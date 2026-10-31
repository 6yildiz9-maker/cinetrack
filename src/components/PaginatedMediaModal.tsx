import React, { useEffect, useMemo, useState } from 'react';
import { findSavedItem, makeMediaKey, type SavedItem } from '../core/cinetrack-core';
import type { TmdbItem } from '../types/tmdb';
import { useDialogAccessibility } from '../utils/useDialogAccessibility';
import { MediaCard } from './MediaCard';

export const SHELF_INITIAL_COUNT = 24;
export const MODAL_PAGE_SIZE = 40;
export const SCORE_DEBOUNCE_MS = 300;

export function sliceShelfItems<T>(
  items: readonly T[],
  limit = SHELF_INITIAL_COUNT
): { visible: T[]; remaining: number } {
  const safeLimit = Math.max(1, Math.floor(limit));
  const visible = items.slice(0, safeLimit);
  return {
    visible,
    remaining: Math.max(0, items.length - visible.length),
  };
}

export function sliceModalPage<T>(
  items: readonly T[],
  page: number,
  pageSize = MODAL_PAGE_SIZE
): {
  items: T[];
  currentPage: number;
  totalPages: number;
  startIndex: number;
  endIndex: number;
} {
  const safePageSize = Math.max(1, Math.floor(pageSize));
  const totalPages = Math.max(1, Math.ceil(items.length / safePageSize));
  const currentPage = Math.min(totalPages, Math.max(1, Math.floor(page)));
  const startIndex = (currentPage - 1) * safePageSize;
  const endIndex = Math.min(items.length, startIndex + safePageSize);
  return {
    items: items.slice(startIndex, endIndex),
    currentPage,
    totalPages,
    startIndex,
    endIndex,
  };
}

export interface PaginatedMediaModalProps<T extends TmdbItem = TmdbItem> {
  isOpen: boolean;
  title: string;
  subtitle?: string;
  items: T[];
  savedItems: SavedItem[];
  dislikedKeys?: string[];
  genresMap: Record<number, string>;
  context?: 'discover' | 'taste' | 'actor' | 'related' | 'hero';
  pageSize?: number;
  onClose: () => void;
  onOpenDetails: (item: T) => void;
  onQuickAdd?: (item: T) => void;
  onSetStatus?: (item: T, status: 'watching' | 'watchlist' | 'completed') => void;
  onQuickSave?: (item: T) => void;
  onToggleDislike?: (key: string) => void;
}

export function PaginatedMediaModal<T extends TmdbItem = TmdbItem>({
  isOpen,
  title,
  subtitle,
  items,
  savedItems,
  dislikedKeys = [],
  genresMap,
  context = 'discover',
  pageSize = MODAL_PAGE_SIZE,
  onClose,
  onOpenDetails,
  onQuickAdd,
  onSetStatus,
  onQuickSave,
  onToggleDislike,
}: PaginatedMediaModalProps<T>) {
  const [page, setPage] = useState<number>(1);
  const dialogRef = useDialogAccessibility(isOpen, onClose);

  useEffect(() => {
    if (isOpen) {
      setPage(1);
    }
  }, [isOpen, title]);

  const dislikedSet = useMemo(() => new Set(dislikedKeys), [dislikedKeys]);

  const pageSlice = useMemo(
    () => sliceModalPage(items, page, pageSize),
    [items, page, pageSize]
  );

  if (!isOpen) return null;

  return (
    <div
      className="modal-wrap open"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <article
        ref={dialogRef}
        className="modal actor-all-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="paginatedModalTitle"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="actor-all-header">
          <div>
            <h3 id="paginatedModalTitle" className="modal-title">
              {title} <span className="tabular-nums">({items.length})</span>
            </h3>
            {subtitle && <p className="modal-sub">{subtitle}</p>}
          </div>
          <button
            type="button"
            className="modal-close"
            onClick={onClose}
            aria-label="Kapat"
          >
            ✕
          </button>
        </div>

        <div className="actor-all-grid">
          {pageSlice.items.map((item) => {
            const mediaType = item.media_type === 'tv' ? 'tv' : 'movie';
            const mediaKey = makeMediaKey(mediaType, item.id);
            return (
              <MediaCard
                key={mediaKey}
                item={item}
                savedItem={findSavedItem(savedItems, item)}
                genres={genresMap}
                isDisliked={dislikedSet.has(mediaKey)}
                size="md"
                context={context}
                showMatch={true}
                onOpenDetails={() => onOpenDetails(item)}
                onQuickAdd={onQuickAdd ? () => onQuickAdd(item) : undefined}
                onSetStatus={
                  onSetStatus ? (_it, st) => onSetStatus(item, st) : undefined
                }
                onQuickSave={onQuickSave ? () => onQuickSave(item) : undefined}
                onToggleDislike={onToggleDislike}
              />
            );
          })}
        </div>

        {pageSlice.totalPages > 1 && (
          <div className="paginated-modal-footer" role="navigation" aria-label="Sayfalama">
            <button
              type="button"
              className="btn"
              disabled={pageSlice.currentPage <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              ← Önceki
            </button>
            <span className="paginated-modal-status tabular-nums" aria-live="polite">
              Sayfa {pageSlice.currentPage} / {pageSlice.totalPages} · Gösterilen:{' '}
              {pageSlice.startIndex + 1}–{pageSlice.endIndex} / {items.length}
            </span>
            <button
              type="button"
              className="btn"
              disabled={pageSlice.currentPage >= pageSlice.totalPages}
              onClick={() => setPage((p) => Math.min(pageSlice.totalPages, p + 1))}
            >
              Sonraki →
            </button>
          </div>
        )}
      </article>
    </div>
  );
}
