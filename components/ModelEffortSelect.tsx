import { useId, useState } from 'react';
import { Popover } from 'radix-ui';
import { ChevronDown } from 'lucide-react';
import { SearchableSelect, type SelectionOption } from './SearchableSelect';
import { PROVIDERS, type ModelId, type Provider } from '../lib/models';
import { effortLabels, effortLevels, normalizeEffort, type Effort } from '../lib/effort';

export function EffortSelect({
  provider,
  model,
  effort,
  onChange,
  label = 'Reasoning effort',
}: {
  provider: Provider;
  model: ModelId;
  effort: Effort;
  onChange: (effort: Effort) => void;
  label?: string;
}) {
  const value = normalizeEffort(provider, model, effort);
  return (
    <SearchableSelect
      label={label}
      className="effort-select"
      value={value}
      triggerLabel={`Effort: ${effortLabels[value]}`}
      options={effortLevels(provider, model).map((value) => ({ value, label: effortLabels[value] }))}
      onValueChange={(value) => onChange(normalizeEffort(provider, model, value))}
    />
  );
}
export function ModelEffortSelect({
  provider,
  model,
  effort,
  onChange,
  label = 'Review model',
  options,
  id,
  describedBy,
}: {
  provider: Provider;
  model: ModelId;
  effort: Effort;
  onChange: (selection: { provider: Provider; model: ModelId; effort: Effort }) => void;
  label?: string;
  options?: SelectionOption[];
  id?: string;
  describedBy?: string;
}) {
  const [open, setOpen] = useState(false);
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const group = useId();
  const choices =
    options ??
    Object.values(PROVIDERS).flatMap((p) => p.models.map((m) => ({ value: m.id, label: `${p.label} · ${m.label}` })));
  const selectedLabel = choices.find((choice) => choice.value === model)?.label ?? model;
  const normalized = normalizeEffort(provider, model, effort);
  const chooseModel = (value: string) => {
    const selected = Object.entries(PROVIDERS).find(([, p]) => p.models.some((m) => m.id === value));
    if (selected)
      onChange({
        provider: selected[0] as Provider,
        model: value as ModelId,
        effort: normalizeEffort(selected[0] as Provider, value as ModelId, normalized),
      });
  };
  return (
    <div className="model-effort-select" ref={setContainer}>
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger asChild>
          <button
            type="button"
            id={id}
            aria-label={label}
            aria-describedby={describedBy}
            aria-description={`${selectedLabel}; ${effortLabels[normalized]} reasoning effort`}
            className="model-picker-trigger"
          >
            <span className="model-picker-name">{selectedLabel}</span>
            <span className="model-picker-effort">{effortLabels[normalized]}</span>
            <ChevronDown size={14} aria-hidden="true" />
          </button>
        </Popover.Trigger>
        <Popover.Portal container={container}>
          <Popover.Content
            className="model-picker-popup"
            data-combobox-container="inside"
            aria-label={`${label} and effort`}
            align="end"
            sideOffset={8}
            collisionPadding={12}
          >
            <div className="model-picker-field">
              <span>Model</span>
              <SearchableSelect
                label={`${label} selection`}
                value={model}
                options={choices}
                onValueChange={chooseModel}
                popupBoundary="viewport"
              />
            </div>
            <fieldset className="model-picker-reasoning">
              <legend>Reasoning effort</legend>
              <div>
                {effortLevels(provider, model).map((value) => (
                  <label key={value}>
                    <input
                      type="radio"
                      name={group}
                      value={value}
                      checked={normalized === value}
                      onChange={() => onChange({ provider, model, effort: value })}
                    />
                    <span>{effortLabels[value]}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="model-picker-footer">
              <Popover.Close>Done</Popover.Close>
            </div>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
}
