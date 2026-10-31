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
  return (
    <div className="model-effort-select">
      <SearchableSelect
        id={id}
        describedBy={describedBy}
        label={label}
        className="model-select"
        value={model}
        options={
          options ??
          Object.values(PROVIDERS).flatMap((p) =>
            p.models.map((m) => ({ value: m.id, label: `${p.label} · ${m.label}` }))
          )
        }
        onValueChange={(value) => {
          const next = Object.entries(PROVIDERS).find(([, p]) => p.models.some((m) => m.id === value));
          if (!next) return;
          const selected = next[0] as Provider;
          onChange({
            provider: selected,
            model: value as ModelId,
            effort: normalizeEffort(selected, value as ModelId, effort),
          });
        }}
      />
      <EffortSelect
        provider={provider}
        model={model}
        effort={effort}
        label={`${label} effort`}
        onChange={(effort) => onChange({ provider, model, effort })}
      />
    </div>
  );
}
