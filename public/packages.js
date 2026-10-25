'use strict';
(() => {
  const builder=document.querySelector('#coverage.coverage-builder');
  const form=document.querySelector('#inquiry-form');
  if(!builder||!form)return;
  const mediaOptions=Object.freeze({
    photo:{name:'Photography',bundleName:'Photo + decoration',price:350,discount:50},
    film:{name:'Film',bundleName:'Film + decoration',price:400,discount:50},
    both:{name:'Photo + film',bundleName:'Photo + film + decoration',price:600,discount:100}
  });
  const setups=Object.freeze({
    velvet:{name:'Velvet Heart',price:690,image:'assets/yes-miami/03.webp',carpetIncluded:false,inclusions:'7.9-foot silk rose heart, LED sign, 200+ silk roses, 100+ LED candles, music, setup and breakdown.',url:'https://www.yes-miami.com/service-page/velvet-heart-proposal-package'},
    ultimate:{name:'Ultimate Heart Experience',price:890,image:'assets/yes-miami/05.webp',carpetIncluded:false,inclusions:'50 fresh roses, sign, LED candles, aisle flowers, music, setup and breakdown. The exact heart structure and pictured upgrades are confirmed in the quote.',url:'https://www.yes-miami.com/service-page/the-ultimate-heart-experience'},
    grand:{name:'Grand Love Experience',price:1150,image:'assets/yes-miami/06.webp',carpetIncluded:true,inclusions:'Grand silk-rose heart, 3-foot Marry Me letters, LED candles, red or white carpet, music, setup and breakdown. Additional flowers and pictured upgrades are quoted separately.',url:'https://www.yes-miami.com/service-page/the-grand-love-experience'}
  });
  const state={mode:'bundle',coverage:'both',setup:'velvet',carpet:{velvet:true,ultimate:true}};
  const currency=new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:0});
  const money=value=>value===null?'Quote needed':currency.format(value);
  const $=selector=>document.querySelector(selector);
  const setText=(selector,value)=>{const element=$(selector);if(element)element.textContent=value;};
  function calculate(coverage=state.coverage){
    const media=mediaOptions[coverage]||{name:'Coverage to be decided',price:null,discount:0};
    const setup=setups[state.setup];
    const bundled=state.mode==='bundle';
    const carpet=bundled&&!setup.carpetIncluded&&state.carpet[state.setup]?60:0;
    const decoration=bundled?setup.price:0;
    const discount=bundled&&media.price!==null?media.discount:0;
    const mediaFee=media.price===null?null:media.price-discount;
    return {media,setup,bundled,carpet,decoration,discount,mediaFee,total:mediaFee===null?null:mediaFee+decoration+carpet,deposit:mediaFee===null?null:Math.round(mediaFee*.3)};
  }
  function description(quote){
    return quote.bundled?quote.media.name+' with '+quote.setup.name+(quote.carpet||quote.setup.carpetIncluded?' and carpet.':'.'):quote.media.name+' coverage only. Decoration arranged separately.';
  }
  function depositText(quote){
    const decorationTerms=quote.bundled?' Decoration payments are confirmed separately in the setup quote.':' Decoration is not included.';
    return (quote.deposit===null?'Media coverage and its 30% reservation deposit are confirmed in your quote.':'Media reservation deposit: '+money(quote.deposit)+' (30% of the '+money(quote.mediaFee)+' media fee).')+decorationTerms;
  }
  function render(){
    const quote=calculate();
    const {media,setup,bundled,carpet,decoration,discount,total}=quote;
    $('#setup-controls').hidden=!bundled;
    $('#media-only-setting').hidden=bundled;
    setText('#setting-title',bundled?'The setting':'The setting is separate');
    const image=$('#setup-image');
    if(image.getAttribute('src')!==setup.image)image.src=setup.image;
    image.alt=setup.name+' reference setting by Yes Miami. Pictured upgrades are confirmed separately.';
    setText('#setup-name',setup.name);
    setText('#setup-inclusions',setup.inclusions);
    $('#setup-source').href=setup.url;
    const carpetInput=$('#carpet-option');
    carpetInput.disabled=setup.carpetIncluded;
    carpetInput.checked=setup.carpetIncluded||Boolean(state.carpet[state.setup]);
    setText('#carpet-label',setup.carpetIncluded?'Carpet included':'Add carpet +$60');
    setText('#carpet-help',setup.carpetIncluded?'The Grand Love package includes red or white carpet.':'Carpet is an optional addition to this setting.');
    for(const coverage of ['photo','film','both']){
      const row=calculate(coverage);
      setText('[data-title="'+coverage+'"]',bundled?row.media.bundleName:row.media.name);
      setText('[data-price="'+coverage+'"]',money(row.total));
      const saving=$('[data-saving="'+coverage+'"]');
      saving.hidden=!bundled;
      saving.textContent=coverage==='both'?'Save an additional '+money(row.discount)+' when bundled':'Save '+money(row.discount)+' when bundled';
      builder.querySelector('input[name="coverage"][value="'+coverage+'"]').checked=state.coverage===coverage;
    }
    const text=description(quote);
    setText('#summary-description',text);
    setText('#selection-summary','Your choice: '+text);
    setText('#media-line-label',media.name+' coverage');
    setText('#media-line-price',money(media.price));
    $('[data-decoration-line]').hidden=!bundled;
    setText('#decoration-line-label',setup.name+' decoration');
    setText('#decoration-line-price',money(decoration));
    $('[data-carpet-line]').hidden=!bundled||(!carpet&&!setup.carpetIncluded);
    setText('#carpet-line-label',setup.carpetIncluded?'Carpet, included with setting':'Carpet');
    setText('#carpet-line-price',setup.carpetIncluded?'Included':money(carpet));
    $('[data-discount-line]').hidden=!bundled||media.price===null;
    setText('#discount-line-price','-'+money(discount));
    setText('#package-total',money(total));
    const saving=$('#saving-note');
    saving.hidden=media.price===null||(!bundled&&state.coverage!=='both');
    saving.textContent=state.coverage==='both'?(bundled?'The $600 photo + film rate already saves $150 compared with booking each service separately. This bundle adds a further $100 saving.':'The $600 combined rate saves $150 compared with photography at $350 and film at $400.'):'The bundle saving is applied to Side by South coverage. Decoration remains a separately itemized partner service.';
    setText('#media-deposit-note',depositText(quote));
    setText('#inquiry-package-name',text);
    setText('#inquiry-package-price',money(total));
    setText('#inquiry-package-saving',media.price===null?'We will help you choose coverage and confirm the quote.':bundled?'Includes an additional '+money(discount)+' bundle saving.':'Coverage only. Decoration is priced separately.');
    setText('#inquiry-media-deposit',depositText(quote));
    $('#coverage-cta').setAttribute('aria-label','Request availability for '+text+' '+(total===null?'Quote needed.':'Package '+money(total)+' before separately quoted extras.'));
    setText('#copy-status','');
    form.elements.coverage.value=state.coverage;
    document.dispatchEvent(new CustomEvent('sbs:coveragechange',{detail:{coverage:state.coverage}}));
  }
  function composeNotes(userNotes){
    const notes=String(userNotes||'').trim();
    if(notes.length>1200)throw new Error('Please keep optional notes within 1,200 characters. Your package selection is included automatically.');
    const quote=calculate();
    const lines=['Website package request (availability and final quote to confirm):',description(quote)];
    lines.push('Media: '+money(quote.media.price)+(quote.discount?' less '+money(quote.discount)+' bundle saving':'')+'; media fee '+money(quote.mediaFee)+'.');
    if(quote.bundled){
      lines.push('Yes Miami '+quote.setup.name+': '+money(quote.decoration)+'.');
      if(quote.setup.carpetIncluded)lines.push('Carpet included with setting.');
      else lines.push('Carpet: '+(quote.carpet?money(quote.carpet):'not selected')+'.');
    }else lines.push('Decoration not included in this request.');
    lines.push('Package total: '+money(quote.total)+'. Media reservation deposit (30%): '+money(quote.deposit)+'.');
    lines.push('Decoration payments, optional upgrades, taxes and extra fees are confirmed separately.');
    const context=lines.join('\n');
    const combined=context+(notes?'\n\nClient notes:\n'+notes:'');
    if(combined.length>2000)throw new Error('Please shorten your optional notes so the package details and message fit within 2,000 characters.');
    return combined;
  }
  builder.querySelectorAll('input[name="package-mode"]').forEach(input=>input.addEventListener('change',()=>{state.mode=input.value;render();}));
  builder.querySelectorAll('input[name="coverage"]').forEach(input=>input.addEventListener('change',()=>{state.coverage=input.value;render();}));
  $('#setup-select').addEventListener('change',event=>{if(setups[event.target.value]){state.setup=event.target.value;render();}});
  $('#carpet-option').addEventListener('change',event=>{state.carpet[state.setup]=event.target.checked;render();});
  form.elements.coverage.addEventListener('change',event=>{if(['photo','film','both','unsure'].includes(event.target.value)){state.coverage=event.target.value;render();}});
  $('#copy-inquiry').addEventListener('click',async()=>{
    const quote=calculate();
    const adReference=window.SBSAttribution?.ad_id;
    const sourceSuffix=adReference?' Ad reference: '+adReference+'.':'';
    const message='Hi Side by South! I’m interested in '+description(quote)+' '+(quote.total===null?'Please help me choose coverage.':'Website package estimate: '+money(quote.total)+', before separately quoted extras.')+' My date or date window is [date], and the location is [location]. Could we discuss availability?'+sourceSuffix;
    try{await navigator.clipboard.writeText(message);setText('#copy-status','Copied. Paste into Instagram and add your date and location.');}
    catch{setText('#copy-status',message);}
  });
  window.SBSPackages=Object.freeze({composeNotes});
  render();
})();
