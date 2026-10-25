const catalogGrid=document.querySelector('.catalog-grid');
const packageSearch=document.querySelector('#package-search');
const packageSort=document.querySelector('#package-sort');
const packageCards=[...document.querySelectorAll('.decor-card')];
function updateCatalog(){
  const query=packageSearch.value.trim().toLowerCase();
  let visible=0;
  packageCards.forEach(card=>{card.hidden=!card.dataset.name.includes(query);if(!card.hidden)visible++;});
  const arranged=[...packageCards].sort((a,b)=>{
    if(packageSort.value==='low')return Number(a.dataset.price)-Number(b.dataset.price);
    if(packageSort.value==='high')return Number(b.dataset.price)-Number(a.dataset.price);
    if(packageSort.value==='name')return a.dataset.name.localeCompare(b.dataset.name);
    return Number(a.dataset.order)-Number(b.dataset.order);
  });
  arranged.forEach(card=>catalogGrid.appendChild(card));
  document.querySelector('#package-count').textContent=`${visible} ${visible===1?'setup':'setups'}`;
  document.querySelector('.empty-catalog').hidden=visible!==0;
}
packageSearch.addEventListener('input',updateCatalog);
packageSort.addEventListener('change',updateCatalog);
