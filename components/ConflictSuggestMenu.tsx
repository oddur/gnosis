import { useEffect, useId, useState } from 'react';
import { Popover } from 'radix-ui';
import { ArrowLeft, ChevronDown, Files, MessageSquareText, Sparkles, Workflow } from 'lucide-react';
import { Button } from './ui/button';
import { PROVIDERS } from '../lib/models';

export type SuggestScope = 'file' | 'all';
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
 * One entry point for automatic proposals. Suggestions are drafts: they never mark a file reviewed.
 */
export function ConflictSuggestMenu({
  disabled,
  fileName,
  pendingFiles,
  model,
  onSuggest,
}: {
  disabled: boolean;
  fileName: string;
  /** Files that still need resolving or review, including this one. */
  pendingFiles: number;
  model: string;
  onSuggest: (engine: SuggestEngine, scope: SuggestScope, instructions?: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<'menu' | 'ask' | 'all'>('menu');
  const [scope, setScope] = useState<SuggestScope>('file');
  const [instructions, setInstructions] = useState('');
  const instructionsId = useId();
  const run = (engine: SuggestEngine, target: SuggestScope) => {
    setOpen(false);
    onSuggest(engine, target, engine === 'agent' ? instructions : undefined);
  };
  return (
    <Popover.Root
      open={open}
      onOpenChange={(value) => {
        setOpen(value);
        if (value) setView('menu');
      }}
    >
      <Popover.Trigger asChild>
        <Button size="sm" variant="outline" disabled={disabled} className="conflict-suggest-trigger">
          <Sparkles aria-hidden="true" />
          Suggest a resolution
          <ChevronDown aria-hidden="true" />
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={6}
          collisionPadding={12}
          aria-label="Suggest a resolution"
          className="conflict-suggest-menu z-50 rounded-md border bg-popover text-popover-foreground shadow-md"
        >
          {view === 'menu' ? (
            <>
              <p className="conflict-suggest-note">Suggestions are drafts. You still review each file.</p>
              <button type="button" className="conflict-suggest-item" onClick={() => run('mergiraf', 'file')}>
                <Workflow size={16} aria-hidden="true" />
                <span>
                  <strong>Structural merge</strong>
                  <small>
                    Combines both changes where they touch different code. Runs on this computer with Mergiraf.
                  </small>
                </span>
              </button>
              <button
                type="button"
                className="conflict-suggest-item"
                onClick={() => {
                  setScope('file');
                  setView('ask');
                }}
              >
                <MessageSquareText size={16} aria-hidden="true" />
                <span>
                  <strong>Ask {model}…</strong>
                  <small>Reads all three versions of {fileName}. Add instructions if you like.</small>
                </span>
              </button>
              {pendingFiles > 1 && (
                <button type="button" className="conflict-suggest-item" onClick={() => setView('all')}>
                  <Files size={16} aria-hidden="true" />
                  <span>
                    <strong>Suggest for all unreviewed files…</strong>
                    <small>{pendingFiles} files. Each one still needs your review.</small>
                  </span>
                </button>
              )}
            </>
          ) : (
            <div className="conflict-suggest-form">
              <Button size="xs" variant="ghost" onClick={() => setView('menu')}>
                <ArrowLeft aria-hidden="true" />
                Back
              </Button>
              <h3>{view === 'all' ? `All ${pendingFiles} unreviewed files` : `Ask ${model} about ${fileName}`}</h3>
              {view === 'all' && (
                <Button size="sm" variant="outline" onClick={() => run('mergiraf', 'all')}>
                  <Workflow aria-hidden="true" />
                  Structural merge for all files
                </Button>
              )}
              <label htmlFor={instructionsId}>
                Instructions for {model} <span>(optional)</span>
              </label>
              <textarea
                id={instructionsId}
                value={instructions}
                maxLength={10000}
                autoFocus={view === 'ask'}
                onChange={(event) => setInstructions(event.target.value)}
                placeholder="Which behavior should the result keep?"
              />
              <p className="conflict-suggest-note">
                {model} reads the three versions and your current draft. It does not run project tests.
              </p>
              <Button size="sm" onClick={() => run('agent', view === 'all' ? 'all' : scope)}>
                {view === 'all' ? `Ask ${model} for all files` : `Ask ${model}`}
              </Button>
            </div>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
