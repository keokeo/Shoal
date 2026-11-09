import { useSyncExternalStore } from 'react';

// Privacy mode: names, titles and paths are blurred (CSS, [data-private]) and tooltips that would leak them are not rendered.
export const PRIVACY_KEY = 'wb.privacy';

const listeners = new Set<() => void>();
let on = localStorage.getItem(PRIVACY_KEY) === '1';

export function setPrivacy(next: boolean): void {
  on = next;
  localStorage.setItem(PRIVACY_KEY, next ? '1' : '0');
  listeners.forEach((l) => l());
}

export function usePrivacy(): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => on,
  );
}
