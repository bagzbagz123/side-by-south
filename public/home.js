'use strict';
const filmDialog=document.querySelector('#film-dialog');
const photoDialog=document.querySelector('#photo-dialog');
const film=document.querySelector('#proposal-video');
const ambient=document.querySelector('#ambient-video');
const motionToggle=document.querySelector('#motion-toggle');
const reducedMotion=matchMedia('(prefers-reduced-motion: reduce)');
const dialogs=[filmDialog,photoDialog];
const dialogStates=new Map(dialogs.map(dialog=>[dialog,{version:0,closing:false,opener:null,animation:null}]));
const activeAnimations=new Set();
const revealed=new WeakSet();
const motionEase='cubic-bezier(.22,1,.36,1)';
const revealTargets=Array.from(document.querySelectorAll('[data-reveal], .inquiry-intro')).filter(element=>!element.closest('.hero, .coverage'));
let revealObserver=null;
let motionPaused=reducedMotion.matches;
let manualPause=null;
let ambientInView=false;
let introReady=false;
function motionAllowed(){return !motionPaused&&!reducedMotion.matches;}
function animateSurface(element,keyframes,options){
  if(!motionAllowed()||typeof element.animate!=='function')return null;
  let animation;
  try{animation=element.animate(keyframes,{easing:motionEase,fill:'backwards',...options});}catch{return null;}
  activeAnimations.add(animation);
  animation.finished.then(()=>activeAnimations.delete(animation)).catch(()=>activeAnimations.delete(animation));
  return animation;
}
function updateAmbient(){
  const canPlay=introReady&&!motionPaused&&!document.hidden&&ambientInView&&!dialogs.some(dialog=>dialog.open);
  if(canPlay){ambient.play().catch(()=>{});}else{ambient.pause();}
  motionToggle.textContent=motionPaused?'Play preview':'Pause motion';
  motionToggle.setAttribute('aria-pressed',String(motionPaused));
  document.body.classList.toggle('motion-paused',!motionAllowed());
}
function stopEffects(){
  if(revealObserver)revealObserver.disconnect();
  for(const animation of activeAnimations)animation.cancel();
  activeAnimations.clear();
  for(const dialog of dialogs){
    const state=dialogStates.get(dialog);
    state.version++;
    state.animation=null;
    delete dialog.dataset.motion;
    if(state.closing&&dialog.open)dialog.close();
    state.closing=false;
  }
}
function startReveals(){
  if(!motionAllowed()||!('IntersectionObserver' in window))return;
  if(!revealObserver)revealObserver=new IntersectionObserver(entries=>{
    let stagger=0;
    for(const entry of entries){
      if(!entry.isIntersecting||revealed.has(entry.target))continue;
      if(!motionAllowed())return;
      const element=entry.target;
      const picture=element.matches('figure, .photo-button, .moving-frame');
      revealed.add(element);
      animateSurface(element,[{opacity:picture?.72:.55,transform:'translateY('+(picture?16:10)+'px)'},{opacity:1,transform:'translateY(0)'}],{duration:picture?540:420,delay:Math.min(stagger,120)});
      stagger+=55;
      revealObserver.unobserve(element);
    }
  },{threshold:.12,rootMargin:'0px 0px -18px 0px'});
  for(const element of revealTargets)if(!revealed.has(element))revealObserver.observe(element);
}
function syncMotion(){
  if(motionAllowed())startReveals();else stopEffects();
  updateAmbient();
}
if('IntersectionObserver' in window)new IntersectionObserver(entries=>{ambientInView=entries[0].isIntersecting;updateAmbient();},{threshold:.12}).observe(ambient);
else ambientInView=true;
motionToggle.addEventListener('click',()=>{motionPaused=!motionPaused;manualPause=motionPaused;syncMotion();});
document.addEventListener('visibilitychange',updateAmbient);
reducedMotion.addEventListener('change',event=>{motionPaused=event.matches||manualPause===true;syncMotion();});
function openDialog(dialog,opener){
  const state=dialogStates.get(dialog);
  const wasOpen=dialog.open;
  const current=wasOpen?getComputedStyle(dialog):null;
  const from=current?{opacity:current.opacity,transform:current.transform}:{opacity:0,transform:'translateY(12px) scale(.985)'};
  if(state.animation)state.animation.cancel();
  const version=++state.version;
  state.closing=false;
  state.opener=opener;
  delete dialog.dataset.motion;
  if(!wasOpen)dialog.showModal();
  ambient.pause();
  if(motionAllowed())dialog.dataset.motion='opening';
  state.animation=animateSurface(dialog,[from,{opacity:1,transform:'translateY(0) scale(1)'}],{duration:240});
  if(state.animation)state.animation.finished.then(()=>{if(state.version===version){state.animation=null;delete dialog.dataset.motion;}}).catch(()=>{});
}
function closeDialog(dialog){
  if(!dialog.open)return;
  const state=dialogStates.get(dialog);
  if(state.closing)return;
  const current=getComputedStyle(dialog);
  const from={opacity:current.opacity,transform:current.transform};
  if(state.animation)state.animation.cancel();
  const version=++state.version;
  state.closing=true;
  if(dialog===filmDialog)film.pause();
  if(!motionAllowed()){dialog.close();return;}
  dialog.dataset.motion='closing';
  state.animation=animateSurface(dialog,[from,{opacity:0,transform:'translateY(8px) scale(.99)'}],{duration:160,fill:'forwards'});
  if(!state.animation){dialog.close();return;}
  state.animation.finished.then(()=>{if(state.version===version&&state.closing&&dialog.open)dialog.close();}).catch(()=>{});
}
document.querySelectorAll('[data-play-film]').forEach(button=>button.addEventListener('click',()=>{
  openDialog(filmDialog,button);film.play().catch(()=>{});
}));
document.querySelectorAll('[data-photo]').forEach(button=>button.addEventListener('click',()=>{
  const image=document.querySelector('#enlarged-photo');image.src=button.dataset.photo;image.alt=button.dataset.alt;openDialog(photoDialog,button);
}));
dialogs.forEach(dialog=>{
  dialog.querySelector('[data-close]').addEventListener('click',()=>closeDialog(dialog));
  dialog.addEventListener('cancel',event=>{event.preventDefault();closeDialog(dialog);});
  dialog.addEventListener('click',event=>{if(event.target===dialog){const bounds=dialog.getBoundingClientRect();if(event.clientX<bounds.left||event.clientX>bounds.right||event.clientY<bounds.top||event.clientY>bounds.bottom)closeDialog(dialog);}});
  dialog.addEventListener('close',()=>{
    if(dialog.open)return;
    const state=dialogStates.get(dialog);
    state.version++;
    state.closing=false;
    if(state.animation)state.animation.cancel();
    state.animation=null;
    delete dialog.dataset.motion;
    if(dialog===filmDialog)film.pause();
    updateAmbient();
    if(state.opener?.isConnected)state.opener.focus({preventScroll:true});
  });
});
const packages={both:{name:'photo + film',price:600,message:'photo + film coverage ($600)'},photo:{name:'photography',price:350,message:'photography coverage ($350)'},film:{name:'film',price:400,message:'film coverage ($400)'}};
let selectedPackage='both';
document.querySelectorAll('input[name="coverage"]').forEach(input=>input.addEventListener('change',()=>{
  selectedPackage=input.value;const choice=packages[selectedPackage];document.querySelector('#selection-summary').textContent='Your choice: '+choice.name+', $'+choice.price+'.';document.querySelector('#coverage-cta').setAttribute('aria-label','Check availability for '+choice.name+' for $'+choice.price);document.querySelector('#copy-status').textContent='';document.dispatchEvent(new CustomEvent('sbs:coveragechange',{detail:{coverage:selectedPackage}}));
}));
document.querySelector('#copy-inquiry').addEventListener('click',async()=>{
  const adReference=window.SBSAttribution?.ad_id;const sourceSuffix=adReference?' Ad reference: '+adReference+'.':'';
  const message='Hi Side by South! I’m interested in '+packages[selectedPackage].message+' for a Miami-area proposal. My date or date window is [date], and the location is [location]. Could we discuss availability?'+sourceSuffix;
  try{await navigator.clipboard.writeText(message);document.querySelector('#copy-status').textContent='Copied. Paste into Instagram and add your date and location.';}catch{document.querySelector('#copy-status').textContent=message;}
});
if(matchMedia('(hover: none) and (pointer: coarse)').matches){document.querySelectorAll('[data-instagram]').forEach(link=>{link.href='https://ig.me/m/sidebysouth';});}
const intro=document.querySelector('.hero-intro>p');
const introAnimation=intro?animateSurface(intro,[{opacity:.85},{opacity:1}],{duration:240}):null;
function finishIntro(){introReady=true;updateAmbient();}
if(introAnimation)introAnimation.finished.then(finishIntro,finishIntro);else finishIntro();
syncMotion();
