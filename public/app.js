const filmDialog = document.querySelector('#film-dialog');
const photoDialog = document.querySelector('#photo-dialog');
const video = document.querySelector('#proposal-video');
let previousFocus;
function openFilm() {
  previousFocus = document.activeElement;
  filmDialog.showModal();
  video.play().catch(() => {});
}
document.querySelector('#play-film')?.addEventListener('click', openFilm);
document.querySelector('#play-film-poster')?.addEventListener('click', openFilm);
document.querySelectorAll('[data-close]').forEach(button => {
  button.addEventListener('click', () => document.getElementById(button.dataset.close).close());
});
document.querySelectorAll('dialog').forEach(dialog => {
  dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
  dialog.addEventListener('close', () => {
    if (dialog === filmDialog) video.pause();
    previousFocus?.focus();
  });
});
document.querySelectorAll('[data-photo]').forEach(button => {
  button.addEventListener('click', () => {
    previousFocus = button;
    const image = document.querySelector('#enlarged-photo');
    image.src = button.dataset.photo;
    image.alt = button.dataset.alt;
    photoDialog.showModal();
  });
});
// Instagram documents ig.me links for mobile, with the profile as a web fallback.
if (window.matchMedia('(hover: none) and (pointer: coarse)').matches) {
  document.querySelectorAll('[data-instagram]').forEach(link => {
    link.href = 'https://ig.me/m/sidebysouth';
  });
}
