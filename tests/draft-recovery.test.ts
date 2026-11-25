import test from 'node:test';
import assert from 'node:assert/strict';
import {articleChapter} from '../miniprogram/services/articleModules';
import {syncStoredArticle,syncRetainedDraft} from '../miniprogram/services/draftRecovery';
import {createDemoRoomStateForTests} from './fixtures';
import {draftWithChapters} from '../miniprogram/services/chapters';
import {makeRevision,currentManuscript} from '../miniprogram/services/manuscript';
const {fixture}=require('./helpers/story-access-fixture');
const {resolveStoryIdentity}=require('../cloudfunctions/storyBooks/identity');
const {createStoryService}=require('../cloudfunctions/storyBooks/service');
const {errorCode}=require('../cloudfunctions/storyBooks/errors');
const article=()=>articleChapter({id:'chapter-one',title:'旧章名',memoryIds:[],content:[{text:'原文'}]});
const draft=(chapters:any[])=>draftWithChapters({title:'满城',paragraphs:[],sourceCount:0,generatedAt:'',generationMode:'local-demo'},chapters);
function storage() {
 const stored=new Map<string,any>();
 (globalThis as any).wx={getStorageSync:(k:string)=>structuredClone(stored.get(k)),setStorageSync:(k:string,v:any)=>stored.set(k,structuredClone(v)),removeStorageSync:(k:string)=>stored.delete(k)};
 (globalThis as any).getApp=()=>({globalData:{cloudReady:false}});
 return stored;
}
async function server() {
 const stored=storage(),f=fixture();f.account('owner');
 const ctx={APPID:'wx-original',OPENID:'owner'};
 await resolveStoryIdentity(f.repo,ctx,{bootstrapAppId:'wx-original'});
 const chapters=[article(),articleChapter({id:'chapter-two',title:'第二章',memoryIds:[],content:[{text:'第二章原文'}]})];
 const base=draft(chapters),story={id:'story-recovery',familyId:'family_owner',title:'满城',memoryIds:[],version:2,currentRevisionId:'revision-new'};
 const remote=structuredClone(base);remote.chapters![1].title='改过的第二章';
 const put=(id:string,value:any)=>f.tables.set('biography_drafts:family_owner_'+id,{familyId:'family_owner',storyId:story.id,revision:{id,storyId:story.id,draft:value}});
 put('revision-old',base);put('revision-new',remote);f.tables.set('stories:family_owner_'+story.id,story);
 const service=createStoryService(f.repo,{accessEnabled:true,rulesReady:true,bootstrapAppId:'wx-original',sharedReadFamilyIds:['family_owner'],approveChapterText:async()=>true});
 const calls:any[]=[];
 (wx as any).cloud={callFunction:async({data}:any)=>{
   calls.push(structuredClone(data));
   try{return {result:await service(ctx,data)};}catch(e:any){return {result:{error:'STORY_BOOK_ERROR',code:errorCode(e),message:e.message}};}
 }};
 const latest=()=>f.tables.get('stories:family_owner_'+story.id);
 const read=(id:string)=>f.tables.get('biography_drafts:family_owner_'+id).revision.draft;
 const load=async(id:string)=>({story:latest(),draft:read(latest().currentRevisionId),base:read(id)});
 return {stored,f,story,base,read,latest,load,calls};
}
test('real dispatcher conflict is recovered automatically and preserves all immutable revisions',async()=>{
 const f=await server(),local={...article(),title:'解放'};
 f.stored.set('draft',{revisionId:'revision-old',storyVersion:1,chapter:local});
 await syncStoredArticle('draft',f.story.id,f.load);
 assert.equal(f.calls.length,2);assert.notEqual(f.calls[0].requestId,f.calls[1].requestId);
 assert.equal(f.calls[1].revisionId,'revision-new');assert.equal(f.calls[1].expectedVersion,2);
 const result=f.read(f.latest().currentRevisionId);
 assert.deepEqual(result.chapters.map((c:any)=>c.title),['解放','改过的第二章']);
 assert.equal(f.stored.has('draft'),false);
 assert.equal(f.read('revision-old').chapters[0].title,'旧章名');
 assert.equal(f.read('revision-new').chapters[0].title,'旧章名');
});
test('lost receipt retries the identical payload before sending newer local input',async()=>{
 const f=await server(),local=article();local.title='先保存的标题';
 f.stored.set('draft',{revisionId:'revision-new',storyVersion:2,chapter:local});
 const original=(wx as any).cloud.callFunction;
 (wx as any).cloud.callFunction=async(input:any)=>{await original(input);throw Error('response lost');};
 await assert.rejects(syncStoredArticle('draft',f.story.id,f.load),/response lost/);
 const saved=f.stored.get('draft');saved.chapter={...saved.chapter,title:'最后的标题'};
 (wx as any).cloud.callFunction=original;
 await syncStoredArticle('draft',f.story.id,f.load);
 assert.deepEqual(f.calls[0],f.calls[1]);
 assert.equal(f.read(f.latest().currentRevisionId).chapters[0].title,'最后的标题');
 assert.equal(f.stored.has('draft'),false);
});
test('already confirmed legacy draft is cleaned without writing a duplicate version',async()=>{
 const f=await server();f.stored.set('draft',{revisionId:'revision-old',conflict:true,chapter:article()});
 await syncStoredArticle('draft',f.story.id,f.load);
 assert.equal(f.calls.length,0);assert.equal(f.stored.has('draft'),false);assert.equal(f.latest().version,2);
});
test('genuine same-field conflict and network failures retain the exact local draft',async()=>{
 const f=await server();const local=article();local.title='手机新名字';
 f.read('revision-new').chapters[0].title='其他设备的新名字';
 const saved={revisionId:'revision-old',conflict:true,chapter:local};f.stored.set('draft',saved);
 await assert.rejects(syncStoredArticle('draft',f.story.id,f.load),{code:'DRAFT_MERGE_CONFLICT'});
 assert.deepEqual(f.stored.get('draft'),saved);assert.equal(f.calls.length,0);
 await assert.rejects(syncStoredArticle('draft',f.story.id,async()=>{throw Error('offline');}),/offline/);
 assert.deepEqual(f.stored.get('draft'),saved);
});
test('new local input during a background recovery is not cleared by its older snapshot',async()=>{
 const f=await server();f.stored.set('draft',{revisionId:'revision-old',conflict:true,chapter:{...article(),title:'旧输入'}});
 let first=true;
 await syncStoredArticle('draft',f.story.id,async id=>{
   if(first){first=false;f.stored.get('draft').chapter.title='恢复期间的新输入';}
   return f.load(id);
 });
 assert.equal(f.read(f.latest().currentRevisionId).chapters[0].title,'恢复期间的新输入');
 assert.equal(f.stored.has('draft'),false);
});
function retainedSetup() {
 const stored=storage(),state=createDemoRoomStateForTests();
 const base=draft([article()]),remote=structuredClone(base);remote.chapters!.push(articleChapter({id:'chapter-two',title:'新增章节',memoryIds:[],content:[{text:'新文'}]}));
 const old=makeRevision('owner',base,'','draft','原稿');old.id='revision-old';old.storyId='story-recovery';
 const current={...makeRevision('owner',remote,'','draft','新章节'),id:'revision-new',storyId:'story-recovery'};
 state.storyMigration={version:1,status:'active',pending:[]};state.manuscriptRevisions=[old,current];
 state.stories=[{id:'story-recovery',familyId:'family-test',title:'满城',bookTitle:'满城',writingMode:'creative',memoryIds:[],protagonistMemberIds:[],version:2,currentRevisionId:'revision-new',createdAt:'',updatedAt:''}];
 stored.set('shiguang-family-room-v5',state);
 const mine=structuredClone(base);mine.title='新的书名';mine.chapters![0].title='解放';
 const backup={token:'phone-draft',draft:mine,chapterId:'chapter-one',view:'chapter',revisionId:'revision-old',storyVersion:1,fingerprint:'',savedAt:'2026-11-04'};
 stored.set('backup:retained',[backup]);
 return {stored,backup,read:()=>currentManuscript(stored.get('shiguang-family-room-v5'),'story-recovery').draft!};
}
test('retained pre-upgrade whole-book draft recovers name changes while keeping newly added chapters',async()=>{
 const f=retainedSetup();await syncRetainedDraft('backup','phone-draft','story-recovery');
 assert.equal(f.read().title,'新的书名');assert.deepEqual(f.read().chapters!.map(c=>c.title),['解放','新增章节']);
 assert.deepEqual(f.stored.get('backup:retained'),[]);
 assert.equal(f.stored.get('shiguang-family-room-v5').manuscriptRevisions[0].draft.title,'满城');
});
test('retained draft persists its pending request before an interrupted save and resumes it safely',async()=>{
 const f=retainedSetup(),write=(wx as any).setStorageSync;
 (wx as any).setStorageSync=(key:string,value:any)=>{write(key,value);if(key==='shiguang-family-room-v5')throw Error('response lost');};
 await assert.rejects(syncRetainedDraft('backup','phone-draft','story-recovery'),/response lost/);
 const pending=f.stored.get('backup:retained')[0].pendingSave;
 assert.ok(pending);assert.equal(f.read().title,'新的书名');
 (wx as any).setStorageSync=write;
 await syncRetainedDraft('backup','phone-draft','story-recovery');
 assert.deepEqual(f.stored.get('backup:retained'),[]);
 assert.equal(f.stored.get('shiguang-family-room-v5').manuscriptRevisions.filter((r:any)=>r.id===pending.id).length,1);
});

