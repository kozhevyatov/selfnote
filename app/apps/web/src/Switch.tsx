interface SwitchProps {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}
/** Нативный input сохраняет управление клавиатурой и доступное имя. */
export function Switch({ label, checked, onChange, disabled }: SwitchProps) {
  return (
    <label className="switch-control">
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="switch-track" aria-hidden="true" />
      <span className="switch-label">{label}</span>
    </label>
  );
}
