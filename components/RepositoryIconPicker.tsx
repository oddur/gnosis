import { useMemo, useRef, useState } from 'react';
import iconNames from '../lib/lucide-icon-names.json';
import { repositoryLucideName, type RepositorySettings } from '../lib/repository-settings';
import { RepositoryIcon } from './RepositoryAppearance';
import { Button } from './ui/button';
import {
  Combobox,
  ComboboxContent,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxEmpty,
  ComboboxTrigger,
  findComboboxContainer,
} from './ui/combobox';

const labelFor = (name: string) => name.replaceAll('-', ' ').replace(/\b\w/g, (c) => c.toUpperCase());
const icons = iconNames.map((name) => ({ value: `lucide:${name}`, label: labelFor(name) }));
const special = [
  { value: 'default', label: 'Default icon' },
  { value: 'emoji', label: 'Use an emoji' },
];
const labels = new Map([...special, ...icons].map((item) => [item.value, item.label]));
const PAGE_SIZE = 48;

export function RepositoryIconPicker({
  value,
  color,
  onChange,
}: {
  value: string;
  color?: RepositorySettings['color'];
  onChange: (value: string) => void;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(PAGE_SIZE);
  const selected = special.some((item) => item.value === value)
    ? value
    : `lucide:${repositoryLucideName(value) ?? 'book-marked'}`;
  const matches = useMemo(() => {
    const words = query.toLowerCase().replaceAll('-', ' ').trim().split(/\s+/).filter(Boolean);
    return icons.filter((item) => words.every((word) => item.label.toLowerCase().includes(word)));
  }, [query]);
  const items = [
    ...special.filter((item) => item.label.toLowerCase().includes(query.toLowerCase())),
    ...matches.slice(0, limit),
  ].map((item) => item.value);
  function search(next: string) {
    setQuery(next);
    setLimit(PAGE_SIZE);
  }
  const label = (item: string) => (
    <span className="repository-icon-option">
      <RepositoryIcon settings={{ icon: item === 'default' || item === 'emoji' ? undefined : item, color }} />
      <span>{labels.get(item) ?? item}</span>
    </span>
  );
  return (
    <Combobox
      items={items}
      filter={null}
      value={selected}
      itemToStringLabel={(item) => labels.get(item) ?? item}
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        search('');
        if (next) setContainer(findComboboxContainer(trigger.current));
      }}
      inputValue={query}
      onInputValueChange={search}
      autoHighlight
      onValueChange={(next) => {
        if (next) onChange(next);
      }}
    >
      <ComboboxTrigger
        ref={trigger}
        value={selected}
        aria-label="Repository icon"
        title={labels.get(selected)}
        onKeyDown={(event) => {
          if (
            open ||
            event.nativeEvent.isComposing ||
            event.metaKey ||
            event.ctrlKey ||
            event.altKey ||
            event.key.length !== 1 ||
            event.key === ' '
          )
            return;
          event.preventBaseUIHandler();
          event.preventDefault();
          event.stopPropagation();
          setContainer(findComboboxContainer(trigger.current));
          search(event.key);
          setOpen(true);
        }}
      >
        {label(selected)}
      </ComboboxTrigger>
      <ComboboxContent container={container} className="repository-icon-picker">
        <ComboboxInput
          aria-label="Search repository icons"
          placeholder={`Search ${iconNames.length.toLocaleString()} Lucide icons…`}
        />
        <ComboboxEmpty>No icons match. Try another name.</ComboboxEmpty>
        <ComboboxList>
          {(item: string) => (
            <ComboboxItem key={item} value={item} data-value={item}>
              {label(item)}
            </ComboboxItem>
          )}
        </ComboboxList>
        <div className="repository-icon-picker-footer">
          <span>
            {matches.length.toLocaleString()} {query ? 'matching' : 'Lucide'} {matches.length === 1 ? 'icon' : 'icons'}
          </span>
          {matches.length > limit && (
            <Button type="button" size="sm" variant="ghost" onClick={() => setLimit((count) => count + PAGE_SIZE)}>
              Show more
            </Button>
          )}
        </div>
      </ComboboxContent>
    </Combobox>
  );
}
