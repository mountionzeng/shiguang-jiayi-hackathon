import test from 'node:test';
import assert from 'node:assert/strict';

test('scanning previews the browser but never confirms login automatically',async()=>{
  let definition: Record<string, any> = {};
  const previous=Object.getOwnPropertyDescriptor(globalThis,'Page');
  Object.defineProperty(globalThis,'Page',{configurable:true,value:(page:Record<string,any>)=>{definition=page;}});
  try{await import('../miniprogram/packages/web-login/pages/confirm/index');}
  finally{if(previous)Object.defineProperty(globalThis,'Page',previous);else Reflect.deleteProperty(globalThis,'Page');}
  let previews=0;
  const page={...definition,data:{...definition.data},setData(update:Record<string,unknown>){Object.assign(this.data,update);},lookup(){previews++;},decide(){throw new Error('must require a tap');}};
  definition.onLoad.call(page,{scene:'wl_'+'A'.repeat(28)});
  assert.equal(previews,1);assert.equal(page.data.code,'A'.repeat(28));assert.equal(page.data.fromQr,true);
  definition.readScene.call(page,'wl_'+'A'.repeat(28));
  assert.equal(previews,1, 'onLoad and onShow must not preview twice');
  page.setData({step:'done',busy:true,resultText:'old result'});
  const previousWx=Object.getOwnPropertyDescriptor(globalThis,'wx');
  Object.defineProperty(globalThis,'wx',{configurable:true,value:{getEnterOptionsSync:()=>({path:'packages/web-login/pages/confirm/index',query:{scene:'wl_'+'B'.repeat(28)}})}});
  try { definition.onShow.call(page); }
  finally { if(previousWx)Object.defineProperty(globalThis,'wx',previousWx);else Reflect.deleteProperty(globalThis,'wx'); }
  assert.equal(previews,2);
  assert.equal(page.data.code,'B'.repeat(28));
  assert.equal(page.data.step,'input');
  assert.equal(page.data.busy,false);
  assert.equal(page.data.resultText,'');
  for(const scene of ['','wl_bad','%malformed','https://evil.test','wl_'+'z'.repeat(28)])definition.onLoad.call(page,{scene});
  assert.equal(previews,2);assert.equal(page.data.fromQr,true);assert.equal(page.data.code,'');assert.match(page.data.error,/二维码无效/);
  // A previous scan's slow response must never replace the current device.
  const pending: Array<(value: unknown) => void> = [];
  const wxBeforeRace=Object.getOwnPropertyDescriptor(globalThis,'wx');
  Object.defineProperty(globalThis,'wx',{configurable:true,value:{cloud:{callFunction:()=>new Promise(resolve=>pending.push(resolve))}}});
  try {
    const live: Record<string, any>={...definition,data:{...definition.data},setData(update:Record<string,unknown>){Object.assign(this.data,update);}};
    live.setData({code:'A'.repeat(28)});
    const oldLookup=live.lookup();
    live.requestRevision++;
    live.setData({code:'B'.repeat(28),busy:false});
    const newLookup=live.lookup();
    pending[1]({result:{outcome:'preview',clientHint:'New browser',mode:'login'}});
    await newLookup;
    pending[0]({result:{outcome:'preview',clientHint:'Old browser',mode:'login'}});
    await oldLookup;
    assert.equal(live.data.clientHint,'New browser');
    assert.equal(live.data.busy,false);
  } finally { if(wxBeforeRace)Object.defineProperty(globalThis,'wx',wxBeforeRace);else Reflect.deleteProperty(globalThis,'wx'); }

});
