const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** The review model lives in the title bar's account menu, under Model. Opens that submenu. */
async function openModelMenu() {
  const trigger = [...document.querySelectorAll<HTMLButtonElement>('.workspace-menu-trigger')].find((b) => b.checkVisibility());
  if (!trigger) throw Error('Missing app menu');
  if (trigger.getAttribute('data-state') !== 'open')
    trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerType: 'mouse', button: 0 }));
  for (let i = 0; i < 160; i++) {
    const sub = document.querySelector<HTMLElement>('.workspace-menu-popup [aria-label="Review model"]');
    if (sub && document.querySelector('.workspace-menu-popup [data-model]')) return trigger;
    if (sub && sub.getAttribute('data-state') !== 'open') {
      sub.focus();
      sub.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
    }
    await pause(25);
  }
  throw Error('Model menu did not open');
}
async function closeModelMenu(trigger: HTMLElement) {
  trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerType: 'mouse', button: 0 }));
  for (let i = 0; i < 160 && document.querySelector('.workspace-menu-popup'); i++) await pause(25);
}
async function chooseInModelMenu(selector: string) {
  const trigger = await openModelMenu();
  const item = document.querySelector<HTMLElement>(`.workspace-menu-popup ${selector}`);
  if (!item) throw Error(`Missing model menu item ${selector}`);
  item.click();
  await pause(50);
  await closeModelMenu(trigger);
}

/** Drive the real native select or searchable combobox from browser suites. */
Object.assign(window, {
  openModelMenu,
  closeModelMenu: async () => {
    const trigger = document.querySelector<HTMLElement>('.workspace-menu-trigger[data-state="open"]');
    if (trigger) await closeModelMenu(trigger);
  },
  selectLabels: async (names: string[]) => {
    const trigger = document.querySelector<HTMLButtonElement>('[aria-label="GitHub labels"]');
    if (!trigger) throw Error('Missing label picker');
    trigger.focus();
    trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse', button: 0 }));
    trigger.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    trigger.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
    trigger.click();
    for (const name of names) {
      for (let i = 0; i < 160; i++) {
        const option = [...document.querySelectorAll<HTMLElement>('[data-slot="combobox-item"]')].find(item => item.dataset.value === `label:${name.toLowerCase()}`);
        if (option) { option.click(); await new Promise(resolve => setTimeout(resolve, 25)); break; }
        if (i === 159) throw Error(`Missing label ${name}`);
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }
    document.querySelector<HTMLButtonElement>('.queue-label-footer button')?.click();
    for (let i = 0; i < 160; i++) {
      if (trigger.getAttribute('aria-expanded') === 'false') return;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw Error('Label picker did not close');
  },
  selectEffort: async (label: string, value: string) => {
    if (label === 'Review model' && !document.querySelector('.model-picker-trigger[aria-label="Review model"]'))
      return chooseInModelMenu(`[data-effort="${value}"]`);
    const trigger = [...document.querySelectorAll<HTMLButtonElement>('.model-picker-trigger')].find(el => el.getAttribute('aria-label') === label);
    if (!trigger) throw Error(`Missing model picker: ${label}`);
    if (trigger.getAttribute('aria-expanded') !== 'true') trigger.click();
    const root = trigger.closest('.model-effort-select');
    for (let i = 0; i < 160; i++) {
      const input = root?.querySelector<HTMLInputElement>(`.model-picker-reasoning input[value="${value}"]`);
      if (input) {
        input.click();
        await new Promise(resolve => setTimeout(resolve, 50));
        if (!input.checked) throw Error(`Effort did not commit: ${value}`);
        root?.querySelector<HTMLButtonElement>('.model-picker-footer button')?.click();
        await new Promise(resolve => setTimeout(resolve, 50));
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw Error(`Missing effort: ${value}`);
  },
  selectOption: async (selector: string, value: string) => {
    if (selector === '[aria-label="Review model"]' && !document.querySelector(`.model-picker-trigger${selector}`))
      return chooseInModelMenu(`[data-model="${value}"]`);
    const control = document.querySelector(selector);
    if (control instanceof HTMLButtonElement && control.classList.contains('model-picker-trigger')) {
      if (control.getAttribute('aria-expanded') !== 'true') control.click();
      const root = control.closest('.model-effort-select');
      for (let i = 0; i < 160; i++) {
        const inner = root?.querySelector<HTMLButtonElement>('.model-picker-field .selection-trigger');
        if (inner) {
          await (window as unknown as {selectOption: (s: string, v: string) => Promise<void>}).selectOption(`#${CSS.escape(inner.id)}`, value);
          root?.querySelector<HTMLButtonElement>('.model-picker-footer button')?.click();
          await new Promise(resolve => setTimeout(resolve, 50));
          return;
        }
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      throw Error('Model picker did not open');
    }
    if (control instanceof HTMLSelectElement) {
      control.value = value;
      control.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }
    if (!(control instanceof HTMLButtonElement)) throw Error(`Missing selection: ${selector}`);
    control.focus();
    control.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse', button: 0 }));
    control.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    control.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
    control.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0, detail: 1 }));
    for (let i = 0; i < 160; i++) {
      // A closing popup can remain mounted after Escape. Wait for the reopened
      // combobox to own focus before clicking, rather than selecting its old DOM.
      const popup = document.querySelector<HTMLElement>('[data-slot="combobox-content"][data-open]');
      const ready = control.getAttribute('aria-expanded') === 'true' && popup?.contains(document.activeElement);
      const option = ready && popup && [...popup.querySelectorAll<HTMLElement>('[data-slot="combobox-item"]')].find(
        (item) => item.dataset.value === value
      );
      if (option) {
        option.click();
        for (let j = 0; j < 160; j++) {
          if (!control.isConnected || (control.value === value && control.getAttribute('aria-expanded') === 'false')) return;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        throw Error(`Selection did not commit: ${value}; value=${control.value}; expanded=${control.getAttribute('aria-expanded')}; focus=${document.activeElement?.outerHTML}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw Error(`Missing option ${value} in ${selector}`);
  },
});
