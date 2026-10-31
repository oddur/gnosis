import { RepositoryMark } from './RepositoryAppearance';
import { useRepositorySettings } from '../lib/use-repository-settings';
import { repositoryKey, validRepository } from '../lib/repository-settings';
import { useMemo, useRef, useState } from 'react';
import {
  Combobox,
  findComboboxContainer,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxTrigger,
} from './ui/combobox';

export interface SelectionOption {
  value: string;
  label: string;
}

/** A compact selector with local search. Typing never changes the committed value. */
export function SearchableSelect({
  options,
  repositoryOptions = false,
  value,
  onValueChange,
  label,
  id,
  className,
  popupClassName,
  popupBoundary = 'container',
  disabled,
  describedBy,
  triggerLabel,
  current,
  placeholder = 'Choose an option',
}: {
  repositoryOptions?: boolean;
  options: SelectionOption[];
  value: string;
  onValueChange: (value: string) => void;
  label: string;
  id?: string;
  className?: string;
  popupClassName?: string;
  /** Small parent popovers can retain focus ownership while positioning against the window. */
  popupBoundary?: 'container' | 'viewport';
  disabled?: boolean;
  describedBy?: string;
  triggerLabel?: string;
  current?: boolean;
  placeholder?: string;
}) {
  const { settings } = useRepositorySettings();
  const optionLabel = (value: string, label: string | undefined) => repositoryOptions && validRepository(value) ? <RepositoryMark repo={label ?? value} settings={settings[repositoryKey(value)]} /> : label;
  const trigger = useRef<HTMLButtonElement>(null);
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  // Saved views may refer to a value absent from the currently cached queue.
  const choices = useMemo(
    () => (options.some((o) => o.value === value) || !value ? options : [{ value, label: value }, ...options]),
    [options, value]
  );
  const labels = useMemo(() => new Map(choices.map((o) => [o.value, o.label])), [choices]);
  const items = useMemo(() => choices.map((o) => o.value), [choices]);
  return (
    <Combobox
      items={items}
      value={value || null}
      itemToStringLabel={(item) => labels.get(item) ?? item}
      onValueChange={(next) => {
        if (next !== null) onValueChange(next);
      }}
      open={open}
      onOpenChange={(next) => {
        if (next) setContainer(findComboboxContainer(trigger.current));
        setOpen(next);
        setQuery('');
      }}
      inputValue={query}
      onInputValueChange={setQuery}
      autoHighlight
      disabled={disabled}
    >
      <ComboboxTrigger
        ref={trigger}
        id={id}
        value={value}
        aria-label={label}
        aria-describedby={describedBy}
        aria-current={current ? 'page' : undefined}
        className={className}
        title={labels.get(value) ?? placeholder}
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
          // Base UI's closed-trigger typeahead commits immediately. Search first,
          // leaving the current selection intact until the user chooses an item.
          event.preventBaseUIHandler();
          event.preventDefault();
          event.stopPropagation();
          setContainer(findComboboxContainer(trigger.current));
          setQuery(event.key);
          setOpen(true);
        }}
      >
        {triggerLabel ?? optionLabel(value, labels.get(value)) ?? placeholder}
      </ComboboxTrigger>
      <ComboboxContent container={container} collisionBoundary={popupBoundary === 'viewport' ? [] : undefined} className={popupClassName}>
        <ComboboxInput aria-label={`Search ${label.toLowerCase()}`} placeholder="Type to search…" />
        <ComboboxEmpty>No matches. Try another search.</ComboboxEmpty>
        <ComboboxList>
          {(item: string) => (
            <ComboboxItem key={item} value={item} data-value={item}>
              {optionLabel(item, labels.get(item)) ?? item}
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}
