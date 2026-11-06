import React from 'react';

export interface MoodOption {
  id: string;
  label: string;
  icon: string;
  description: string;
}

export const MOOD_PILLS: MoodOption[] = [
  { id: 'thoughtful', label: 'Düşündür', icon: '🧠', description: 'Derin temalar, felsefi sorular ve zihinsel yolculuklar' },
  { id: 'dark', label: 'Karanlık Bir Şeyler', icon: '🌑', description: 'Tekinsiz atmosfer, psikolojik gerilim ve noir tonlar' },
  { id: 'feel-good', label: 'Rahatlat', icon: '☕', description: 'Sıcak, huzur veren, konfor alanı yapımları' },
  { id: 'mind-bending', label: 'Şaşırt', icon: '⚡', description: 'Ters köşeler, zaman paradoksları ve sürpriz finaller' },
  { id: 'cheerful', label: 'Moral Yükselt', icon: '☀️', description: 'Gülümseten, enerjik ve yaşam sevinci aşılayan anlar' },
  { id: 'deep', label: 'Ağır / Derin', icon: '🌊', description: 'Yavaş tempolu, yoğun dramatik ve sinematografik ağırlık' },
];

interface MoodPillsBarProps {
  activeMood: string;
  onSelectMood: (moodId: string) => void;
}

export const MoodPillsBar: React.FC<MoodPillsBarProps> = ({ activeMood, onSelectMood }) => {
  return (
    <div className="w-full mb-4" role="region" aria-label="Ruh Hali Seçici">
      <div className="flex items-center justify-between mb-2 px-1">
        <span className="text-xs font-semibold text-cinema-textMuted tracking-wider uppercase flex items-center gap-1.5">
          <span>🎭</span> Ruh Hali
        </span>
        {activeMood && (
          <button
            type="button"
            onClick={() => onSelectMood('')}
            className="text-[11px] text-cinema-cyan hover:underline underline-offset-2 transition-colors"
          >
            Filtreyi Temizle
          </button>
        )}
      </div>

      <div className="flex items-center gap-2 overflow-x-auto pb-1 scrollbar-none scroll-smooth">
        {MOOD_PILLS.map((mood) => {
          const isActive = activeMood === mood.id;
          return (
            <button
              key={mood.id}
              type="button"
              onClick={() => onSelectMood(isActive ? '' : mood.id)}
              className={`inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full text-xs font-medium whitespace-nowrap transition-all duration-200 border shrink-0 ${
                isActive
                  ? 'bg-cinema-cyanDim text-cinema-textPrimary border-cinema-cyan/40 shadow-[0_0_12px_rgba(99,184,171,0.2)]'
                  : 'bg-cinema-surfaceHover/80 text-cinema-textMuted border-white/7 hover:border-cinema-cyan/30 hover:text-cinema-textPrimary hover:bg-cinema-surfaceHover'
              }`}
              title={mood.description}
              aria-pressed={isActive}
            >
              <span className="text-sm" aria-hidden="true">{mood.icon}</span>
              <span>{mood.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
};
