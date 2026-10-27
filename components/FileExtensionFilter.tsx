import { useId, useMemo, useRef, useState } from 'react';
import { fileExtension } from '../lib/file-kinds';
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxTrigger,
  findComboboxContainer,
} from './ui/combobox';
const NONE = 'no-extension';
const label = (extension: string) => (extension === NONE ? 'No extension' : extension);
export function FileExtensionFilter({
  paths,
  value,
  disabled,
  onChange,
}: {
  paths: string[];
  value: string[];
  disabled: boolean;
  onChange: (extensions: string[]) => void;
}) {
  const id = useId(),
    trigger = useRef<HTMLButtonElement>(null);
  const [container, setContainer] = useState<HTMLElement | null>(null),
    [open, setOpen] = useState(false),
    [query, setQuery] = useState('');
  const counts = useMemo(() => {
    const result = new Map<string, number>();
    for (const path of paths) {
      const key = fileExtension(path) || NONE;
      result.set(key, (result.get(key) ?? 0) + 1);
    }
    return result;
  }, [paths]);
  const selected = value.map((extension) => extension || NONE);
  const items = [...new Set([...counts.keys(), ...selected])].sort((a, b) =>
    a === NONE ? 1 : b === NONE ? -1 : a.localeCompare(b)
  );
  return (
    <div className="file-extension-filter" role="group" aria-labelledby={`${id}-label`}>
      <div className="file-extension-heading">
        <strong id={`${id}-label`}>Hide extensions</strong>
        {value.length > 0 && (
          <button aria-label="Clear hidden extensions" disabled={disabled} onClick={() => onChange([])}>
            Clear
          </button>
        )}
      </div>
      <Combobox
        multiple
        items={items}
        value={selected}
        itemToStringLabel={label}
        disabled={disabled}
        onValueChange={(keys) => onChange(keys.map((key) => (key === NONE ? '' : key)))}
        open={open}
        onOpenChange={(next) => {
          if (next) setContainer(findComboboxContainer(trigger.current));
          setOpen(next);
          setQuery('');
        }}
        inputValue={query}
        onInputValueChange={setQuery}
        autoHighlight
      >
        <ComboboxTrigger
          ref={trigger}
          aria-label="File extensions"
          aria-describedby={`${id}-help`}
          title={selected.length ? selected.map(label).join(', ') : 'Choose extensions…'}
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
            setQuery(event.key);
            setOpen(true);
          }}
        >
          {selected.length ? selected.map(label).join(', ') : 'Choose extensions…'}
        </ComboboxTrigger>
        <ComboboxContent container={container} collisionBoundary={[]} className="file-extension-popup">
          <ComboboxInput aria-label="Search file extensions" placeholder="Type an extension…" />
          <ComboboxEmpty>No matching extensions.</ComboboxEmpty>
          <ComboboxList>
            {(key: string) => (
              <ComboboxItem key={key} value={key} data-value={key}>
                <span>{label(key)}</span>
                <span className="file-extension-count">{counts.get(key) ?? 0}</span>
              </ComboboxItem>
            )}
          </ComboboxList>
          <div className="file-extension-footer">
            <span>{selected.length} selected</span>
            <button onClick={() => setOpen(false)}>Done</button>
          </div>
        </ComboboxContent>
      </Combobox>
      <p id={`${id}-help`}>Files with these extensions stay hidden across PRs.</p>
    </div>
  );
}
