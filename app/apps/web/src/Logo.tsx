/** Знак SelfNote — тот же рисунок, что в иконке PWA (public/icon.svg) и в мобильном приложении (mobile/src/Logo.tsx). */
export function Logo({ size = 20 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M20.24 12.24a6 6 0 0 0-8.48-8.48L3 12.5V21h8.5z" />
      <path d="m16 8-2 2M9 15l-6 6M9 15h6M9 15v-6" />
    </svg>
  );
}
