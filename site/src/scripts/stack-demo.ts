import { examplePrs } from '../lib/demo';
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const players: { stop: () => void }[] = [];
for (const panel of document.querySelectorAll<HTMLDetailsElement>('[data-pr]')) {
  const pr = examplePrs.at(Number(panel.dataset.pr));
  if (!pr) continue;
  function required<T extends Element>(node: T | null): T {
    if (!node) throw new Error('Missing example control');
    return node;
  }
  let step = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const play = required(panel.querySelector<HTMLButtonElement>('[data-play]'));
  const next = required(panel.querySelector<HTMLButtonElement>('[data-next]'));
  const playLabel = required(panel.querySelector('[data-play-label]'));
  const controls = required(panel.querySelector<HTMLElement>('[data-controls]'));
  controls.hidden = false;
  const stop = () => {
    clearTimeout(timer);
    timer = undefined;
    playLabel.textContent = step === pr.frames.length - 1 ? 'Replay' : 'Play';
    play.setAttribute('aria-label', step === pr.frames.length - 1 ? 'Replay explanation' : 'Play explanation');
    play.dataset.playing = 'false';
  };
  players.push({ stop });
  const render = () => {
    const frame = pr.frames[step];
    required(panel.querySelector('[data-limit]')).textContent = frame.limit;
    required(panel.querySelector('[data-count]')).textContent = `${step + 1} / ${pr.frames.length}`;
    required(panel.querySelector('[data-step-title]')).textContent = frame.title;
    required(panel.querySelector('[data-caption]')).textContent = frame.caption;
    required(panel.querySelector('svg.queue-figure title')).textContent = frame.title;
    required(panel.querySelector('svg.queue-figure desc')).textContent = frame.caption;
    panel.querySelectorAll<SVGGElement>('[data-command]').forEach((node, i) => {
      node.style.transform = `translate(${frame.places[i][0]}px, ${frame.places[i][1]}px)`;
    });
    panel
      .querySelectorAll('[data-source-line]')
      .forEach((node, i) => node.classList.toggle('is-current', i === frame.line));
    next.disabled = step === pr.frames.length - 1;
  };
  const tick = () => {
    if (!panel.open || document.hidden) {
      stop();
      return;
    }
    step++;
    render();
    if (step === pr.frames.length - 1) stop();
    else timer = setTimeout(tick, 2200);
  };
  play.addEventListener('click', () => {
    if (timer) {
      stop();
      return;
    }
    if (step === pr.frames.length - 1) {
      step = 0;
      render();
    }
    playLabel.textContent = 'Pause';
    play.setAttribute('aria-label', 'Pause explanation');
    play.dataset.playing = 'true';
    timer = setTimeout(tick, 1600);
  });
  next.addEventListener('click', () => {
    stop();
    step = Math.min(step + 1, pr.frames.length - 1);
    render();
    stop();
  });
  required(panel.querySelector('[data-reset]')).addEventListener('click', () => {
    stop();
    step = 0;
    render();
    stop();
  });
  panel.addEventListener('toggle', () => {
    if (!panel.open) stop();
  });
  // Native exclusive details support is not assumed in older browsers.
  required(panel.querySelector('summary')).addEventListener('click', () => {
    if (!panel.open)
      for (const other of document.querySelectorAll<HTMLDetailsElement>('[data-pr]'))
        if (other !== panel) other.open = false;
  });
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) players.forEach((player) => player.stop());
});
reducedMotion.addEventListener('change', () => players.forEach((player) => player.stop()));
const example = document.querySelector('#example');
if (example && 'IntersectionObserver' in window)
  new IntersectionObserver((entries) => {
    if (!entries[0].isIntersecting) players.forEach((player) => player.stop());
  }).observe(example);
