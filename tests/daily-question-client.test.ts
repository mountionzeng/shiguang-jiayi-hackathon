import test from 'node:test';
import assert from 'node:assert/strict';
import {DailyQuestionCache} from '../miniprogram/services/dailyQuestion';
const question = (text:string) => ({text,dimension:'feeling' as const,sourceId:'m1',anchor:'蓝色旧书',generationMode:'cloud-ai' as const});
test('daily cache deduplicates requests, refreshes on day or article changes, and sends history',async()=>{
 const cache=new DailyQuestionCache(); let calls=0; let history:string[]=[];
 const generate=async(previous:string[])=>{history=previous;return question(`蓝色旧书带给你什么感受${++calls}？`)};
 const [a,b]=await Promise.all([cache.get('owner:story','v1','2026-10-03',false,generate),cache.get('owner:story','v1','2026-10-03',false,generate)]);
 assert.equal(a.text,b.text);assert.equal(calls,1);
 await cache.get('owner:story','v1','2026-10-03',false,generate);assert.equal(calls,1);
 await cache.get('owner:story','v1','2026-10-04',false,generate);assert.equal(calls,2);assert.deepEqual(history,[a.text]);
 await cache.get('owner:story','v2','2026-10-04',false,generate);assert.equal(calls,3);
 await cache.get('other:story','v2','2026-10-04',false,generate);assert.deepEqual(history,[]);
});
test('manual refresh replaces cache only on success and preserves previous questions after failure',async()=>{
 const cache=new DailyQuestionCache();const first=question('蓝色旧书有什么意义？');
 await cache.get('scope','v1','day',false,async()=>first);
 await assert.rejects(cache.get('scope','v1','day',true,async()=>{throw Error('offline')}));
 assert.equal((await cache.get('scope','v1','day',false,async()=>{throw Error('unexpected')})).text,first.text);
 let previous:string[]=[];await cache.get('scope','v1','day',true,async p=>{previous=p;return question('那次赠书时什么细节最难忘？')});assert.deepEqual(previous,[first.text]);
});
test('late old article generation cannot replace a newer cached question',async()=>{
 const cache=new DailyQuestionCache();let resolveOld!:(value:ReturnType<typeof question>)=>void;
 const old=cache.get('scope','old','day',false,()=>new Promise(resolve=>{resolveOld=resolve}));
 const latest=await cache.get('scope','new','day',false,async()=>question('新文章中的选择有什么意义？'));
 resolveOld(question('旧书带来了什么？'));await old;
 assert.equal((await cache.get('scope','new','day',false,async()=>{throw Error('must use new cache')})).text,latest.text);
});
