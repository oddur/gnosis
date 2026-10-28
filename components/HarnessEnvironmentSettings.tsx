import { useEffect, useId, useState } from 'react';
import { Eye, EyeOff, Plus, Trash2 } from 'lucide-react';
import { Button } from './ui/button';
import { useSessionDraft } from '../lib/session-drafts';
import { validateEnvironmentVariables, type EnvironmentVariable } from '../lib/harness-environment';
import type { Provider } from '../lib/models';

function ProviderEnvironment({ provider, label }: { provider: Provider; label: string }) {
  const id = useId();
  const [draft, setDraft] = useSessionDraft<{ rows: EnvironmentVariable[]; dirty: boolean }>(
    `harness-environment:${provider}`,
    { rows: [], dirty: false }
  );
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [retry, setRetry] = useState(0);
  const [saving, setSaving] = useState(false);
  const [visible, setVisible] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    let active = true;
    setState('loading');
    setError('');
    window.electronAPI
      .loadHarnessEnvironment()
      .then((values) => {
        if (!active) return;
        setDraft((previous) => (previous.dirty ? previous : { rows: values[provider], dirty: false }));
        setState('ready');
      })
      .catch(() => {
        if (!active) return;
        setError('Could not load saved variables. Unlock your system keychain, then retry.');
        setState('error');
      });
    return () => {
      active = false;
    };
    // Session drafts survive closing Settings; loading must not replace unsaved edits.
  }, [provider, retry]);
  function edit(rows: EnvironmentVariable[]) {
    setDraft({ rows, dirty: true });
    setError('');
    setSaved(false);
  }
  async function save() {
    setError('');
    setSaving(true);
    try {
      const rows = validateEnvironmentVariables(provider, draft.rows);
      await window.electronAPI.saveHarnessEnvironment(provider, rows);
      setDraft({ rows, dirty: false });
      setSaved(true);
    } catch {
      // Backend messages are deliberately value-free; do not expose raw IPC diagnostics.
      let message = 'Could not save variables. Check your system keychain and disk space, then retry.';
      try {
        validateEnvironmentVariables(provider, draft.rows);
      } catch (validation) {
        if (validation instanceof Error) message = validation.message;
      }
      setError(message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <fieldset className="min-w-0 space-y-3" disabled={saving} data-environment-provider={provider}>
      <legend className="text-sm font-medium mb-2">{label}</legend>
      {state === 'loading' && (
        <p role="status" className="settings-description">
          Loading variables…
        </p>
      )}
      {state === 'ready' && (
        <>
          {draft.rows.length === 0 ? (
            <p className="settings-description">No overrides. Uses inherited environment variables.</p>
          ) : (
            <>
              <div className="flex justify-end">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-pressed={visible}
                  onClick={() => setVisible(!visible)}
                >
                  {visible ? <EyeOff size={14} /> : <Eye size={14} />}
                  {visible ? 'Hide values' : 'Show values'}
                </Button>
              </div>
              <div className="space-y-3">
                {draft.rows.map((row, index) => (
                  <div key={index} className="flex items-end gap-2">
                    <div className="grid min-w-0 flex-1 grid-cols-1 sm:grid-cols-2 gap-2">
                      <label htmlFor={`${id}-name-${index}`} className="min-w-0 text-xs text-muted-foreground">
                        Name
                        <input
                          id={`${id}-name-${index}`}
                          aria-label={`${label} variable ${index + 1} name`}
                          value={row.name}
                          spellCheck={false}
                          autoCapitalize="none"
                          autoCorrect="off"
                          autoComplete="off"
                          placeholder="VARIABLE_NAME"
                          className="mt-1 h-9 w-full min-w-0 rounded-md border border-input bg-background px-2 font-mono text-sm text-foreground"
                          onChange={(event) =>
                            edit(
                              draft.rows.map((item, i) => (i === index ? { ...item, name: event.target.value } : item))
                            )
                          }
                        />
                      </label>
                      <label htmlFor={`${id}-value-${index}`} className="min-w-0 text-xs text-muted-foreground">
                        Value
                        <input
                          id={`${id}-value-${index}`}
                          aria-label={`${label} variable ${index + 1} value`}
                          type={visible ? 'text' : 'password'}
                          value={row.value}
                          spellCheck={false}
                          autoCapitalize="none"
                          autoCorrect="off"
                          autoComplete="off"
                          data-1p-ignore
                          data-lpignore="true"
                          className="mt-1 h-9 w-full min-w-0 rounded-md border border-input bg-background px-2 font-mono text-sm text-foreground"
                          onChange={(event) =>
                            edit(
                              draft.rows.map((item, i) => (i === index ? { ...item, value: event.target.value } : item))
                            )
                          }
                        />
                      </label>
                    </div>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      aria-label={`Remove ${label} variable ${index + 1}`}
                      onClick={() => edit(draft.rows.filter((_, i) => i !== index))}
                    >
                      <Trash2 size={16} />
                    </Button>
                  </div>
                ))}
              </div>
            </>
          )}
          <div className="flex items-center gap-2 flex-wrap">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={draft.rows.length >= 100}
              onClick={() => edit([...draft.rows, { name: '', value: '' }])}
            >
              <Plus size={14} />
              Add variable
            </Button>
            <Button type="button" variant="secondary" size="sm" disabled={!draft.dirty} onClick={() => void save()}>
              {saving ? 'Saving…' : `Save ${label} variables`}
            </Button>
            <span role="status" className="text-xs text-muted-foreground">
              {draft.dirty ? 'Unsaved changes' : saved ? 'Saved' : ''}
            </span>
          </div>
        </>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {state === 'error' && (
        <Button type="button" variant="outline" size="sm" onClick={() => setRetry((value) => value + 1)}>
          Retry loading {label} variables
        </Button>
      )}
    </fieldset>
  );
}

export function HarnessEnvironmentSettings() {
  return (
    <section className="space-y-5" aria-labelledby="harness-environment-title">
      <div className="space-y-2">
        <h3 id="harness-environment-title" className="text-sm font-medium">
          AI environment variables
        </h3>
        <p className="settings-description">
          Override variables for each AI tool. Saved values are encrypted on this computer and apply to new jobs.
        </p>
        <p className="settings-description">
          Values are literal text, without shell expansion. An empty value overrides the inherited value. Remove a
          variable and save to use the inherited value again.
        </p>
      </div>
      <ProviderEnvironment provider="claude" label="Claude" />
      <p className="settings-description">
        Gnosis manages <code>CLAUDECODE</code>, <code>CLAUDE_CODE_EFFORT_LEVEL</code>, and{' '}
        <code>MAX_THINKING_TOKENS</code>. Use the model and thinking settings for Claude effort.
      </p>
      <div className="border-t border-border pt-4">
        <ProviderEnvironment provider="codex" label="Codex" />
      </div>
    </section>
  );
}
