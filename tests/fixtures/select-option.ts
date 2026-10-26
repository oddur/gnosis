/** Drive the real native select or searchable combobox from browser suites. */
Object.assign(window, {
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
      const option = [...document.querySelectorAll<HTMLElement>('[data-slot="combobox-item"]')].find(
        (item) => item.dataset.value === value
      );
      if (option) {
        option.click();
        for (let j = 0; j < 160; j++) {
          if (control.value === value && control.getAttribute('aria-expanded') === 'false') return;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        throw Error(`Selection did not commit: ${value}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw Error(`Missing option ${value} in ${selector}`);
  },
});
