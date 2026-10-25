'use strict';
const filmDialog=document.querySelector('#film-dialog');
const photoDialog=document.querySelector('#photo-dialog');
const film=document.querySelector('#proposal-video');
const dialogs=[filmDialog,photoDialog];
const dialogOpeners=new Map();
function openDialog(dialog,opener){
  dialogOpeners.set(dialog,opener);
  if(!dialog.open)dialog.showModal();
}
function closeDialog(dialog){
  if(dialog===filmDialog)film.pause();
  if(dialog.open)dialog.close();
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
    if(dialog===filmDialog)film.pause();
    const opener=dialogOpeners.get(dialog);
    if(opener?.isConnected)opener.focus({preventScroll:true});
  });
});
if(matchMedia('(hover: none) and (pointer: coarse)').matches){document.querySelectorAll('[data-instagram]').forEach(link=>{link.href='https://ig.me/m/sidebysouth';});}
