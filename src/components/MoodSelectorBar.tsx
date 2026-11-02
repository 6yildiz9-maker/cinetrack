import React from 'react';
import { Compass, X } from 'lucide-react';
import { DISCOVER_MOOD_PILLS } from '../utils/helpers.ts';

export interface MoodSelectorBarProps {
  selectedMood: string;
  onSelectMood: (moodId: string) => void;
}

export const MoodSelectorBar: React.FC<MoodSelectorBarProps> = ({
  selectedMood,
  onSelectMood,
}) => {
  return (
    <section
      aria-label="Ruh Hali Seçici"
      className="mb-5 rounded-2xl bg-cinema-surface/60 backdrop-blur-md border border-white/10 px-4 py-3.5"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 mb-2.5">
        <div className="flex items-center gap-2 text-xs text-cinema-textMuted">
          <Compass className="w-3.5 h-3.5 text-cinema-cyan shrink-0" aria-hidden="true" />
          <span className="font-semibold text-cinema-textPrimary">Şu an ne izlesem?</span>
          <span aria-hidden="true">·</span>
          <span>Ruh haline göre keşfet akışını anında daralt</span>
        </div>

        {selectedMood && (
          <button
            type="button"
            onClick={() => onSelectMood('')}
            className="inline-flex items-center gap-1 text-xs font-medium text-cinema-cyan hover:text-cinema-textPrimary transition-colors whitespace-nowrap shrink-0"
          >
            <X className="w-3.5 h-3.5" aria-hidden="true" />
            <span>Ruh Halini Temizle</span>
          </button>
        )}
      </div>

      <div
        role="group"
        aria-label="Ruh hali filtreleri"
        className="flex items-center gap-2 overflow-x-auto pb-1"
      >
        {DISCOVER_MOOD_PILLS.map((pill) => {
          const isSelected = selectedMood === pill.id;
          return (
            <button
              key={pill.id}
              type="button"
              aria-pressed={isSelected}
              title={pill.subtitle}
              onClick={() => onSelectMood(isSelected ? '' : pill.id)}
              className={`px-3.5 py-2 rounded-full text-xs font-medium border transition-all whitespace-nowrap shrink-0 min-h-[38px] ${
                isSelected
                  ? 'bg-cinema-cyanDim border-cinema-cyan/50 text-cinema-cyan shadow-glowCyan'
                  : 'bg-white/5 border-white/10 text-cinema-textMuted hover:text-cinema-textPrimary hover:border-white/20'
              }`}
            >
              {pill.label}
            </button>
          );
        })}
      </div>
    </section>
  );
};
