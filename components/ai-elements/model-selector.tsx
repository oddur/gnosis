/**
 * Model Selector, after shadcn/ui AI Elements (https://ui.shadcn.com/docs/ai-elements/base/model-selector, MIT): a
 * Dropdown Menu in the prompt input's footer, with one radio group per provider. A value is `provider:model`, so the
 * same model id under two providers stays distinct.
 */
import { Fragment } from 'react';
import { ChevronDownIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { InputGroupButton } from '@/components/ui/input-group';

export interface ModelSelectorGroup {
  id: string;
  label: string;
  models: { id: string; label: string }[];
}

export const modelSelectorValue = (group: string, model: string) => `${group}:${model}`;

export function ModelSelector({
  groups,
  value,
  onValueChange,
  label = 'Model',
  className,
  format,
}: {
  groups: ModelSelectorGroup[];
  /** `group:model`, as modelSelectorValue makes it. */
  value: string;
  onValueChange: (group: string, model: string) => void;
  label?: string;
  className?: string;
  /** The trigger's text for a value id; the item's label by default. */
  format?: (id: string) => string;
}) {
  const [groupId, ...rest] = value.split(':');
  const modelId = rest.join(':');
  const group = groups.find((g) => g.id === groupId);
  const name = format?.(modelId) ?? group?.models.find((m) => m.id === modelId)?.label ?? modelId;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <InputGroupButton
            size="xs"
            variant="ghost"
            className={cn('model-selector-trigger', className)}
            aria-label={`${label}: ${name}${group ? `, ${group.label}` : ''}`}
            title={`${label}: ${name}${group ? `, ${group.label}` : ''}`}
          />
        }
      >
        <span className="model-selector-name">{name}</span>
        <ChevronDownIcon aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="model-selector-menu">
        <DropdownMenuRadioGroup
          value={value}
          onValueChange={(next: unknown) => {
            if (typeof next !== 'string') return;
            const [g, ...m] = next.split(':');
            onValueChange(g, m.join(':'));
          }}
        >
          {groups.map((g, index) => (
            <Fragment key={g.id}>
              {index > 0 && <DropdownMenuSeparator />}
              <DropdownMenuGroup>
                <DropdownMenuLabel>{g.label}</DropdownMenuLabel>
                {g.models.map((m) => (
                  <DropdownMenuRadioItem key={m.id} value={modelSelectorValue(g.id, m.id)} closeOnClick>
                    {m.label}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuGroup>
            </Fragment>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
