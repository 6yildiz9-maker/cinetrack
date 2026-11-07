import React from 'react';
import {
  Bookmark,
  Compass,
  Fingerprint,
  Orbit,
  Settings,
} from 'lucide-react';

export type ShellTabId = 'discover' | 'list' | 'taste-map' | 'relationships';

export interface FloatingGlassDockProps {
  tab: ShellTabId;
  isSettingsOpen: boolean;
  myListCount: number;
  onSelectTab: (tab: ShellTabId) => void;
  onOpenSettings: () => void;
}

interface DockItemConfig {
  id: ShellTabId;
  label: string;
  shortcut: string;
  Icon: React.ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
  activeTextClass: string;
  activeBgClass: string;
  activeDotClass: string;
}

const DOCK_ITEMS: readonly DockItemConfig[] = [
  {
    id: 'discover',
    label: 'Keşfet',
    shortcut: '1',
    Icon: Compass,
    activeTextClass: 'text-cinema-cyan',
    activeBgClass: 'bg-cinema-cyanDim border-cinema-cyan/40',
    activeDotClass: 'bg-cinema-cyan',
  },
  {
    id: 'list',
    label: 'Listem',
    shortcut: '2',
    Icon: Bookmark,
    activeTextClass: 'text-cinema-textPrimary',
    activeBgClass: 'bg-white/10 border-white/25',
    activeDotClass: 'bg-cinema-textPrimary',
  },
  {
    id: 'taste-map',
    label: 'Zevkim',
    shortcut: '3',
    Icon: Fingerprint,
    activeTextClass: 'text-cinema-gold',
    activeBgClass: 'bg-cinema-goldDim border-cinema-gold/40',
    activeDotClass: 'bg-cinema-gold',
  },
  {
    id: 'relationships',
    label: 'Evrenler',
    shortcut: '4',
    Icon: Orbit,
    activeTextClass: 'text-cinema-purple',
    activeBgClass: 'bg-cinema-purple/15 border-cinema-purple/40',
    activeDotClass: 'bg-cinema-purple',
  },
];

export const FloatingGlassDock: React.FC<FloatingGlassDockProps> = ({
  tab,
  isSettingsOpen,
  myListCount,
  onSelectTab,
  onOpenSettings,
}) => {
  return (
    <>
      {/* Masaüstü — Sol Yüzen Cam Dock (Floating Glass Dock) */}
      <aside
        aria-label="Ana gezinme rıhtımı"
        className="hidden lg:flex fixed left-3 top-24 z-40 flex-col justify-between w-[76px] min-h-[380px] rounded-2xl bg-cinema-surface/75 backdrop-blur-xl border border-white/10 p-2 shadow-2xl"
      >
        <div className="flex flex-col gap-2" role="navigation" aria-label="Ana dallar">
          {DOCK_ITEMS.map((item) => {
            const isActive = !isSettingsOpen && tab === item.id;
            const { Icon } = item;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onSelectTab(item.id)}
                aria-current={isActive ? 'page' : undefined}
                title={`${item.label} (Kısayol: ${item.shortcut})`}
                className={`relative flex flex-col items-center justify-center gap-1 py-2.5 px-1.5 rounded-xl border transition-all min-h-[56px] ${
                  isActive
                    ? `${item.activeBgClass} ${item.activeTextClass}`
                    : 'border-transparent text-cinema-textMuted hover:text-cinema-textPrimary hover:bg-white/5'
                }`}
              >
                <div className="relative">
                  <Icon className="w-5 h-5" aria-hidden={true} />
                  {item.id === 'list' && myListCount > 0 && (
                    <span className="absolute -top-1.5 -right-3 px-1 min-w-[18px] h-4 rounded-full bg-white/15 border border-white/20 text-[10px] font-mono tabular-nums text-cinema-textPrimary flex items-center justify-center">
                      {myListCount > 99 ? '99+' : myListCount}
                    </span>
                  )}
                </div>
                <span className="text-[11px] font-medium tracking-tight whitespace-nowrap">
                  {item.label}
                </span>
                {isActive && (
                  <span
                    aria-hidden="true"
                    className={`w-4 h-0.5 rounded-full ${item.activeDotClass}`}
                  />
                )}
              </button>
            );
          })}
        </div>

        <div className="pt-2 mt-2 border-t border-white/10">
          <button
            type="button"
            onClick={onOpenSettings}
            aria-expanded={isSettingsOpen}
            title="Ayarlar ve Profil Yönetimi (Kısayol: 5)"
            className={`w-full flex flex-col items-center justify-center gap-1 py-2.5 px-1.5 rounded-xl border transition-all min-h-[54px] ${
              isSettingsOpen
                ? 'bg-white/10 border-white/25 text-cinema-textPrimary'
                : 'border-transparent text-cinema-textMuted hover:text-cinema-textPrimary hover:bg-white/5'
            }`}
          >
            <Settings className="w-5 h-5" aria-hidden="true" />
            <span className="text-[11px] font-medium tracking-tight whitespace-nowrap">
              Ayarlar
            </span>
          </button>
        </div>
      </aside>

      {/* Mobil — 56px Yapışkan Alt Sekme Çubuğu (5 Ana Dal) */}
      <nav
        className="mobile-tab-bar lg:hidden fixed bottom-0 inset-x-0 z-40 h-14 bg-cinema-surface/90 backdrop-blur-xl border-t border-white/10 grid grid-cols-5 items-center px-1"
        aria-label="Mobil Gezinme"
      >
        {DOCK_ITEMS.map((item) => {
          const isActive = !isSettingsOpen && tab === item.id;
          const { Icon } = item;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onSelectTab(item.id)}
              aria-current={isActive ? 'page' : undefined}
              aria-label={item.label}
              className={`mobile-tab-btn relative flex flex-col items-center justify-center min-h-[44px] min-w-[44px] py-1 rounded-lg transition-colors ${
                isActive ? `${item.activeTextClass} active` : 'text-cinema-textMuted'
              }`}
            >
              <span className="relative flex items-center justify-center">
                <Icon className="w-5 h-5" aria-hidden={true} />
                {item.id === 'list' && myListCount > 0 && (
                  <span className="mobile-tab-badge tabular-nums">
                    {myListCount > 99 ? '99+' : myListCount}
                  </span>
                )}
              </span>
              <span className="text-[10px] font-medium tracking-tight mt-0.5 whitespace-nowrap">
                {item.label}
              </span>
              {isActive && (
                <span
                  aria-hidden="true"
                  className={`w-1.5 h-1.5 rounded-full mt-0.5 ${item.activeDotClass}`}
                />
              )}
            </button>
          );
        })}

        <button
          type="button"
          onClick={onOpenSettings}
          aria-expanded={isSettingsOpen}
          aria-label="Ayarlar"
          className={`mobile-tab-btn relative flex flex-col items-center justify-center min-h-[44px] min-w-[44px] py-1 rounded-lg transition-colors ${
            isSettingsOpen ? 'text-cinema-textPrimary active' : 'text-cinema-textMuted'
          }`}
        >
          <Settings className="w-5 h-5" aria-hidden="true" />
          <span className="text-[10px] font-medium tracking-tight mt-0.5 whitespace-nowrap">
            Ayarlar
          </span>
        </button>
      </nav>
    </>
  );
};
