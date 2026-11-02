const tour = document.querySelector<HTMLElement>('[data-feature-tour]');
if (tour) {
  const tabs = Array.from(tour.querySelectorAll<HTMLAnchorElement>('[data-feature-tab]'));
  const panels = Array.from(tour.querySelectorAll<HTMLElement>('[data-feature-panel]'));
  const select = (index: number, focus = false) => {
    tabs.forEach((tab, i) => {
      tab.setAttribute('aria-selected', String(index === i));
      tab.tabIndex = index === i ? 0 : -1;
      panels[i].hidden = index !== i;
    });
    if (focus) tabs[index].focus();
  };
  tour.querySelector('.feature-tabs')?.setAttribute('role', 'tablist');
  tabs.forEach((tab, index) => {
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-controls', panels[index].id);
    panels[index].setAttribute('role', 'tabpanel');
    panels[index].setAttribute('aria-labelledby', tab.id);
    panels[index].tabIndex = 0;
    tab.addEventListener('click', (event) => {
      // Keep normal browser behavior for opening a feature link in a new tab.
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      select(index);
    });
    tab.addEventListener('keydown', (event) => {
      const next =
        event.key === 'ArrowRight'
          ? (index + 1) % tabs.length
          : event.key === 'ArrowLeft'
            ? (index - 1 + tabs.length) % tabs.length
            : event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? tabs.length - 1
                : null;
      if (next !== null) {
        event.preventDefault();
        select(next, true);
      } else if (event.key === ' ') {
        event.preventDefault();
        select(index);
      }
    });
  });
  const selectHash = () => {
    const index = panels.findIndex((panel) => `#${panel.id}` === location.hash);
    if (index >= 0) select(index);
    return index;
  };
  if (selectHash() < 0) select(0);
  window.addEventListener('hashchange', selectHash);
  tour.dataset.enhanced = 'true';
}
