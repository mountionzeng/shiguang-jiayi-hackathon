import test from 'node:test';
import assert from 'node:assert/strict';
import {ArticleConversation,articleConversationErrorMessage} from '../miniprogram/services/articleConversation';
import {clearAiConsent} from '../miniprogram/services/aiConsent';

function fixture(context: any) {
  const oldWx=(globalThis as any).wx,oldApp=(globalThis as any).getApp;
  const storage=new Map<string,any>(),calls:any[]=[];
  let respond=(data:any):Promise<any> => Promise.resolve({result:{turnId:data.turnId,status:'ready',reply:'回应：'+data.input.answer}});
  (globalThis as any).getApp=()=>({globalData:{aiReady:true,cloudReady:true}});
  (globalThis as any).wx={getStorageSync:(key:string)=>key==='aiConsentDecision'?{granted:true,version:1}:structuredClone(storage.get(key)),
    setStorageSync:(key:string,value:any)=>storage.set(key,structuredClone(value)),
    cloud:{callFunction:({data}:any)=>{calls.push(structuredClone(data));return respond(data);}}};
  clearAiConsent();context.after(()=>{clearAiConsent();(globalThis as any).wx=oldWx;(globalThis as any).getApp=oldApp;});
  return {storage,calls,respond:(fn:typeof respond)=>{respond=fn;}};
}
test('native queue fixes each source and sends in order with preceding replies',async context=>{
 const f=fixture(context),q=new ArticleConversation('ordered',()=>{}),history:any[]=[];
 let finish:(value:any)=>void=()=>{};
 f.respond(data=>f.calls.length===1?new Promise(resolve=>{finish=resolve;}):Promise.resolve({result:{turnId:data.turnId,status:'ready',reply:'第二答'}}));
 const first=q.enqueue('第一句','全文当前未保存稿','chapter:full',{})!;
 const pending=q.drain(()=>history,t=>{history.push({role:'user',text:t.text},{role:'assistant',text:t.reply});return true;},()=>true);
 while(!f.calls.length)await new Promise(resolve=>setImmediate(resolve));
 q.enqueue('第二句','另一模块未保存稿','chapter:block2',{});
 assert.equal(f.calls.length,1);finish({result:{turnId:first.id,status:'ready',reply:'第一答'}});await pending;
 assert.equal(f.calls.length,2);assert.equal(f.calls[0].input.sourceText,'全文当前未保存稿');
 assert.equal(f.calls[1].input.sourceText,'另一模块未保存稿');assert.equal(f.calls[1].input.conversation[1].text,'第一答');
 assert.equal(q.items.length,0);
});
test('lost acknowledgment pauses later sends; restart explicitly reuses the exact id and context',async context=>{
 const f=fixture(context),q=new ArticleConversation('lost',()=>{});
 const first=q.enqueue('留下原话','原稿','章:块',{})!;q.enqueue('下一条','新稿','章:块',{});
 f.respond(async()=>{throw new Error('lost receipt');});
 await assert.rejects(q.drain(()=>[{role:'assistant',text:'原问题'}],()=>true,()=>true));
 assert.equal(q.paused,true);assert.equal(f.calls.length,1);
 const reopened=new ArticleConversation('lost',()=>{});
 await reopened.drain(()=>[],()=>true,()=>true);assert.equal(f.calls.length,1);
 f.respond(async data=>({result:{turnId:data.turnId,status:'ready',reply:'已核对回复'}}));
 await reopened.drain(()=>[{role:'user',text:'恢复后的新历史不能替换旧请求'}],()=>true,()=>true,true);
 assert.equal(f.calls[1].turnId,first.id);assert.deepEqual(f.calls[1],f.calls[0]);assert.equal(f.calls.length,3);
});
test('switching pages retains ready response, does not send remaining queue and never calls again to apply it',async context=>{
 const f=fixture(context),q=new ArticleConversation('scope',()=>{});let current=true,applied=0;
 q.enqueue('原章消息','原章全文','原章',{});q.enqueue('等下一轮','原章全文','原章',{});
 f.respond(async data=>{current=false;return {result:{turnId:data.turnId,status:'ready',reply:'原章回答'}};});
 await q.drain(()=>[],()=>{applied++;return true;},()=>current);
 assert.equal(applied,0);assert.equal(f.calls.length,1);assert.equal(q.items[0].status,'ready');
 const reopened=new ArticleConversation('scope',()=>{});
 await reopened.drain(()=>[],()=>{applied++;return true;},()=>true,true);
 assert.equal(applied,2);assert.equal(f.calls.length,2,'first completed response applies without inference');
});
test('reopening during an active call shares its durable queue so newly queued messages are not overwritten',async context=>{
 const f=fixture(context),q=ArticleConversation.open('active',()=>{});let finish:(value:any)=>void=()=>{},current=true;
 const first=q.enqueue('第一条','当前稿','章',{})!;
 f.respond(()=>new Promise(resolve=>{finish=resolve;}));
 const pending=q.drain(()=>[],()=>true,()=>current);
 while(!f.calls.length)await new Promise(resolve=>setImmediate(resolve));
 current=false;const reopened=ArticleConversation.open('active',()=>{});assert.equal(reopened,q);
 reopened.enqueue('重开后输入','新正文','章',{});finish({result:{turnId:first.id,status:'ready',reply:'旧轮回复'}});await pending;
 assert.equal(f.storage.get('active').length,2);assert.equal(reopened.items[1].text,'重开后输入');
});
test('storage failure rejects enqueue before accepting input; oversized fulltext is not silently truncated',context=>{
 fixture(context);const q=new ArticleConversation('storage',()=>{});
 (wx as any).setStorageSync=()=>{throw new Error('storage full');};
 assert.throws(()=>q.enqueue('原话','上下文','章',{}),/storage full/);assert.equal(q.items.length,0);
 assert.throws(()=>q.enqueue('原话','甲'.repeat(40001),'章',{}),/选择文字模块/);
});

