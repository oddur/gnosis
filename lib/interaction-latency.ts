/**
 * Records slow interactions in the renderer (#345), in the style of INP: a click, tap or key press that takes more
 * than about 100 ms from input to the next paint. Each record says what was pressed, where the time went (input
 * delay, event handlers, rendering the next frame) and, from long-animation-frame entries, which scripts ran.
 *
 * Records stay in memory, in a bounded ring buffer. The diagnostics export includes them, and an optional console
 * log prints each one as it happens. Nothing leaves the machine.
 */

/** One script that ran during a slow interaction's frames, from the Long Animation Frames API. */
export interface InteractionScript {
  /** `event-listener`, `user-callback`, `resolve-promise`, `classic-script` and so on. */
  invokerType: string;
  /** What called the script, such as `BUTTON#id.onclick` or `Window.requestAnimationFrame`. */
  invoker: string;
  /** The script's file name and function, without the origin or query: `ReviewDiff.tsx renderHunks`. */
  source: string;
  duration: number;
  /** Time the script spent forcing synchronous style and layout. */
  forcedLayout: number;
}

export interface SlowInteraction {
  /** Wall-clock time of the input, in epoch milliseconds. */
  at: number;
  /** The slowest event of the interaction: `click`, `keydown`, `pointerdown`… */
  type: string;
  /** The key for keyboard interactions, only when it is a named or navigation key such as `j` or `Enter`. */
  key?: string;
  /** A stable description of the target: tag, classes, role and data-attribute names, never text or values. */
  target: string;
  /** From the input to the next paint, as the Event Timing API reports it (rounded to 8 ms). */
  duration: number;
  /** From the input to the start of its event handlers. */
  inputDelay: number;
  /** Event handlers. */
  processing: number;
  /** From the end of the handlers to the next paint: rendering, style, layout and paint. */
  presentation: number;
  /** Totals from the long animation frames that overlap the interaction, when the API is available. */
  frames?: { count: number; blocking: number; script: number; styleAndLayout: number; render: number };
  /** Long tasks that overlap the interaction, when long animation frames are unavailable. */
  longTasks?: number;
  /** The slowest scripts in those frames, slowest first. */
  scripts: InteractionScript[];
}

export interface InteractionMonitorOptions {
  /** Record interactions at least this long. The Event Timing API reports from 16 ms. */
  threshold?: number;
  /** Ring buffer size. */
  capacity?: number;
  /** Print each slow interaction to the console. */
  log?: boolean;
}

export const DEFAULT_INTERACTION_THRESHOLD = 100;
const DEFAULT_CAPACITY = 200;
const LOG_KEY = 'gnosis:log-slow-interactions';

/** Ring buffer that keeps the newest `capacity` items. */
export class RingBuffer<T> {
  private items: T[] = [];
  private next = 0;
  constructor(readonly capacity: number) {}
  push(item: T): void {
    if (this.items.length < this.capacity) this.items.push(item);
    else this.items[this.next] = item;
    this.next = (this.next + 1) % this.capacity;
  }
  /** Oldest first. */
  toArray(): T[] {
    return this.items.length < this.capacity ? [...this.items] : [...this.items.slice(this.next), ...this.items.slice(0, this.next)];
  }
  clear(): void {
    this.items = [];
    this.next = 0;
  }
  get size(): number {
    return this.items.length;
  }
}

/** Attributes whose names, not values, identify an element across renders. */
const stableData = /^data-(?!state$|index$|active$|selected$|highlighted$|focus|disabled$|orientation$|side$|align$)/;
const utilityClass = /[:[\]/]|^(?:-?[a-z]{1,3}-|flex|grid|block|inline|hidden|relative|absolute|items-|justify-|gap-|text-|font-|w-|h-|min-|max-|p[xytrbl]?-|m[xytrbl]?-|rounded|border|bg-|shadow|truncate|overflow|shrink|grow)/;

