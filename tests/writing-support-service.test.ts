import test from 'node:test';
import assert from 'node:assert/strict';
import {requestWritingSearch,isWritingSearchRequest,editWritingPreferences} from '../miniprogram/services/writingSupport';
import {clearAiConsent} from '../miniprogram/services/aiConsent';
function fixture(context:any,modal:any,call:any) {
  const old=Object.getOwnPropertyDescriptor(globalThis,'wx');
  Object.defineProperty(globalThis,'wx',{configurable:true,writable:true,value:{showModal:modal,showToast(){},cloud:{callFunction:call}}});
  clearAiConsent();context.after(()=>{clearAiConsent();if(old)Object.defineProperty(globalThis,'wx',old);else delete (globalThis as any).wx;});
}
test('explicit search request detection accepts the real conversation and respects refusal',()=>{
  assert.ok(isWritingSearchRequest('我没有概念，你可以帮我搜一下河北的小县城吗？最好直接对标满城。'));
  for(const text of ['不用搜索，直接从文章开始','别查资料了','我过去搜索过资料','不知道怎么写'])assert.equal(isWritingSearchRequest(text),false);
});
test('cancelled public search sends nothing; confirmed query sends only its reviewed text',async context=>{
  let confirm=false;const requests:any[]=[];
  fixture(context,(options:any)=>options.success({confirm,content:'河北满城公开街道资料'}),async(request:any)=>{requests.push(request);return {result:{text:'资料',query:request.data.query,searchedAt:'today',sources:[{index:1,title:'档案',url:'https://example.org'}]}};});
  assert.equal(await requestWritingSearch('搜满城'),undefined);assert.equal(requests.length,0);
  confirm=true;await requestWritingSearch('搜满城');
  const search=requests.find(item=>item.name==='chatInterview');
  assert.deepEqual(search.data,{action:'writingSearch',query:'河北满城公开街道资料',searchConsent:true});
});
test('preference editing displays the stored value and clears with a revision checked save',async context=>{
  const requests:any[]=[];
  fixture(context,(options:any)=>{assert.equal(options.content,'一次只问一个');options.success({confirm:true,content:''});},async(request:any)=>{
    requests.push(request.data);return {result:request.data.operation==='get'?{text:'一次只问一个',revision:3}:{text:'',revision:4}};
  });
  await editWritingPreferences();
  assert.deepEqual(requests[1],{action:'writingPreferences',operation:'save',text:'',revision:3});
});
