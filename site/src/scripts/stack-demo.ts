import { awaitFrames } from '../lib/demo';
const panels = document.querySelectorAll<HTMLDetailsElement>('[data-pr]');
const panel = document.querySelector<HTMLDetailsElement>('[data-pr="1"]');
if (panel) {
  function required<T extends Element>(node: T | null): T {
    if (!node) throw new Error('Missing example control');
    return node;
  }
  let step = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const play = required(panel.querySelector<HTMLButtonElement>('[data-play]'));
  const next = required(panel.querySelector<HTMLButtonElement>('[data-next]'));
  const previous = required(panel.querySelector<HTMLButtonElement>('[data-prev]'));
  const playLabel = required(panel.querySelector('[data-play-label]'));
  required(panel.querySelector<HTMLElement>('[data-controls]')).hidden = false;
  const stop = () => {
    clearTimeout(timer);
    timer = undefined;
    const ended = step === awaitFrames.length - 1;
    playLabel.textContent = ended ? 'Replay' : 'Play';
    play.setAttribute('aria-label', ended ? 'Replay explanation' : 'Play explanation');
    play.dataset.playing = 'false';
  };
  const render = () => {
    const frame = awaitFrames[step];
    required(panel.querySelector('[data-count]')).textContent = `${step + 1} / ${awaitFrames.length}`;
    required(panel.querySelector('[data-step-title]')).textContent = frame.title;
    required(panel.querySelector('[data-caption]')).textContent = frame.caption;
    for (const side of ['before', 'after'] as const) {
      const state = frame[side];
      const lane = required(panel.querySelector<HTMLElement>(`[data-lane="${side}"]`));
      lane.dataset.exceeded = String(state.peak > 1);
      required(lane.querySelector('[data-active-count]')).textContent =
        `${state.active} active${state.active > 1 ? ' · limit exceeded' : ''}`;
      required(lane.querySelector('[data-peak]')).textContent = String(state.peak);
      required(lane.querySelector('[data-slot]')).textContent = state.slot;
      required(lane.querySelector('title')).textContent = `${side === 'before' ? 'Before' : 'After'}: ${frame.title}`;
      const locations = state.positions
        .map((x, i) => `${i === 0 ? 'A' : 'B'} ${x < 200 ? 'waiting' : x < 400 ? 'running' : 'done'}`)
        .join('. ');
      required(lane.querySelector('desc')).textContent =
        `${locations}. ${state.active} active. Slot: ${state.slot}. Peak: ${state.peak}.`;
      lane.querySelectorAll<SVGGElement>('[data-command]').forEach((node, i) => {
        node.style.transform = `translate(${state.positions[i]}px,62px)`;
      });
      panel
        .querySelectorAll('[data-source-line]')
        .forEach((node, i) => node.classList.toggle(`is-${side}-current`, i === state.line));
    }
    next.disabled = step === awaitFrames.length - 1;
    previous.disabled = step === 0;
  };
  const tick = () => {
    if (!panel.open || document.hidden) {
      stop();
      return;
    }
    step++;
    render();
    if (step === awaitFrames.length - 1) stop();
    else timer = setTimeout(tick, 4200);
  };
  play.addEventListener('click', () => {
    if (timer) {
      stop();
      return;
    }
    if (step === awaitFrames.length - 1) {
      step = 0;
      render();
    }
    playLabel.textContent = 'Pause';
    play.setAttribute('aria-label', 'Pause explanation');
    play.dataset.playing = 'true';
    timer = setTimeout(tick, 2400);
  });
  const go = (value: number) => {
    stop();
    step = value;
    render();
    stop();
  };
  next.addEventListener('click', () => go(Math.min(step + 1, awaitFrames.length - 1)));
  previous.addEventListener('click', () => go(Math.max(step - 1, 0)));
  required(panel.querySelector('[data-reset]')).addEventListener('click', () => go(0));
  panel.addEventListener('toggle', () => {
    if (!panel.open) stop();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stop();
  });
  matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', stop);
  if ('IntersectionObserver' in window)
    new IntersectionObserver((entries) => {
      if (!entries[0].isIntersecting) stop();
    }).observe(panel);
}
for (const entry of panels) {
  entry.querySelector('summary')?.addEventListener('click', () => {
    if (!entry.open) for (const other of panels) if (other !== entry) other.open = false;
  });
}
