/** Runs inside the opaque-origin explainer frame; no app or network access. */
export const EXPLAINER_MOTION_RUNTIME = String.raw`
function createExplainerMotion(root, preference) {
  const active = new Set();
  const observer = new MutationObserver(() => {});
  observer.observe(root, {subtree: true, attributes: true, childList: true, characterData: true});
  let previous;
  const finish = () => {
    for (const entry of [...active]) entry.animation.finish();
  };
  function capture() {
    const scenes = new Map();
    [...root.querySelectorAll('svg')].filter(svg => !svg.ownerSVGElement).forEach((svg, index) => {
      const items = new Map();
      for (const node of [...svg.querySelectorAll('[data-motion-id]')].slice(0, 80)) {
        if (node.parentElement.closest('[data-motion-id]')) continue;
        const key = node.getAttribute('data-motion-id');
        const parentMatrix = node.parentElement.getScreenCTM?.();
        if (!key || items.has(key) || !parentMatrix) continue;
        const style = getComputedStyle(node);
        items.set(key, {
          node, rect: node.getBoundingClientRect(), parentMatrix,
          transform: style.transform === 'none' ? new DOMMatrix() : new DOMMatrix(style.transform),
          opacity: style.opacity, markup: node.outerHTML, clone: node.cloneNode(true)
        });
      }
      scenes.set(svg.id || String(index), {node: svg, markup: svg.innerHTML, items});
    });
    return scenes;
  }
  function animate(node, frames, duration = 420, cleanup = () => {}) {
    const animation = node.animate(frames, {duration, easing: 'cubic-bezier(0.25, 1, 0.5, 1)'});
    const entry = {animation, cleanup};
    active.add(entry);
    const done = () => { active.delete(entry); cleanup(); };
    animation.onfinish = done;
    animation.oncancel = done;
  }
  function sync() {
    finish();
    // finish events are asynchronous, but snapshots must never include ghosts.
    for (const entry of [...active]) { entry.cleanup(); active.delete(entry); }
    previous = capture();
    observer.takeRecords();
  }
  function update(change, enabled = true) {
    observer.takeRecords();
    change();
    const changed = observer.takeRecords().some(record => {
      const element = record.target.nodeType === 1 ? record.target : record.target.parentElement;
      return element?.closest('svg');
    });
    if (!changed) return;
    const before = previous;
    sync();
    if (!enabled || preference.matches || !before) return;
    for (const [sceneKey, scene] of previous) {
      const oldScene = before.get(sceneKey);
      if (!oldScene || scene.markup === oldScene.markup) continue;
      // Older saved artifacts have no semantic keys. Fade their change gently
      // rather than inventing an identity or movement between unrelated items.
      if (!scene.items.size && !oldScene.items.size) {
        animate(scene.node, [{opacity: 0.55}, {opacity: getComputedStyle(scene.node).opacity}], 220);
        continue;
      }
      for (const [key, item] of scene.items) {
        const old = oldScene.items.get(key);
        if (old && old.markup === item.markup && Math.abs(old.rect.x - item.rect.x) < 0.5 && Math.abs(old.rect.y - item.rect.y) < 0.5) continue;
        const inverse = item.parentMatrix.inverse();
        const dx = old ? old.rect.x - item.rect.x : 0;
        const dy = old ? old.rect.y - item.rect.y : 8;
        const from = DOMMatrix.fromMatrix(item.transform);
        from.e += inverse.a * dx + inverse.c * dy;
        from.f += inverse.b * dx + inverse.d * dy;
        animate(item.node, [
          {transform: from.toString(), opacity: old ? item.opacity : 0},
          {transform: item.transform.toString(), opacity: item.opacity}
        ]);
        // A changed value/highlight with no movement still gets a brief cue.
        if (old && Math.abs(dx) + Math.abs(dy) < 0.5) {
          animate(item.node, [{opacity: 0.45}, {opacity: item.opacity}], 220);
        }
      }
      for (const [key, old] of oldScene.items) {
        if (scene.items.has(key)) continue;
        const matrix = scene.node.getScreenCTM();
        if (!matrix) continue;
        const ghost = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        ghost.setAttribute('transform', matrix.inverse().multiply(old.parentMatrix).toString());
        ghost.setAttribute('aria-hidden', 'true');
        ghost.setAttribute('pointer-events', 'none');
        for (const node of [old.clone, ...old.clone.querySelectorAll('*')]) {
          node.removeAttribute('id'); node.removeAttribute('data-motion-id');
        }
        ghost.append(old.clone);
        scene.node.append(ghost);
        animate(ghost, [{opacity: 1}, {opacity: 0}], 250, () => ghost.remove());
      }
    }
    observer.takeRecords();
  }
  preference.addEventListener('change', () => { if (preference.matches) sync(); });
  return {
    sync, update,
    pause: () => { for (const entry of active) entry.animation.pause(); },
    resume: () => { for (const entry of active) entry.animation.play(); }
  };
}
`;
