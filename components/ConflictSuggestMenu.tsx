import { useEffect, useId, useState } from 'react';
import { Popover } from 'radix-ui';
import { Bot } from 'lucide-react';
import { Button } from './ui/button';
import { PROVIDERS } from '../lib/models';

export type SuggestEngine = 'mergiraf' | 'agent';

/** The model the agent suggestion uses, read from the existing preferences. */
export function useSuggestionModel() {
  const [label, setLabel] = useState('the agent');
  useEffect(() => {
    let live = true;
    void window.electronAPI
      .loadPreferences()
      .then((preferences) => {
        const provider = preferences.provider === 'codex' ? PROVIDERS.codex : PROVIDERS.claude;
        const model = (provider.models as readonly { id: string; label: string }[]).find(
          (m) => m.id === preferences.model
        );
        if (live && model) setLabel(model.label);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  return label;
}

/**
 * Ask the model about one file, with optional instructions. Gnosis already ran structural merge on every file, so this
 * is the one way left to ask for a different result. Its result is a draft: it never marks a file reviewed.
 */
export function ConflictSuggestMenu({
  disabled,
  fileName,
  model,
  onAsk,
}: {
  disabled: boolean;
  fileName: string;
  model: string;
  onAsk: (instructions: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [instructions, setInstructions] = useState('');
  const instructionsId = useId();
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <Button size="sm" variant="ghost" disabled={disabled} className="conflict-suggest-trigger">
          <Bot aria-hidden="true" />
          Ask {model}…
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={6}
          collisionPadding={12}
          aria-label={`Ask ${model} about ${fileName}`}
          className="conflict-suggest-menu z-50 rounded-md border bg-popover text-popover-foreground shadow-md"
        >
          <div className="conflict-suggest-form">
            <h3>
              Ask {model} about {fileName}
            </h3>
            <label htmlFor={instructionsId}>
              Instructions <span>(optional)</span>
            </label>
            <textarea
              id={instructionsId}
              value={instructions}
              maxLength={10000}
              autoFocus
              onChange={(event) => setInstructions(event.target.value)}
              placeholder="Which behavior should the result keep?"
            />
            <p className="conflict-suggest-note">
              {model} reads the three versions and your draft. It does not run project tests. You review the result.
            </p>
            <Button
              size="sm"
              onClick={() => {
                setOpen(false);
                onAsk(instructions);
              }}
            >
              Ask {model}
            </Button>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
