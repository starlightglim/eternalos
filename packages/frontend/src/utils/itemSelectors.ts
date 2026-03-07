import type { DesktopItem } from '../types';

export function getItemExtension(item: Pick<DesktopItem, 'name' | 'mimeType'>): string | undefined {
  const trimmedName = item.name.trim().toLowerCase();
  const dotIndex = trimmedName.lastIndexOf('.');
  if (dotIndex > 0 && dotIndex < trimmedName.length - 1) {
    return trimmedName.slice(dotIndex + 1).replace(/[^a-z0-9]+/g, '') || undefined;
  }

  if (item.mimeType) {
    const [, subtype] = item.mimeType.toLowerCase().split('/');
    if (subtype) {
      return subtype.replace(/[^a-z0-9]+/g, '') || undefined;
    }
  }

  return undefined;
}