test('a closed chapter replaces a definitively rejected attempt with newer saved input',async()=>{
 const f=await server(),chapter=article();chapter.title='用户改好的标题';
 const attempt={requestId:'request-rejected-001',storyId:f.story.id,revisionId:'revision-new',expectedVersion:2,chapter:{...chapter,title:'被拒绝的旧标题'}};
 f.stored.set('draft',{revisionId:'revision-new',storyVersion:2,chapter,attempt});
 const call=(wx as any).cloud.callFunction;
 (wx as any).cloud.callFunction=async(input:any)=>input.data.requestId===attempt.requestId
   ? {result:{error:'STORY_BOOK_ERROR',code:'CONTENT_REJECTED',message:'文字未通过内容检查'}} : call(input);
 await syncStoredArticle('draft',f.story.id,f.load);
 assert.equal(f.read(f.latest().currentRevisionId).chapters[0].title,chapter.title);
 assert.equal(f.stored.has('draft'),false);
});


test('rejection during a concurrent local update preserves and saves the newer chapter',async()=>{
 const f=await server(),chapter={...article(),title:'第一稿'};
 f.stored.set('draft',{revisionId:'revision-new',storyVersion:2,chapter});
 const call=(wx as any).cloud.callFunction;let first=true;
 (wx as any).cloud.callFunction=async(input:any)=>{
   if(first){first=false;const saved=f.stored.get('draft');f.stored.set('draft',{...saved,chapter:{...saved.chapter,title:'请求期间的新输入'}});return {result:{error:'STORY_BOOK_ERROR',code:'CONTENT_REJECTED',message:'拒绝'}};}
   if(input.data.chapter.title==='第一稿')return {result:{error:'STORY_BOOK_ERROR',code:'CONTENT_REJECTED',message:'拒绝'}};
   return call(input);
 };
 await syncStoredArticle('draft',f.story.id,f.load);
 assert.equal(f.read(f.latest().currentRevisionId).chapters[0].title,'请求期间的新输入');assert.equal(f.stored.has('draft'),false);
});

test('an unchanged rejected draft stays local without looping or falsely confirming it',async()=>{
 const f=await server(),chapter=article();f.stored.set('draft',{revisionId:'revision-new',storyVersion:2,chapter});let calls=0;
 (wx as any).cloud.callFunction=async()=>{calls++;return {result:{error:'STORY_BOOK_ERROR',code:'MODERATION_REVIEW',message:'需复核'}};};
 await assert.rejects(syncStoredArticle('draft',f.story.id,f.load),{code:'MODERATION_REVIEW'});
 assert.equal(calls,1);assert.equal(f.stored.get('draft').attempt,null);assert.deepEqual(f.stored.get('draft').chapter,chapter);assert.equal(f.latest().version,2);
});
