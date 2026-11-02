import test from 'node:test';
import assert from 'node:assert/strict';

test('scanning previews the browser but never confirms login automatically',async()=>{
  let definition: Record<string, any> = {};
  const previous=Object.getOwnPropertyDescriptor(globalThis,'Page');
  Object.defineProperty(globalThis,'Page',{configurable:true,value:(page:Record<string,any>)=>{definition=page;}});
  try{await import('../miniprogram/packages/web-login/pages/confirm/index');}
  finally{if(previous)Object.defineProperty(globalThis,'Page',previous);else Reflect.deleteProperty(globalThis,'Page');}
  let previews=0;
  const page={data:{...definition.data},setData(update:Record<string,unknown>){Object.assign(this.data,update);},lookup(){previews++;},decide(){throw new Error('must require a tap');}};
  definition.onLoad.call(page,{scene:'wl_'+'A'.repeat(28)});
  assert.equal(previews,1);assert.equal(page.data.code,'A'.repeat(28));assert.equal(page.data.fromQr,true);
  for(const scene of ['wl_bad','%malformed','https://evil.test','wl_'+'z'.repeat(28)])definition.onLoad.call(page,{scene});
  assert.equal(previews,1);assert.match(page.data.error,/二维码无效/);
});
