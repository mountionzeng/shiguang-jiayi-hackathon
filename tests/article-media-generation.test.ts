import test from 'node:test';
import assert from 'node:assert/strict';
import {runArticleMedia,mediaDefinitelyNotSubmitted,type ArticleMediaTask} from '../miniprogram/services/articleMediaGeneration';
import {storyAudioApi} from '../miniprogram/services/storyAudioService';
import {AI_CONSENT_VERSION} from '../miniprogram/config/runtime';

const task:ArticleMediaTask={kind:'narration',scope:'chapter',requestId:'audio-test-full',storyId:'story-test',revisionId:'revision-test',chapterId:'chapter-test',blockId:'block-'+'a'.repeat(64),text:'第一段。\n\n第二段。',voiceId:'101001'};
function fixture(t:any,caps:any,status:any){
 const originals={capabilities:storyAudioApi.capabilities,create:storyAudioApi.create,status:storyAudioApi.status};
 const oldWx=(globalThis as any).wx;
 (globalThis as any).wx={getStorageSync:()=>({granted:true,version:AI_CONSENT_VERSION})};
 let calls:any[]=[];
 storyAudioApi.capabilities=async()=>caps;
 storyAudioApi.create=async input=>{calls.push(input);return {operation:{} as any};};
 storyAudioApi.status=async()=>({operation:status});
 t.after(()=>{Object.assign(storyAudioApi,originals);(globalThis as any).wx=oldWx;});
 return calls;
}
test('full article request sends its scope and confirmed revision and refuses legacy audio capability',async t=>{
 const calls=fixture(t,{fullArticleAudio:false},{status:'ready',id:'op-test'});
 await assert.rejects(runArticleMedia({...task},()=>{},()=>true),{code:'NOT_SUBMITTED'});
 assert.equal(calls.length,0);
 storyAudioApi.capabilities=async()=>({fullArticleAudio:true} as any);
 assert.deepEqual(await runArticleMedia({...task},()=>{},()=>true),{kind:'narration',operationId:'op-test'});
 assert.equal(calls[0].scope,'chapter');assert.equal(calls[0].revisionId,task.revisionId);
 assert.equal(calls[0].text,task.text);
});
test('definitive TTS permission rejection can leave pending queue while unknown work cannot',async t=>{
 fixture(t,{fullArticleAudio:true},{status:'failed',error:{code:'TTS_PERMISSION_REQUIRED',message:'未开通权限'}});
 await assert.rejects(runArticleMedia({...task},()=>{},()=>true),error=>mediaDefinitelyNotSubmitted(error));
 storyAudioApi.status=async()=>({operation:{status:'unknown',error:{code:'TTS_PERMISSION_REQUIRED',message:'结果未知'}} as any});
 await assert.rejects(runArticleMedia({...task},()=>{},()=>true),error=>!mediaDefinitelyNotSubmitted(error));
});
