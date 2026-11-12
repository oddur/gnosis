/**
 * Browser-check snippets for the app menu, which holds GitHub account, Settings, model and Help.
 * `openWorkspaceMenu` opens the visible menu; `chooseWorkspaceMenuItem` also selects an item by
 * CSS selector, for example `[aria-label="Settings"]` or `[data-github-account]`.
 */
export const openWorkspaceMenu = `(async()=>{
  const trigger=[...document.querySelectorAll('.workspace-menu-trigger')].find(b=>b.checkVisibility());
  if(!trigger) throw new Error('No visible app menu');
  if(trigger.getAttribute('data-state')!=='open') trigger.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,cancelable:true,button:0,pointerType:'mouse'}));
  for(let i=0;i<80&&!document.querySelector('.workspace-menu-popup');i++) await new Promise(r=>setTimeout(r,25));
  if(!document.querySelector('.workspace-menu-popup')) throw new Error('App menu did not open');
})()`;

export const chooseWorkspaceMenuItem = (selector: string) => `(async()=>{
  await ${openWorkspaceMenu};
  const item=document.querySelector('.workspace-menu-popup').querySelector(${JSON.stringify(selector)});
  if(!item) throw new Error('No app menu item ' + ${JSON.stringify(selector)});
  item.click();
  // Items act once the menu has closed; Help then opens its panel beside the avatar.
  for(let i=0;i<80&&document.querySelector('.workspace-menu-popup');i++) await new Promise(r=>setTimeout(r,25));
  if(${JSON.stringify(selector)}.includes('Help and terminology'))
    for(let i=0;i<80&&!document.querySelector('.workbench-help');i++) await new Promise(r=>setTimeout(r,25));
})()`;

/** The visible app menu button, whose name includes the connected GitHub account. */
export const workspaceMenuTrigger = `[...document.querySelectorAll('.workspace-menu-trigger')].find(b=>b.checkVisibility())`;
