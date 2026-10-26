/** Drive the real native select or searchable combobox from browser suites. */
Object.assign(window, {
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
  selectOption: async (selector: string, value: string) => {
    const control = document.querySelector(selector);
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
