import type React from 'react';

const TAB_SELECTOR = '[role="tab"]:not([disabled])';

/**
 * `role="tablist"` kapsayıcıları için WAI-ARIA "Tabs" klavye gezinmesi.
 * ArrowLeft / ArrowRight / Home / End odak ve seçimi taşır; Tab tuşu davranışı değişmez.
 */
export function handleTabListKeyDown(event: React.KeyboardEvent<HTMLElement>): void {
  const { key } = event;
  if (key !== 'ArrowRight' && key !== 'ArrowLeft' && key !== 'Home' && key !== 'End') return;

  const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>(TAB_SELECTOR));
  if (tabs.length < 2) return;

  const currentIndex = tabs.findIndex((tab) => tab === document.activeElement);
  if (currentIndex === -1) return;

  event.preventDefault();

  let nextIndex = currentIndex;
  if (key === 'ArrowRight') nextIndex = (currentIndex + 1) % tabs.length;
  else if (key === 'ArrowLeft') nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
  else if (key === 'Home') nextIndex = 0;
  else nextIndex = tabs.length - 1;

  const nextTab = tabs[nextIndex];
  if (!nextTab) return;
  nextTab.focus();
  nextTab.click();
}
