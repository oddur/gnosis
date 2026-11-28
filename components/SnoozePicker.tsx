import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from 'react';
import { AlarmClock, CalendarClock, CircleCheck, MessageSquare, Moon, Sun, CalendarDays } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog';
import { Button } from './ui/button';
import { toast } from './ui/toast';
import { closeSnoozePicker, snoozePicker, type SnoozePickerRequest, type SnoozeTarget } from '../lib/snooze-picker';
import { presetDetail, snoozeChoiceLabel, snoozePresets, type SnoozeOn, type SnoozeRequest } from '../lib/snooze';
import { workbenchStore } from '../lib/workbench-store';

const same = (a: string, b: string | null) => !!b && a.toLowerCase() === b.toLowerCase();
/** "#412", "stack", "4 PRs". */
export function snoozeSubject(groups: readonly (readonly SnoozeTarget[])[]): string {
  const members = groups.flat();
  if (members.length === 1) return `#${members[0].number}`;
  if (groups.length === 1) return 'stack';
  return `${members.length} PRs`;
}
/**
 * Snooze without the picker, for a surface that offers the choices itself (the guided session's split button): the
 * same save, toast and Undo as the picker. Open PRs only. False when nothing can be snoozed.
 */
export function snoozeNow(groups: readonly (readonly SnoozeTarget[])[], choice: { until?: number; on: SnoozeOn[] }, onSaved?: (urls: string[]) => void): boolean {
  const open = groups.map((group) => group.filter((member) => member.state === 'open' && !member.merged)).filter((group) => group.length);
  if (!open.length) return false;
  const login = snoozePicker.account();
  void runSnooze(
    { action: 'snooze', groups: open.map((group) => group.map((member) => member.url)), ...choice },
    { title: `Snoozed ${snoozeSubject(open)} ${snoozeChoiceLabel(choice, Date.now())}`, description: pendingNote(open.flat(), login), onSaved }
  );
  return true;
}
/** Snoozing a PR that still needs the reader is allowed; the toast says what stays pending. */
function pendingNote(members: readonly SnoozeTarget[], login: string | null): string | undefined {
  const requested = members.filter((member) => !same(member.author, login) && member.requestedReviewers.some((reviewer) => same(reviewer, login)));
  if (!requested.length) return undefined;
  return requested.length === 1 && members.length === 1 ? 'Your review is still requested.' : `Your review is still requested on ${requested.map((member) => `#${member.number}`).join(', ')}.`;
}
const localInput = (at: number) => {
  const date = new Date(at);
  const pad = (n: number) => String(n).padStart(2, '0');
  return { date: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`, time: `${pad(date.getHours())}:${pad(date.getMinutes())}` };
};

/** Saves a snooze change and offers Undo. Errors keep everything as it was and say so. */
export async function runSnooze(request: SnoozeRequest, done: { title: string; description?: string; onSaved?: (urls: string[]) => void }) {
  const release = workbenchStore.hold();
  try {
    const result = await window.electronAPI.workbenchSnoozePrs(request);
    workbenchStore.apply(result.queue);
    done.onSaved?.(result.urls);
    const undo = result.undo;
    const id = toast.add({
      type: 'success',
      title: done.title,
      description: done.description,
      ...(undo
        ? {
            actionProps: {
              children: 'Undo',
              onClick: () => {
                toast.close(id);
                void runSnoozeUndo(undo);
              },
            },
          }
        : {}),
    });
  } catch (error) {
    toast.add({ type: 'error', title: 'Could not save the snooze', description: `${error instanceof Error ? error.message : String(error)} Nothing changed. Try again.` });
  } finally {
    release();
  }
}
async function runSnoozeUndo(token: string) {
  const release = workbenchStore.hold();
  try {
    workbenchStore.apply((await window.electronAPI.workbenchSnoozePrs({ action: 'undo', token })).queue);
  } catch (error) {
    toast.add({ type: 'error', title: 'Could not undo', description: error instanceof Error ? error.message : String(error) });
  } finally {
    release();
  }
}

/** The Snooze picker. Mounted once; any surface opens it with `openSnoozePicker`. */
export function SnoozePickerHost() {
  const request = useSyncExternalStore(snoozePicker.subscribe, snoozePicker.current);
  return <Dialog open={!!request} onOpenChange={(open) => { if (!open) closeSnoozePicker(); }}>{request && <SnoozePicker request={request} />}</Dialog>;
}

function SnoozePicker({ request }: { request: SnoozePickerRequest }) {
  const login = snoozePicker.account();
  const members = request.groups.flat();
  const subject = snoozeSubject(request.groups);
  const now = useMemo(() => Date.now(), []);
  const presets = useMemo(() => snoozePresets(now), [now]);
  const own = members.every((member) => same(member.author, login));
  const [custom, setCustom] = useState(false);
  const initial = localInput(presets.find((preset) => preset.id === 'tomorrow')?.until ?? now + 86_400_000);
  const [date, setDate] = useState(initial.date);
  const [time, setTime] = useState(initial.time);
  const [error, setError] = useState('');
  const list = useRef<HTMLDivElement>(null);
  const dateInput = useRef<HTMLInputElement>(null);
  useEffect(() => { if (custom) dateInput.current?.focus(); }, [custom]);
  const choose = (choice: { until?: number; on: SnoozeOn[] }) => {
    closeSnoozePicker();
    snoozeNow(request.groups, choice, request.onSnoozed);
  };
  const submitCustom = () => {
    const until = new Date(`${date}T${time}`).getTime();
    if (!Number.isFinite(until)) { setError('Choose a date and a time.'); return; }
    if (until <= Date.now() + 60_000) { setError('Choose a time in the future.'); return; }
    choose({ until, on: [] });
  };
  // Arrow keys move between the options, as in a menu.
  const move = (event: KeyboardEvent) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const buttons = [...(list.current?.querySelectorAll<HTMLButtonElement>('.snooze-option') ?? [])];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = buttons.at((index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length);
    if (next) { event.preventDefault(); next.focus(); }
  };
  const option = (key: string, icon: ReactNode, label: string, detail: string | undefined, run: () => void) => (
    <button key={key} type="button" className="snooze-option" onClick={run}>
      <span className="snooze-option-icon" aria-hidden="true">{icon}</span>
      <span className="snooze-option-label">{label}</span>
      {detail && <span className="snooze-option-detail">{detail}</span>}
    </button>
  );
  return (
    <DialogContent className="snooze-picker" showCloseButton={false} onOpenAutoFocus={(event) => { event.preventDefault(); list.current?.querySelector<HTMLButtonElement>('.snooze-option')?.focus(); }}>
      <div className="snooze-picker-header">
        <DialogTitle>Snooze {subject}</DialogTitle>
        <DialogDescription className="snooze-picker-subject">{members.length === 1 ? members[0].title : `${members.length} open PRs, back together`}</DialogDescription>
      </div>
      <div ref={list} className="snooze-options" role="group" aria-label="Snooze until" onKeyDown={move}>
        {presets.map((preset) => option(preset.id, preset.id === 'later' ? <Sun size={15} /> : preset.id === 'tomorrow' ? <Moon size={15} /> : <CalendarDays size={15} />, preset.label, presetDetail(preset.until, now), () => choose({ until: preset.until, on: [] })))}
        <div className="snooze-separator" role="separator" />
        {option('activity', <MessageSquare size={15} />, 'Until new activity', undefined, () => choose({ on: ['activity'] }))}
        {own && option('checks', <CircleCheck size={15} />, 'Until checks finish', undefined, () => choose({ on: ['checks'] }))}
        <div className="snooze-separator" role="separator" />
        {option('custom', <CalendarClock size={15} />, 'Custom…', undefined, () => setCustom(true))}
      </div>
      {custom && (
        <form className="snooze-custom" onSubmit={(event) => { event.preventDefault(); submitCustom(); }}>
          <label>
            <span>Date</span>
            <input ref={dateInput} type="date" value={date} min={localInput(now).date} onChange={(event) => { setDate(event.target.value); setError(''); }} />
          </label>
          <label>
            <span>Time</span>
            <input type="time" value={time} onChange={(event) => { setTime(event.target.value); setError(''); }} />
          </label>
          <Button type="submit" size="sm">Snooze</Button>
          {error && <p role="alert" className="snooze-custom-error">{error}</p>}
        </form>
      )}
      <p className="snooze-picker-note"><AlarmClock size={13} aria-hidden="true" />Timed snoozes also end on a new review or review request.</p>
    </DialogContent>
  );
}
