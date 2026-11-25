import test from 'node:test';
import assert from 'node:assert/strict';
import {createDemoRoomStateForTests} from './fixtures';
import {saveWritingStory} from '../miniprogram/services/writingStory';
import {storyShelf} from '../miniprogram/services/storyShelf';
import {current} from '../miniprogram/domain/storyBookCore';

test('generated stories appear with readable text, edits update the same story and retries preserve source memories',async context=>{
 const previousWx=(globalThis as any).wx,previousApp=(globalThis as any).getApp;
 context.after(()=>{(globalThis as any).wx=previousWx;(globalThis as any).getApp=previousApp;});
 const initial=createDemoRoomStateForTests();initial.storyMigration={version:1,status:'active',pending:[]};initial.stories=[];
 const stored=new Map<string,any>([['shiguang-family-room-v5',initial]]);
 (globalThis as any).getApp=()=>({globalData:{cloudReady:false}});
 (globalThis as any).wx={getStorageSync:(key:string)=>stored.get(key),setStorageSync:(key:string,value:any)=>stored.set(key,value)};
 const input={storyId:'story-generated',revisionId:'',memoryId:'demo-personal-rain',title:'生成的故事',text:'第一版完整正文。',generationMode:'cloud-ai' as const};
 const first=await saveWritingStory(input);let state=stored.get('shiguang-family-room-v5');
 assert.equal(storyShelf(state)[0].title,input.title);assert.equal(storyShelf(state)[0].chapterCount,1);
 assert.equal(current(state,first.storyId).draft!.chapters![0].content[0].text,input.text+'\n');
 assert.deepEqual(await saveWritingStory(input),first,'lost acknowledgement reconciles without duplicate book');
 const edited=await saveWritingStory({...input,revisionId:first.revisionId,text:'手动改好的正文。'});
 state=stored.get('shiguang-family-room-v5');assert.equal(state.stories.length,1);assert.equal(state.manuscriptRevisions.length,2);
 assert.equal(current(state,edited.storyId).draft!.chapters![0].content[0].text,'手动改好的正文。\n');
 await assert.rejects(saveWritingStory({...input,revisionId:first.revisionId,text:'过期草稿'}),/别处修改/);
 const second=await saveWritingStory({...input,storyId:'story-another'});state=stored.get('shiguang-family-room-v5');
 assert.notEqual(second.storyId,first.storyId);assert.equal(state.stories.length,2);assert.notEqual(state.stories[0].title,state.stories[1].title);
 assert.equal(JSON.stringify(state.contributions),JSON.stringify(initial.contributions));
 state.stories.find((s:any)=>s.id===second.storyId).deletedAt='today';
 await assert.rejects(saveWritingStory({...input,storyId:second.storyId}),/最近删除/);
});
