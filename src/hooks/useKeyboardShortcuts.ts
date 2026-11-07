import { useEffect } from 'react';

export interface KeyboardShortcutsHandlers {
  onFocusSearch?: () => void;
  onSelectTab?: (tab: 'discover' | 'list' | 'taste-map' | 'relationships') => void;
  onOpenSettings?: () => void;
  onQuickSaveOrSync?: () => void;
  onOpenAddCustom?: () => void;
  onOpenCommandPalette?: () => void;
  onEscape?: () => void;
}

export function useKeyboardShortcuts(handlers: KeyboardShortcutsHandlers): void {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't intercept shortcut modifiers (Ctrl, Meta, Alt) except Escape
      if (e.key === 'Escape') {
        handlers.onEscape?.();
        return;
      }

      // Cmd+K / Ctrl+K opens the command palette from anywhere, inputs included
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        handlers.onOpenCommandPalette?.();
        return;
      }

      if (e.ctrlKey || e.metaKey || e.altKey) return;

      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      ) {
        return;
      }

      // / focuses search bar
      if (e.key === '/') {
        e.preventDefault();
        handlers.onFocusSearch?.();
        return;
      }

      // 1-5 switches tabs and opens settings
      if (e.key === '1') {
        e.preventDefault();
        handlers.onSelectTab?.('discover');
        return;
      }
      if (e.key === '2') {
        e.preventDefault();
        handlers.onSelectTab?.('list');
        return;
      }
      if (e.key === '3') {
        e.preventDefault();
        handlers.onSelectTab?.('taste-map');
        return;
      }
      if (e.key === '4') {
        e.preventDefault();
        handlers.onSelectTab?.('relationships');
        return;
      }
      if (e.key === '5') {
        e.preventDefault();
        handlers.onOpenSettings?.();
        return;
      }

      // s / S triggers quick save or sync
      if (e.key === 's' || e.key === 'S') {
        e.preventDefault();
        handlers.onQuickSaveOrSync?.();
        return;
      }

      // n / N opens add custom item
      if (e.key === 'n' || e.key === 'N') {
        e.preventDefault();
        handlers.onOpenAddCustom?.();
        return;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handlers]);
}
