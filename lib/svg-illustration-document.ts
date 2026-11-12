import type { SvgIllustration } from './svg-illustration';
import { EXPLAINER_MOTION_RUNTIME } from './explainer-motion';

/** Only our playback code executes. Model-authored SVG stays inside an opaque-origin iframe. */
export function buildSvgIllustrationDocument(
  illustration: SvgIllustration,
  token: string,
  theme: 'light' | 'dark' = 'light'
) {
  if (!/^[\w-]+$/.test(token)) throw new Error('Invalid illustration token');
  const config = JSON.stringify({ illustration, token, theme }).replace(/</g, '\\u003c');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${token}'; style-src 'unsafe-inline'; img-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"><style>
  :root{color-scheme:light;--paper:#fcfcfd;--ink:#242a35;--muted:#626b7b;--line:#7a8596;--accent:#345fc1;--success:#33764a;--warning:#95600c;--danger:#b33f3f}
  :root.dark{color-scheme:dark;--paper:#171a20;--ink:#e3e7ef;--muted:#a2adbf;--line:#69788f;--accent:#a6bfff;--success:#83c59c;--warning:#e9ba6e;--danger:#ef9b9b}
  *{box-sizing:border-box}html,body,#drawing{margin:0;width:100%;height:100%;overflow:hidden;background:var(--paper)}svg{display:block;width:100%;height:100%;font-family:system-ui,sans-serif}text:not([fill]){fill:var(--ink)}
  [data-entity-id],[data-relationship-id]{cursor:pointer;transition:opacity 120ms ease-out}
  .diagram-quiet text{fill:var(--muted)} .diagram-focused[data-relationship-id] [stroke]:not([stroke='none']){stroke:var(--accent)} .diagram-focused[data-relationship-id] text{fill:var(--accent)} [data-entity-id]:focus-visible,[data-relationship-id]:focus-visible{outline:2px solid var(--accent);outline-offset:4px}
  @media(prefers-reduced-motion:reduce){[data-entity-id],[data-relationship-id]{transition:none}}
  </style></head><body><div id="drawing"></div><script nonce="${token}">const config=${config};${EXPLAINER_MOTION_RUNTIME}${SVG_PLAYER_RUNTIME}</script></body></html>`;
}
const SVG_PLAYER_RUNTIME = String.raw`
(()=>{
  const root=document.getElementById('drawing');
  const notify=(event,extra={})=>parent.postMessage({type:'gnosis-illustration',token:config.token,event,...extra},'*');
  const allowed=new Set('svg g path rect circle ellipse line polyline polygon text tspan defs marker clippath lineargradient radialgradient stop title desc'.split(' '));
  const attrs=new Set('xmlns id viewbox preserveaspectratio transform x y x1 y1 x2 y2 cx cy r rx ry width height d points fill fill-opacity fill-rule stroke stroke-width stroke-opacity stroke-linecap stroke-linejoin stroke-dasharray stroke-dashoffset opacity font-size font-weight text-anchor dominant-baseline alignment-baseline dx dy marker-end marker-start marker-mid markerwidth markerheight markerunits refx refy orient clippathunits clip-path gradientunits gradienttransform offset stop-color stop-opacity data-motion-id data-entity-id data-relationship-id role aria-label aria-hidden vector-effect'.split(' '));
  let extent;
  const exploration=config.illustration.exploration;
  const entities=exploration?.entities||[], relationships=exploration?.relationships||[];
  const semanticIds=new Set([...entities,...relationships].map(e=>e.id));
  let focusIds=[];
  function bounds(){
    const svg=root.querySelector('svg');if(!svg)return [];
    return [...svg.querySelectorAll('[data-entity-id]')].map(el=>{
      const b=el.getBBox(),matrix=el.getCTM(),inverse=svg.getCTM().inverse();
      const transform=inverse.multiply(matrix);
      const corners=[[b.x,b.y],[b.x+b.width,b.y],[b.x,b.y+b.height],[b.x+b.width,b.y+b.height]].map(([x,y])=>new DOMPoint(x,y).matrixTransform(transform));
      const x=Math.min(...corners.map(p=>p.x)),y=Math.min(...corners.map(p=>p.y));
      return {id:el.getAttribute('data-entity-id'),x,y,width:Math.max(...corners.map(p=>p.x))-x,height:Math.max(...corners.map(p=>p.y))-y};
    });
  }
  function focus(){
    for(const el of root.querySelectorAll('[data-entity-id],[data-relationship-id]')){
      const id=el.getAttribute('data-entity-id')||el.getAttribute('data-relationship-id');
      el.classList.toggle('diagram-quiet',focusIds.length>0&&!focusIds.includes(id));
      el.classList.toggle('diagram-focused',focusIds.includes(id));
    }
  }
  function select(event){
    const group=event.target.closest?.('[data-entity-id],[data-relationship-id]');
    if(!group)return;
    const id=group.getAttribute('data-entity-id')||group.getAttribute('data-relationship-id');
    if(semanticIds.has(id))notify('select',{id});
  }
  root.addEventListener('click',select);
  root.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();select(event);}});
  function parse(source){
    const doc=new DOMParser().parseFromString(source,'image/svg+xml');
    if(doc.querySelector('parsererror') || doc.documentElement.localName!=='svg')throw Error('Invalid SVG XML');
    const svg=doc.documentElement;
    const box=(svg.getAttribute('viewBox')||'').trim().split(/[\s,]+/).map(Number);
    if(box.length!==4 || box.some(n=>!Number.isFinite(n)) || box[0]!==0 || box[1]!==0 || box[2]<300 || box[2]>900 || box[3]<140 || box[3]>600)throw Error('Use viewBox="0 0 width height", width 300–900, height 140–600');
    if(extent && JSON.stringify(box)!==JSON.stringify(extent))throw Error('All scenarios and frames must use the same viewBox');
    extent=box;
    const ids=new Set(),motionIDs=new Set();let count=0;
    for(const el of [svg,...svg.querySelectorAll('*')]){
      if(++count>1000)throw Error('Keep each frame below 1,000 SVG elements');
      if(el.namespaceURI!=='http://www.w3.org/2000/svg'||!allowed.has(el.localName.toLowerCase()))throw Error('Unsupported SVG element: '+el.localName);
      for(const a of [...el.attributes]){
        const name=a.name.toLowerCase();
        if(!attrs.has(name))throw Error('Unsupported SVG attribute: '+a.name);
        if(/url\s*\(/i.test(a.value) && !/^url\(#[\w-]+\)$/.test(a.value))throw Error('Only local SVG references are supported');
      }
      const id=el.getAttribute('id');if(id){if(ids.has(id))throw Error('Duplicate SVG id: '+id);ids.add(id);}
      const key=el.getAttribute('data-motion-id');if(key){if(motionIDs.has(key)||el.parentElement?.closest('[data-motion-id]'))throw Error('Motion IDs must be unique and not nested');motionIDs.add(key);}
    }
    if(exploration){
      for(const [items,attribute] of [[entities,'data-entity-id'],[relationships,'data-relationship-id']]){
        for(const item of items){
          const matches=[...svg.querySelectorAll('['+attribute+']')].filter(el=>el.getAttribute(attribute)===item.id);
          if(matches.length!==1)throw Error('Each frame must contain exactly one '+attribute+'="'+item.id+'" group');
          const el=matches[0];
          if(el.localName!=='g'||el.parentElement?.closest('[data-entity-id],[data-relationship-id]'))throw Error('Selectable groups must be g elements and cannot nest');
          el.setAttribute('tabindex','0');el.setAttribute('role','button');el.setAttribute('aria-label',item.label);
        }
      }
      for(const el of svg.querySelectorAll('[data-entity-id],[data-relationship-id]')){
        if(!semanticIds.has(el.getAttribute('data-entity-id')||el.getAttribute('data-relationship-id')))throw Error('Undeclared diagram identity');
      }
    }
    svg.setAttribute('preserveAspectRatio','xMidYMid meet');
    return svg;
  }
  let frames, motion, scenario=0,index=0;
  const preference=matchMedia('(prefers-reduced-motion: reduce)');
  function geometry(){
    const svg=root.querySelector('svg');if(!svg)return ['No SVG'];
    const issues=[]; const box=svg.viewBox.baseVal;
    const texts=[...svg.querySelectorAll('text')].filter(el=>!el.closest('defs'));
    for(const text of texts){
      if(!text.textContent.trim())continue;
      const b=text.getBoundingClientRect(),screen=svg.getBoundingClientRect();
      if(b.left<screen.left-1 || b.top<screen.top-1 || b.right>screen.right+1 || b.bottom>screen.bottom+1)issues.push('Text outside canvas: '+text.textContent.slice(0,70));
      const matrix=text.getScreenCTM();const size=parseFloat(getComputedStyle(text).fontSize)*Math.hypot(matrix.a,matrix.b);
      if(size<11.5)issues.push('Text too small at pane size ('+size.toFixed(1)+'px): '+text.textContent.slice(0,60));
    }
    for(let a=0;a<texts.length;a++)for(let b=a+1;b<texts.length;b++){
      const x=texts[a].getBoundingClientRect(),y=texts[b].getBoundingClientRect();
      if(Math.min(x.right,y.right)-Math.max(x.left,y.left)>3 && Math.min(x.bottom,y.bottom)-Math.max(x.top,y.top)>3)issues.push('Overlapping labels: '+texts[a].textContent.slice(0,35)+' / '+texts[b].textContent.slice(0,35));
    }
    for(const b of bounds()){
      if(![b.x,b.y,b.width,b.height].every(Number.isFinite)||b.width<=0||b.height<=0||b.x<0||b.y<0||b.x+b.width>box.width+1||b.y+b.height>box.height+1)issues.push('Selectable entity outside canvas or empty: '+b.id);
    }
    return issues.slice(0,15);
  }
  function draw(s,i,animate){
    if(!Number.isInteger(s)||!Number.isInteger(i)||!frames[s]?.[i])throw Error('Invalid illustration frame');
    scenario=s;index=i;
    motion.update(()=>root.replaceChildren(document.importNode(frames[s][i],true)),animate);
    focus();notify('frame',{scenario,index,bounds:bounds()});
  }
  function theme(dark){document.documentElement.classList.toggle('dark',dark);}
  try{
    frames=config.illustration.scenarios.map(s=>s.frames.map(f=>parse(f.svg)));
    theme(config.theme==='dark');
    root.append(document.importNode(frames[0][0],true));
    motion=createExplainerMotion(root,preference);motion.sync();
    addEventListener('message',async event=>{
      if(event.source!==parent || event.data?.type!=='gnosis-illustration-control' || event.data.token!==config.token)return;
      const d=event.data;
      try{
        if(d.command==='show')draw(d.scenario,d.index,d.animate===true);
        if(d.command==='capture'){
          draw(d.scenario,Math.max(0,d.index-1),false);
          draw(d.scenario,d.index,d.transition===true);
          // Deterministic transition samples use the same Web Animations as playback.
          for(const animation of root.getAnimations({subtree:true})){
            animation.pause();animation.currentTime=Number(animation.effect.getTiming().duration)*0.5;
          }
          await document.fonts.ready;
          await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
          notify('captured');
        }
        if(d.command==='pause')motion.pause();
        if(d.command==='resume')motion.resume();
        if(d.command==='theme')theme(d.dark===true);
        if(d.command==='focus'){focusIds=Array.isArray(d.ids)?d.ids.filter(id=>semanticIds.has(id)):[];focus();}
        if(d.command==='validate'){
          // Let the parent's aspect-ratio resize reach this frame before measuring label size.
          await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
          const issues=[],positions=new Map();
          for(let s=0;s<frames.length;s++)for(let i=0;i<frames[s].length;i++){
            draw(s,i,false);await document.fonts.ready;
            issues.push(...geometry().map(message=>'Scenario '+(s+1)+', frame '+(i+1)+': '+message));
            for(const b of bounds()){
              const previous=positions.get(b.id);
              if(previous && ['x','y','width','height'].some(key=>Math.abs(b[key]-previous[key])>1))issues.push('Keep participant geometry stable across frames: '+b.id);
              else positions.set(b.id,b);
            }
          }
          draw(0,0,false);notify('validated',{issues:issues.slice(0,30)});
        }
      }catch(error){notify('error',{message:String(error.message).slice(0,700)});}
    });
    addEventListener('pagehide',()=>motion.pause());
    let resizeTimer=0;
    addEventListener('resize',()=>{clearTimeout(resizeTimer);resizeTimer=setTimeout(()=>motion.sync(),120);});
    document.fonts.ready.then(()=>notify('ready',{width:extent[2],height:extent[3],bounds:bounds()}));
  }catch(error){notify('error',{message:String(error.message).slice(0,700)});}
})();`;
