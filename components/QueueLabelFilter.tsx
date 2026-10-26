import { useId, useMemo, useRef, useState } from 'react';
import { X } from 'lucide-react';
import type { ReviewMember } from '../lib/workbench';
import type { PrLabel } from '../lib/types';
import { DEFAULT_LABEL_FILTER, labelFilterActive, type PrLabelFilter } from '../lib/pr-label-filter';
import { prLabelColors } from './PrLabels';
import { Combobox, ComboboxContent, ComboboxEmpty, ComboboxInput, ComboboxItem, ComboboxList, ComboboxTrigger, findComboboxContainer } from './ui/combobox';

const UNLABELLED = 'unlabelled';
const labelKey = (name: string) => `label:${name.toLowerCase()}`;
export function QueueLabelFilter({ value, members, onChange }: {
  value: PrLabelFilter;
  members: Pick<ReviewMember, 'labels' | 'labelDetails'>[];
  onChange: (value: PrLabelFilter) => void;
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const options = useMemo(() => {
    const byName = new Map<string, PrLabel & { colors: Set<string> }>();
    for (const member of members) for (const name of member.labels) {
      const key = labelKey(name);
      const detail = member.labelDetails?.find(label => label.name.toLowerCase() === name.toLowerCase());
      const existing = byName.get(key) ?? { name, description: detail?.description, colors: new Set<string>() };
      if (detail?.color) existing.colors.add(detail.color.toLowerCase());
      byName.set(key, existing);
    }
    for (const name of value.names) if (!byName.has(labelKey(name))) byName.set(labelKey(name), { name, colors: new Set() });
    return [...byName].map(([key, label]) => ({ key, ...label, color: label.colors.size === 1 ? [...label.colors][0] : undefined }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }));
  }, [members, value.names]);
  const byKey = useMemo(() => new Map(options.map(option => [option.key, option])), [options]);
  const items = useMemo(() => [UNLABELLED, ...options.map(option => option.key)], [options]);
  const selected = useMemo(() => value.unlabelled ? [UNLABELLED] : value.names.map(labelKey), [value.unlabelled, value.names]);
  const setSelection = (keys: string[]) => {
    if (keys.includes(UNLABELLED) && !value.unlabelled) { onChange({ ...DEFAULT_LABEL_FILTER, unlabelled: true }); return; }
    onChange({ ...value, unlabelled: false, names: keys.filter(key => key !== UNLABELLED).flatMap(key => byKey.get(key)?.name ?? []) });
  };
  const remove = (name?: string) => {
    onChange(name ? { ...value, names: value.names.filter(item => item !== name) } : DEFAULT_LABEL_FILTER);
    trigger.current?.focus();
  };
  return <div className="queue-label-filter" role="group" aria-labelledby={`${id}-label`}>
    <div className="queue-label-heading">
      <span id={`${id}-label`}>GitHub labels</span>
      {labelFilterActive(value) && <button type="button" className="queue-label-clear" onClick={() => remove()}>Clear labels</button>}
    </div>
    <div className="queue-label-tags">
      {value.unlabelled && <span className="pr-label queue-label-tag">No labels<button type="button" aria-label="Remove no-labels filter" onClick={() => remove()}><X size={12} /></button></span>}
      {value.names.map(name => <span key={name} className="pr-label queue-label-tag" style={prLabelColors(byKey.get(labelKey(name))?.color)} title={name}>
        <span>{name}</span><button type="button" aria-label={`Remove label ${name}`} onClick={() => remove(name)}><X size={12} /></button>
      </span>)}
      <Combobox multiple items={items} value={selected}
        itemToStringLabel={key => key === UNLABELLED ? 'No labels' : byKey.get(key)?.name ?? key}
        onValueChange={setSelection} open={open} onOpenChange={next => { if (next) setContainer(findComboboxContainer(trigger.current)); setOpen(next); setQuery(''); }}
        inputValue={query} onInputValueChange={setQuery} autoHighlight>
        <ComboboxTrigger ref={trigger} className="queue-label-add" aria-label="GitHub labels" onKeyDown={event => {
          if (open || event.nativeEvent.isComposing || event.metaKey || event.ctrlKey || event.altKey || event.key.length !== 1 || event.key === ' ') return;
          event.preventBaseUIHandler(); event.preventDefault(); event.stopPropagation();
          setContainer(findComboboxContainer(trigger.current)); setQuery(event.key); setOpen(true);
        }}>Add label</ComboboxTrigger>
        <ComboboxContent container={container} collisionBoundary={[]} className="queue-label-popup">
          <ComboboxInput aria-label="Search GitHub labels" placeholder="Search labels…" />
          <ComboboxEmpty>No matching labels.</ComboboxEmpty>
          <ComboboxList>{(key: string) => <ComboboxItem key={key} value={key} data-value={key}>
            {key === UNLABELLED ? <span>No labels</span> : <span className="pr-label" style={prLabelColors(byKey.get(key)?.color)} title={byKey.get(key)?.description}>{byKey.get(key)?.name}</span>}
          </ComboboxItem>}</ComboboxList>
          <div className="queue-label-footer"><span>{selected.length ? `${selected.length} selected` : 'Select labels to filter'}</span><button type="button" onClick={() => setOpen(false)}>Done</button></div>
        </ComboboxContent>
      </Combobox>
    </div>
    {value.names.length > 1 && <div className="queue-label-match" role="group" aria-label="Match selected labels">
      <span>Match</span>{(['any', 'all'] as const).map(mode => <button key={mode} type="button" aria-pressed={value.match === mode} onClick={() => onChange({ ...value, match: mode })}>{mode === 'any' ? 'Any' : 'All'}</button>)}
      <span>selected labels</span>
    </div>}
  </div>;
}
