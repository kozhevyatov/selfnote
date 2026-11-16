import { Palette } from 'lucide-react';
export function ColorPicker({
  value,
  onChange,
  label = 'Выбрать цвет',
}: {
  value: string;
  onChange: (color: string) => void;
  label?: string;
}) {
  return (
    <label className="color-picker" title={label}>
      <span className="color-picker-swatch" style={{ background: value }} aria-hidden="true" />
      <Palette size={18} aria-hidden="true" />
      <span className="color-picker-value" aria-hidden="true">
        {value.toUpperCase()}
      </span>
      <input
        type="color"
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}
