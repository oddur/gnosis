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
  </style></head><body><div id="drawing"></div><script nonce="${token}">const config=${config};${EXPLAINER_MOTION_RUNTIME}${SVG_PLAYER_RUNTIME}</script></body></html>`;
}
const SVG_PLAYER_RUNTIME = String.raw`
(()=>{
  const root=document.getElementById('drawing');
  const notify=(event,extra={})=>parent.postMessage({type:'gnosis-illustration',token:config.token,event,...extra},'*');
  const allowed=new Set('svg g path rect circle ellipse line polyline polygon text tspan defs marker clippath lineargradient radialgradient stop title desc'.split(' '));
  const attrs=new Set('xmlns id viewbox preserveaspectratio transform x y x1 y1 x2 y2 cx cy r rx ry width height d points fill fill-opacity fill-rule stroke stroke-width stroke-opacity stroke-linecap stroke-linejoin stroke-dasharray stroke-dashoffset opacity font-size font-weight text-anchor dominant-baseline alignment-baseline dx dy marker-end marker-start marker-mid markerwidth markerheight markerunits refx refy orient clippathunits clip-path gradientunits gradienttransform offset stop-color stop-opacity data-motion-id role aria-label aria-hidden vector-effect'.split(' '));
  let extent;
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
    return issues.slice(0,15);
  }
  function draw(s,i,animate){
    if(!Number.isInteger(s)||!Number.isInteger(i)||!frames[s]?.[i])throw Error('Invalid illustration frame');
    scenario=s;index=i;
    motion.update(()=>root.replaceChildren(document.importNode(frames[s][i],true)),animate);
    notify('frame',{scenario,index});
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
        if(d.command==='validate'){
          const issues=[];
          for(let s=0;s<frames.length;s++)for(let i=0;i<frames[s].length;i++){
            draw(s,i,false);await document.fonts.ready;
            issues.push(...geometry().map(message=>'Scenario '+(s+1)+', frame '+(i+1)+': '+message));
          }
          draw(0,0,false);notify('validated',{issues:issues.slice(0,30)});
        }
      }catch(error){notify('error',{message:String(error.message).slice(0,700)});}
    });
    addEventListener('pagehide',()=>motion.pause());
    addEventListener('resize',()=>motion.sync());
    document.fonts.ready.then(()=>notify('ready',{width:extent[2],height:extent[3]}));
  }catch(error){notify('error',{message:String(error.message).slice(0,700)});}
})();`;
