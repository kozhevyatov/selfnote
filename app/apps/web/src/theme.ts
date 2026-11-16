/** Оформление: тема и акцентный цвет. Хранятся на устройстве и в документе пространства. */
export type Theme = 'system' | 'light' | 'dark';
export const ACCENTS = ['#3451D1', '#C2410C', '#2B7A3D', '#7A3DB8'];
export const DEFAULT_ACCENT = ACCENTS[0];
const media = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;

export function storedAppearance(): { theme: Theme; accent: string } {
  const theme = localStorage.getItem('theme');
  return {
    theme: theme === 'light' || theme === 'dark' ? theme : 'system',
    accent: localStorage.getItem('accent') || DEFAULT_ACCENT,
  };
}
function resolved(theme: Theme) {
  return theme === 'system' ? (media?.matches ? 'dark' : 'light') : theme;
}
/** Применяет оформление без перезагрузки и запоминает его на устройстве. */
export function applyAppearance(theme: Theme, accent: string) {
  localStorage.setItem('theme', theme);
  localStorage.setItem('accent', accent);
  const root = document.documentElement;
  root.dataset.theme = resolved(theme);
  root.style.setProperty('--accent', accent);
  const color = resolved(theme) === 'dark' ? '#141416' : '#ECEBE7';
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', color);
}
export function initAppearance() {
  const { theme, accent } = storedAppearance();
  applyAppearance(theme, accent);
  media?.addEventListener('change', () => {
    const current = storedAppearance();
    if (current.theme === 'system') applyAppearance(current.theme, current.accent);
  });
}
