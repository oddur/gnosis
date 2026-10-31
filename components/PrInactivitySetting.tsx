import { useEffect, useState, useId } from 'react';
import { DEFAULT_PR_INACTIVITY_DAYS, MAX_PR_INACTIVITY_DAYS } from '../lib/pr-inactivity';

export function PrInactivitySetting({ days, onChange }: { days: number; onChange: (days: number) => void }) {
  const helpId = useId();
  const [draft, setDraft] = useState(String(days || DEFAULT_PR_INACTIVITY_DAYS));
  const [error, setError] = useState('');
  useEffect(() => {
    if (days) setDraft(String(days));
  }, [days]);
  const commit = () => {
    const value = Number(draft);
    if (!draft.trim() || !Number.isInteger(value) || value < 1 || value > MAX_PR_INACTIVITY_DAYS) {
      setError(
        `Enter a whole number from 1 to ${MAX_PR_INACTIVITY_DAYS.toLocaleString()}. Your previous limit still applies.`
      );
      return;
    }
    setError('');
    if (value !== days) onChange(value);
  };
  return (
    <div className="pr-inactivity-setting">
      <div className="flex items-center gap-2">
        <input
          type="number"
          className="w-20"
          aria-label="PR inactivity limit in days"
          aria-describedby={helpId}
          min={1}
          max={MAX_PR_INACTIVITY_DAYS}
          step={1}
          disabled={days === 0}
          value={draft}
          aria-invalid={!!error}
          onChange={(event) => {
            setDraft(event.target.value);
            setError('');
          }}
          onBlur={() => {
            if (days) commit();
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur();
          }}
        />
        <span className="text-sm">days</span>
      </div>
      <label className="mt-2 flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={days === 0}
          onChange={(event) => {
            setError('');
            const value = Number(draft);
            onChange(
              event.target.checked
                ? 0
                : Number.isInteger(value) && value >= 1 && value <= MAX_PR_INACTIVITY_DAYS
                  ? value
                  : DEFAULT_PR_INACTIVITY_DAYS
            );
          }}
        />
        Never ignore
      </label>
      <p
        id={helpId}
        className={error ? 'text-xs text-destructive mt-2' : 'sr-only'}
        role={error ? 'alert' : undefined}
      >
        {error || 'Number of days since the last GitHub update. Choose Never ignore to disable this limit.'}
      </p>
    </div>
  );
}