function describeElement(element: Element): string {
  let part = element.tagName.toLowerCase();
  if (part.includes('-')) return part; // Custom elements such as diffs-container name themselves.
  const classes = [...element.classList].filter((name) => !utilityClass.test(name)).slice(0, 2);
  if (classes.length) part += '.' + classes.join('.');
  const role = element.getAttribute('role');
  if (role) part += `[role=${role}]`;
  for (const attribute of element.getAttributeNames()) if (stableData.test(attribute)) part += `[${attribute}]`;
  return part;
}

/** A selector-like description of where an interaction happened, such as
 * `.queue-list > [data-queue-id] > button.queue-row-main`. It names structure only: no text, ids or values, so
 * diagnostics never carry PR titles or file names. */
export function describeTarget(target: EventTarget | null | undefined): string {
  if (!target || typeof (target as Element).tagName !== 'string') return target === document ? 'document' : '(none)';
  const parts: string[] = [];
  let element: Element | null = target as Element;
  // Walk up through shadow roots too: diff lines live inside diffs-container.
  while (parts.length < 4) {
    const part = describeElement(element);
    const meaningful = part.includes('.') || part.includes('[') || part.includes('-') || parts.length === 0;
    if (meaningful) parts.unshift(part);
    if (element === document.body) break;
    const next: Element | null = element.parentElement ?? (element.getRootNode() as Partial<ShadowRoot>).host ?? null;
    if (!next) break;
    element = next;
  }
  return parts.join(' > ');
}

function scriptSource(url: string, name: string): string {
  const file = url ? (url.split('?')[0].split('/').pop() ?? '') : '';
  return [file, name].filter(Boolean).join(' ') || '(anonymous)';
}

interface FrameEntry {
  startTime: number;
  duration: number;
  blockingDuration?: number;
  renderStart?: number;
  styleAndLayoutStart?: number;
  scripts?: {
    invoker?: string;
    invokerType?: string;
    sourceURL?: string;
    sourceFunctionName?: string;
    duration: number;
    forcedStyleAndLayoutDuration?: number;
  }[];
}

interface EventEntry extends PerformanceEntry {
  processingStart: number;
  processingEnd: number;
  interactionId?: number;
  target?: Node | null;
}

/** Splits one Event Timing entry into input delay, processing and presentation. */
export function splitDuration(entry: { startTime: number; duration: number; processingStart: number; processingEnd: number }) {
  const inputDelay = Math.max(0, entry.processingStart - entry.startTime);
  const processing = Math.max(0, entry.processingEnd - entry.processingStart);
  return {
    duration: Math.round(entry.duration),
    inputDelay: Math.round(inputDelay),
    processing: Math.round(processing),
    presentation: Math.max(0, Math.round(entry.duration - inputDelay - processing)),
  };
}

/** Totals and top scripts from the frames that overlap `[start, end]`. */
export function attributeFrames(frames: readonly FrameEntry[], start: number, end: number, topScripts = 5) {
  const overlapping = frames.filter((f) => f.startTime < end && f.startTime + f.duration > start);
  if (!overlapping.length) return undefined;
  let script = 0;
  let styleAndLayout = 0;
  let render = 0;
  let blocking = 0;
  const scripts: InteractionScript[] = [];
  for (const frame of overlapping) {
    const frameEnd = frame.startTime + frame.duration;
    const renderStart = frame.renderStart || frameEnd;
    const styleStart = frame.styleAndLayoutStart || frameEnd;
    blocking += frame.blockingDuration ?? 0;
    render += Math.max(0, frameEnd - renderStart);
    styleAndLayout += Math.max(0, frameEnd - styleStart);
    for (const s of frame.scripts ?? []) {
      script += s.duration;
      scripts.push({
        invokerType: s.invokerType ?? '',
        invoker: (s.invoker ?? '').slice(0, 120),
        source: scriptSource(s.sourceURL ?? '', s.sourceFunctionName ?? ''),
        duration: Math.round(s.duration),
        forcedLayout: Math.round(s.forcedStyleAndLayoutDuration ?? 0),
      });
    }
  }
  scripts.sort((a, b) => b.duration - a.duration);
  return {
    frames: {
      count: overlapping.length,
      blocking: Math.round(blocking),
      script: Math.round(script),
      styleAndLayout: Math.round(styleAndLayout),
      render: Math.round(render),
    },
    scripts: scripts.slice(0, topScripts),
  };
}

