/** Controls shared by Settings panels. */

// Quiet toggle switch — drops the bg-primary fill (now ink) and the
// shadow-sm thumb in favor of a warm-amber active state and a flat
// thumb. Used across all the on/off settings.
export function Toggle({
  checked,
  onChange,
  ariaLabel,
}: {
  checked: boolean;
  onChange: () => void;
  ariaLabel?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      onClick={onChange}
      className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border transition-colors ${
        checked ? 'bg-[var(--ring)] border-[var(--ring)]' : 'bg-transparent border-border'
      }`}
    >
      <span
        className={`pointer-events-none block h-3.5 w-3.5 rounded-full transition-transform translate-y-px ${
          checked ? 'bg-background translate-x-[1.125rem]' : 'bg-muted-foreground translate-x-[2px]'
        }`}
      />
    </button>
  );
}

// Single setting row — label + description on the left, control on the right.
export function SettingRow({
  label,
  description,
  children,
}: {
  label: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="settings-row flex items-center justify-between gap-4 py-1">
      <div className="flex flex-col gap-0.5 min-w-0">
        <span className="text-sm font-medium text-foreground">{label}</span>
        {description && <span className="settings-description">{description}</span>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}