test('old endpoint EMPTY_ANSWER safely falls back with source and conversation',async context=>{
 const f=fixture(context),q=new ArticleConversation('legacy',()=>{});let reply='';
 q.enqueue('请写顺一点','纸船停在窗边','章',{});
 f.respond(async data=>{if(data.action)throw {errMsg:'cloud.callFunction:fail Error: EMPTY_ANSWER at main (/var/user/index.js:553:22)'};
   assert.equal(f.storage.get('legacy')[0].legacyAttempted,true);
   return {result:{text:'我可以帮你把这段写得更顺。',dimension:'event'}};});
 await q.drain(()=>[{role:'user',text:'先前的话'}],t=>{reply=t.reply!;return true;},()=>true);
 assert.equal(f.calls.length,2);assert.equal(f.calls[1].answer,'请写顺一点');
 assert.equal(f.calls[1].sourceText,'纸船停在窗边');assert.equal(f.calls[1].sourceOnly,true);
 assert.deepEqual(f.calls[1].conversation,[{role:'user',text:'先前的话'}]);
 assert.match(reply,/写得更顺/);assert.equal(q.items.length,0);
});
test('unknown old endpoint outcome is never regenerated, even after restart and service upgrade',async context=>{
 const f=fixture(context),q=new ArticleConversation('legacy-lost',()=>{});
 q.enqueue('请写顺一点','正文','章',{});
 f.respond(async data=>{throw new Error(data.action?'EMPTY_ANSWER':'timeout');});
 await assert.rejects(q.drain(()=>[],()=>true,()=>true));assert.equal(f.calls.length,2);
 f.respond(async data=>({result:{turnId:data.turnId,status:'ready',reply:'不应再生成'}}));
 const reopened=new ArticleConversation('legacy-lost',()=>{});
 await assert.rejects(reopened.drain(()=>[],()=>true,()=>true,true),/不会自动重发/);
 assert.equal(f.calls.length,2);assert.equal(reopened.items[0].text,'请写顺一点');
});
test('timeout is not protocol detection and does not invoke legacy inference',async context=>{
 const f=fixture(context),q=new ArticleConversation('timeout',()=>{});q.enqueue('原话','正文','章',{});
 f.respond(async()=>{throw new Error('cloud.callFunction:fail timeout at /var/user/index.js');});
 await assert.rejects(q.drain(()=>[],()=>true,()=>true));assert.equal(f.calls.length,1);
 assert.equal(q.items[0].legacyAttempted,undefined);
});
test('legacy attempt must be durable and current before making a chargeable call',async context=>{
 const f=fixture(context),q=new ArticleConversation('legacy-storage',()=>{});q.enqueue('原话','正文','章',{});
 f.respond(async()=>{(wx as any).setStorageSync=()=>{throw new Error('storage full');};throw new Error('EMPTY_ANSWER');});
 await assert.rejects(q.drain(()=>[],()=>true,()=>true));assert.equal(f.calls.length,1);
 assert.equal(f.storage.get('legacy-storage')[0].legacyAttempted,undefined);
});
test('switching scope before legacy fallback prevents inference',async context=>{
 const f=fixture(context),q=new ArticleConversation('legacy-scope',()=>{});let current=true;
 q.enqueue('原话','正文','章',{});f.respond(async()=>{current=false;throw new Error('EMPTY_ANSWER');});
 await assert.rejects(q.drain(()=>[],()=>true,()=>current));assert.equal(f.calls.length,1);
});

test('cloud stack never leaks into the user-facing status',()=>{
 const message=articleConversationErrorMessage(new Error('cloud.callFunction:fail Error: EMPTY_ANSWER at main (/var/user/index.js:553:22)'));
 assert.match(message,/原话已保留/);assert.doesNotMatch(message,/cloud.callFunction|EMPTY_ANSWER|index.js|at main/);
});