const namedKey = /^(?:[a-z]|Enter|Escape|Tab|Arrow\w+|Page\w+|Home|End|Backspace|Delete| )$/;

class InteractionMonitor {
  private buffer = new RingBuffer<SlowInteraction>(DEFAULT_CAPACITY);
  private frames: FrameEntry[] = [];
  private cleanups: (() => void)[] = [];
  private keys = new Map<number, string>();
  private listeners = new Set<(entry: SlowInteraction) => void>();
  threshold = DEFAULT_INTERACTION_THRESHOLD;
  log = false;
  supported = false;
  frameTiming = false;

  start(options: InteractionMonitorOptions = {}): void {
    this.stop();
    this.threshold = Math.max(16, options.threshold ?? DEFAULT_INTERACTION_THRESHOLD);
    if (options.capacity && options.capacity !== this.buffer.capacity) this.buffer = new RingBuffer(options.capacity);
    this.log = options.log ?? readLogPreference();
    if (typeof PerformanceObserver === 'undefined') return;
    const types = PerformanceObserver.supportedEntryTypes as readonly string[] | undefined ?? [];
    this.supported = types.includes('event');
    if (!this.supported) return;
    this.frameTiming = types.includes('long-animation-frame');
    // Keep frames for a few seconds: event entries arrive after the frame that painted them.
    const frames = new PerformanceObserver((list) => {
      const now = performance.now();
      for (const entry of list.getEntries()) this.frames.push(entry as unknown as FrameEntry);
      this.frames = this.frames.filter((f) => now - (f.startTime + f.duration) < 5000);
    });
    try {
      frames.observe({ type: this.frameTiming ? 'long-animation-frame' : 'longtask', buffered: true });
      this.cleanups.push(() => frames.disconnect());
    } catch {
      // Neither API: records keep the Event Timing split alone.
    }
    // Keys are only on the event object, not on the timing entry. Note them by timestamp, which equals startTime.
    const remember = (event: KeyboardEvent) => {
      if (!event.isTrusted || !namedKey.test(event.key)) return;
      this.keys.set(Math.round(event.timeStamp * 10), event.key === ' ' ? 'Space' : event.key);
      if (this.keys.size > 50) this.keys.delete(this.keys.keys().next().value as number);
    };
    window.addEventListener('keydown', remember, { capture: true, passive: true });
    this.cleanups.push(() => window.removeEventListener('keydown', remember, { capture: true }));
    const events = new PerformanceObserver((list) => this.onEvents(list.getEntries() as EventEntry[]));
    events.observe({ type: 'event', durationThreshold: this.threshold, buffered: true } as PerformanceObserverInit);
    this.cleanups.push(() => events.disconnect());
  }

  stop(): void {
    for (const cleanup of this.cleanups) cleanup();
    this.cleanups = [];
  }

