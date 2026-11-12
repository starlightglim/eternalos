export const DEFAULT_MENU_BAR_HEIGHT = 20;

export function getMenuBarHeight(): number {
  if (typeof window === 'undefined') return DEFAULT_MENU_BAR_HEIGHT;

  const value = Number.parseFloat(
    window.getComputedStyle(document.documentElement).getPropertyValue('--menu-bar-height')
  );

  return Number.isFinite(value) ? value : DEFAULT_MENU_BAR_HEIGHT;
}
