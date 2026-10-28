'use strict';
(() => {
  const keys=['utm_source','utm_medium','utm_campaign','utm_content','campaign_id','adset_id','ad_id'];
  const query=new URLSearchParams(location.search);
  const incoming=Object.fromEntries(keys.filter(key=>query.has(key)).map(key=>[key,query.get(key).slice(0,160)]));
  let attribution=incoming;
  try {
    if(Object.keys(incoming).length){sessionStorage.setItem('sbs_attribution_v1',JSON.stringify(incoming));}
    else {const saved=JSON.parse(sessionStorage.getItem('sbs_attribution_v1')||'{}');attribution=Object.fromEntries(keys.filter(key=>typeof saved[key]==='string').map(key=>[key,saved[key].slice(0,160)]));}
  } catch {}
  window.SBSAttribution=Object.freeze(attribution);
  const form=document.getElementById('inquiry-form');
  if(!form)return;
  const testMode=query.get('sbs_test')==='1';
  const alertTestMode=testMode&&query.get('sbs_alert_test')==='1';
  if(testMode){
    const notice=document.createElement('p');notice.className='small';notice.setAttribute('role','status');
    notice.textContent=alertTestMode?'TEST — cloud alert check. Owner sign-in required. Excluded from campaign numbers.':'TEST inquiry. Owner sign-in required. Excluded from campaign numbers.';
    form.prepend(notice);
  }
  let submissionId=crypto.randomUUID();
  let inquiryReference='';
  const dateInput=form.elements.eventDate;
  const today=new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  dateInput.min=today;
  document.addEventListener('sbs:coveragechange',event=>{form.elements.coverage.value=event.detail.coverage;});
  form.addEventListener('submit',async event=>{
    event.preventDefault();
    if(!form.reportValidity())return;
    const status=document.getElementById('inquiry-status');
    const button=form.querySelector('[type="submit"]');
    if(button.disabled)return;
    const values=new FormData(form);
    let notes=String(values.get('notes')||'').trim();
    if(document.querySelector('.coverage-builder')){
      if(!window.SBSPackages){status.textContent='The package options did not load. Please refresh or message @sidebysouth with your date and preferred coverage.';return;}
      try{notes=window.SBSPackages.composeNotes(notes);}
      catch(error){status.textContent=error.message;form.elements.notes.focus();return;}
    }
    const payload={submissionId,name:String(values.get('name')||'').trim(),instagram:String(values.get('instagram')||'').trim(),eventDate:values.get('eventDate')||null,flexibleDate:!values.get('eventDate'),eventLocation:String(values.get('eventLocation')||'').trim(),coverage:values.get('coverage'),notes,company:String(values.get('company')||''),consent:values.get('consent')==='on',attribution};
    if(testMode)payload.isTest=true;
    if(alertTestMode)payload.alertTest=true;
    button.disabled=true;form.setAttribute('aria-busy','true');status.textContent='Sending your inquiry…';
    try {
      const response=await fetch('/api/inquiries',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
      const result=await response.json();
      if(!response.ok)throw new Error(result.error||'We could not save your inquiry. Please try again or message @sidebysouth.');
      inquiryReference=result.reference;
      document.getElementById('inquiry-reference').textContent=inquiryReference;
      form.hidden=true;
      const success=document.getElementById('inquiry-success');success.hidden=false;success.focus();
      if(testMode){
        success.querySelector('h3').textContent=alertTestMode?'Your test alert is queued.':'Your test inquiry is saved.';
        success.querySelector('p').firstChild.textContent='TEST inquiry saved. Your reference is ';
        success.querySelector('.small').textContent='TEST — excluded from campaign numbers. '+(alertTestMode?'The cloud job will report this test separately.':'This test does not trigger a client inquiry alert.');
      }
      submissionId=crypto.randomUUID();
    } catch(error) {
      status.textContent=error.message||'We could not save your inquiry. Please try again or message @sidebysouth.';
    } finally {button.disabled=false;form.removeAttribute('aria-busy');}
  });
  document.getElementById('copy-reference').addEventListener('click',async()=>{
    const message='Hi Side by South! I sent an inquiry through sidebysouth.com. My reference is '+inquiryReference+'.';
    try {await navigator.clipboard.writeText(message);document.getElementById('reference-status').textContent='Copied. Paste into Instagram to continue.';}
    catch {document.getElementById('reference-status').textContent=message;}
  });
})();
