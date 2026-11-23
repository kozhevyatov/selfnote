import Svg, { Path } from 'react-native-svg';

/** Знак SelfNote — тот же рисунок, что в иконке приложения и PWA (apps/web/public/icon.svg). */
export function Logo({ size = 30, color = '#FFFFFF' }: { size?: number; color?: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M20.24 12.24a6 6 0 0 0-8.48-8.48L3 12.5V21h8.5z" />
      <Path d="m16 8-2 2M9 15l-6 6M9 15h6M9 15v-6" />
    </Svg>
  );
}