  private onEvents(entries: EventEntry[]): void {
    // An interaction is several events (pointerdown, pointerup, click). Keep the slowest event of each.
    const slowest = new Map<number | string, EventEntry>();
    for (const entry of entries) {
      if (entry.duration < this.threshold) continue;
      const id = entry.interactionId || `${entry.name}:${entry.startTime}`;
      // Hover and scroll-like events have no interaction id; only count those that are discrete inputs.
      if (!entry.interactionId && !/^(?:click|keydown|keyup|pointerdown|pointerup|mousedown|mouseup|input|beforeinput|dblclick|contextmenu)$/.test(entry.name)) continue;
      const kept = slowest.get(id);
      if (!kept || entry.duration > kept.duration || (entry.duration === kept.duration && entry.processingEnd - entry.processingStart > kept.processingEnd - kept.processingStart))
        slowest.set(id, entry);
    }
    if (!slowest.size) return;
    const pending = [...slowest.values()].map((entry) => ({ entry, target: describeTarget(entry.target) }));
    // The long animation frame that painted the interaction is reported at about the same time. Wait a frame or two.
    setTimeout(() => {
      for (const { entry, target } of pending) this.record(entry, target);
    }, 50);
  }

  private record(entry: EventEntry, target: string): void {
    const end = entry.startTime + entry.duration;
    const split = splitDuration(entry);
    const attribution = this.frameTiming ? attributeFrames(this.frames, entry.startTime, end) : undefined;
    const longTasks = this.frameTiming
      ? undefined
      : Math.round(this.frames.filter((t) => t.startTime < end && t.startTime + t.duration > entry.startTime).reduce((sum, t) => sum + t.duration, 0));
    const key = this.keys.get(Math.round(entry.startTime * 10));
    const interaction: SlowInteraction = {
      at: Math.round(performance.timeOrigin + entry.startTime),
      type: entry.name,
      ...(key ? { key } : {}),
      target,
      ...split,
      ...(attribution ? { frames: attribution.frames } : {}),
      ...(longTasks !== undefined ? { longTasks } : {}),
      scripts: attribution?.scripts ?? [],
    };
    this.buffer.push(interaction);
    if (this.log) logInteraction(interaction);
    for (const listener of this.listeners) listener(interaction);
  }

  entries(): SlowInteraction[] {
    return this.buffer.toArray();
  }

  clear(): void {
    this.buffer.clear();
  }

  subscribe(listener: (entry: SlowInteraction) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

function readLogPreference(): boolean {
  try {
    return localStorage.getItem(LOG_KEY) === '1';
  } catch {
    return false;
  }
}

function logInteraction(entry: SlowInteraction): void {
  const scripts = entry.scripts.slice(0, 3).map((s) => `${s.source} ${s.duration}ms`).join(', ');
  console.warn(
    `[slow interaction] ${entry.type}${entry.key ? ` ${entry.key}` : ''} on ${entry.target}: ${entry.duration}ms ` +
      `(input ${entry.inputDelay}, handlers ${entry.processing}, paint ${entry.presentation})${scripts ? ` · ${scripts}` : ''}`
  );
}

const monitor = new InteractionMonitor();

/** Starts recording slow interactions. Calling it again restarts with new options. */
export function startInteractionMonitor(options?: InteractionMonitorOptions): void {
  monitor.start(options);
}

/** Recorded slow interactions, oldest first. */
export function slowInteractions(): SlowInteraction[] {
  return monitor.entries();
}

export function clearSlowInteractions(): void {
  monitor.clear();
}

export function onSlowInteraction(listener: (entry: SlowInteraction) => void): () => void {
  return monitor.subscribe(listener);
}

export function interactionMonitorState() {
  return { supported: monitor.supported, frameTiming: monitor.frameTiming, threshold: monitor.threshold, log: monitor.log };
}

/** Turns the console log on or off, and remembers the choice on this machine. */
export function setSlowInteractionLog(enabled: boolean): void {
  monitor.log = enabled;
  try {
    if (enabled) localStorage.setItem(LOG_KEY, '1');
    else localStorage.removeItem(LOG_KEY);
  } catch {
    // Storage can be unavailable; the setting then lasts for this session.
  }
}

/** The slowest recorded interactions, slowest first. */
export function slowestInteractions(entries: readonly SlowInteraction[], count = 10): SlowInteraction[] {
  return [...entries].sort((a, b) => b.duration - a.duration).slice(0, count);
}
