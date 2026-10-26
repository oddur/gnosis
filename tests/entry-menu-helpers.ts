export async function menuAction(js: <T = unknown>(code: string) => Promise<T>, label: string, action: string) {
  await js(
    `(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.getBoundingClientRect().width&&b.getAttribute('aria-label')===${JSON.stringify(label)});if(!b)throw Error('Missing menu '+${JSON.stringify(label)});b.focus();b.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}))})()`
  );
  for (let i = 0; i < 100; i++) {
    if (
      await js(`!![...document.querySelectorAll('[role=menuitem]')].find(b=>b.textContent===${JSON.stringify(action)})`)
    )
      break;
    await new Promise((r) => setTimeout(r, 30));
  }
  await js(
    `(()=>{const item=[...document.querySelectorAll('[role=menuitem]')].find(b=>b.textContent===${JSON.stringify(action)});if(!item)throw Error('Missing action '+${JSON.stringify(action)});item.click()})()`
  );
  await new Promise((r) => setTimeout(r, 100));
}
