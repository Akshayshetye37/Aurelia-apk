/* Aurelia reference navigation adoption.
 * Maps every desktop destination to the existing PMS router/subview state.
 * Does not create or modify business records, payment state or persistence. */
(function(){
  'use strict';
  const navRoot=document.getElementById('aurelia-design-nav');
  if(!navRoot||navRoot.dataset.referenceAdoption==='ready')return;
  navRoot.dataset.referenceAdoption='ready';

  const groups=[
    {label:'Front Desk',items:[
      ['home','Overview','M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z'],
      ['rooms','Chambers','M3 19V6M3 14h18v5M21 14v-2a3 3 0 0 0-3-3h-7v5M7 11h.01'],
      ['stays','Stays & Planner','M4 6h16v14H4zM4 10h16M8 3v4M16 3v4'],
      ['dining','Dining POS','M7 3v7M5 3v4a2 2 0 0 0 4 0V3M7 10v11M17 21V3c-2 1-3 4-3 7s1 4 3 4'],
      ['upi','Aurelia UPI','M3 5h18v14H3zM3 10h18M7 15h.01M11 15h.01M15 15h.01']
    ]},
    {label:'Operations',items:[
      ['guests','Guests','M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8'],
      ['hk','Housekeeping','M3 19V6M3 14h18v5M6 11h12a3 3 0 0 1 3 3'],
      ['inv','Inventory','M4 7 12 3l8 4-8 4-8-4Zm0 0v10l8 4 8-4V7M12 11v10'],
      ['exp','Expenses','M12 2v20M17 6H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6']
    ]},
    {label:'Governance',items:[
      ['rep','Finance & Reports','M4 19V5m0 14h16M8 15l3-4 3 2 5-7'],
      ['aud','Audit Log','M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01'],
      ['io','Data & Backup','M12 3v12m0-12 4 4m-4-4-4 4M4 15v5h16v-5'],
      ['set','Settings','M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm0-6v2m0 16v2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M2 12h2m16 0h2']
    ]}
  ];
  const primary=new Set(['home','rooms','stays','dining','upi']);
  const icon=(path)=>'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="'+path+'"/></svg>';
  function badge(key){
    try{
      if(key==='hk'){const n=(S.rooms||[]).filter(x=>x.s==='clean').length;return n?'<span class="aurelia-nav-badge alert">'+n+'</span>':''}
      if(key==='inv'){const n=(S.inv||[]).filter(x=>Number(x.q)<=Number(x.ro)).length;return n?'<span class="aurelia-nav-badge alert">'+n+'</span>':''}
      if(key==='upi'){const n=(S.sig||[]).filter(x=>x.st!=='matched').length;return n?'<span class="aurelia-nav-badge">'+n+'</span>':''}
      if(key==='stays'){const n=(S.b||[]).filter(x=>x.st==='res').length;return n?'<span class="aurelia-nav-badge">'+n+'</span>':''}
    }catch(_){}
    return '';
  }
  function active(key){
    return primary.has(key)?S.tab===key:(S.tab==='more'&&S.sub===key);
  }
  function sync(){
    if(typeof S!=='object')return;
    const property=document.getElementById('aurelia-design-property');
    if(property)property.textContent=String(S.set&&S.set.name||'Aurelia PMS');
    const title=document.getElementById('aurelia-design-page-title');
    const activeItem=groups.flatMap(g=>g.items).find(x=>active(x[0]));
    if(title)title.textContent=activeItem?activeItem[1]:(S.tab==='more'?'Operations Vault':'Overview');
    navRoot.innerHTML=groups.map(group=>'<section class="aurelia-design-nav-group" aria-label="'+group.label+'"><div class="aurelia-design-nav-label">'+group.label+'</div>'+group.items.map(([key,label,path])=>'<button type="button" data-aurelia-nav="'+key+'" class="'+(active(key)?'active':'')+'" aria-current="'+(active(key)?'page':'false')+'" aria-label="'+label+'">'+icon(path)+'<span>'+label+'</span>'+badge(key)+'</button>').join('')+'</section>').join('');
  }
  navRoot.addEventListener('click',function(event){
    const button=event.target.closest('button[data-aurelia-nav]');
    if(!button)return;
    const key=button.dataset.aureliaNav;
    if(primary.has(key)){if(typeof go==='function')go(key);return}
    if(typeof SUB==='object'&&typeof SUB[key]==='function'&&typeof render==='function'){
      S.tab='more';S.sub=key;render();
    }
  });
  const newButton=document.getElementById('aurelia-design-new');
  if(newButton)newButton.addEventListener('click',function(){if(typeof resv==='function')resv()});
  const previousRender=window.render;
  if(typeof previousRender==='function'&&!previousRender.__aureliaGroupedNavigation){
    const wrapped=function(){const result=previousRender.apply(this,arguments);sync();return result};
    wrapped.__aureliaGroupedNavigation=true;
    window.render=wrapped;
  }
  sync();
})();
