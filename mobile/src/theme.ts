import { useColorScheme } from 'react-native';
import { useWorkspaceOptional } from './session';

/** Значения из app/apps/web/src/styles.css — приложение выглядит как веб-версия. */
const light = {
  background: '#ECEBE7',
  panel: '#FFFFFF',
  soft: '#F3F2EF',
  text: '#1D1D1F',
  secondary: '#55555B',
  muted: '#66666C',
  faint: '#8A8990',
  border: '#DEDDD8',
  line: '#F0EFEC',
  danger: '#B42318',
  dangerBg: '#FDECEC',
  success: '#249846',
  strong: '#1D1D1F',
  onStrong: '#FFFFFF',
  tabBar: 'rgba(255,255,255,0.94)',
};
const dark: typeof light = {
  background: '#141416',
  panel: '#1F1F22',
  soft: '#2A2A2E',
  text: '#ECECEE',
  secondary: '#C2C2C8',
  muted: '#A6A6AE',
  faint: '#8E8E96',
  border: '#3A3A40',
  line: '#333338',
  danger: '#FF8F85',
  dangerBg: '#3B1F1F',
  success: '#4CC46C',
  strong: '#ECECEE',
  onStrong: '#141416',
  tabBar: 'rgba(31,31,34,0.94)',
};
export const DEFAULT_ACCENT = '#3451D1';

export const fonts = {
  regular: 'GolosText_400Regular',
  medium: 'GolosText_500Medium',
  semibold: 'GolosText_600SemiBold',
  bold: 'GolosText_700Bold',
  heavy: 'GolosText_800ExtraBold',
};

function rgb(hex: string): [number, number, number] {
  const v = hex.replace('#', '');
  const n = parseInt(v.length === 3 ? [...v].map((c) => c + c).join('') : v.slice(0, 6), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
/** Аналог CSS color-mix(in srgb, color amount%, base). */
export function mix(color: string, amount: number, base: string) {
  const a = rgb(color),
    b = rgb(base);
  const c = a.map((x, i) => Math.round(x * amount + b[i] * (1 - amount)));
  return '#' + c.map((x) => x.toString(16).padStart(2, '0')).join('');
}

export type Theme = ReturnType<typeof useTheme>;
export function useTheme() {
  const system = useColorScheme();
  const workspace = useWorkspaceOptional();
  const prefs = workspace?.appearance();
  const scheme = prefs?.theme === 'light' || prefs?.theme === 'dark' ? prefs.theme : system;
  const isDark = scheme === 'dark';
  const c = isDark ? dark : light;
  const accent = prefs?.accent && /^#[0-9a-f]{6}$/i.test(prefs.accent) ? prefs.accent : DEFAULT_ACCENT;
  return {
    isDark,
    c,
    accent,
    accentText: isDark ? mix(accent, 0.55, '#FFFFFF') : accent,
    tint: isDark ? mix(accent, 0.24, c.panel) : mix(accent, 0.11, '#FFFFFF'),
    selection: isDark ? mix(accent, 0.16, c.panel) : mix(accent, 0.07, '#FFFFFF'),
  };
}
