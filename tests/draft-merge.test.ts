import test from 'node:test';
import assert from 'node:assert/strict';
import {articleChapter} from '../miniprogram/services/articleModules';
import {mergeArticleChanges,mergeBookChanges,sameArticleContent} from '../miniprogram/services/draftMerge';
import {draftWithChapters} from '../miniprogram/services/chapters';
const chapter=()=>articleChapter({id:'chapter-one',title:'旧章名',memoryIds:[],content:[{text:'原文'}]});
const draft=(chapters:any[])=>draftWithChapters({title:'满城',paragraphs:[],sourceCount:0,generatedAt:'',generationMode:'local-demo'},chapters);
test('merge local chapter rename with cloud body changes without rolling either one back',()=>{
 const base=chapter(),local={...base,title:'解放'},remote=structuredClone(base);remote.content[0].text='云端后续补充';
 const merged=mergeArticleChanges(base,local,remote);
 assert.equal(merged.title,'解放');assert.equal(merged.content[0].text,'云端后续补充');
 assert.equal(base.content[0].text,'原文');
});
test('real same-paragraph conflicts preserve both inputs and never silently choose a winner',()=>{
 const base=chapter(),local=structuredClone(base),remote=structuredClone(base);
 local.content[0].text='手机的新正文';remote.content[0].text='另一设备的新正文';
 assert.throws(()=>mergeArticleChanges(base,local,remote),{code:'DRAFT_MERGE_CONFLICT'});
 assert.equal(local.content[0].text,'手机的新正文');assert.equal(remote.content[0].text,'另一设备的新正文');
});
test('old whole-book backup applies edited title while retaining later chapters and changed cloud text',()=>{
 const base=draft([chapter()]),local=structuredClone(base);local.title='新的书名';local.chapters![0].title='解放';
 const remote=structuredClone(base);remote.chapters![0].content[0].text='另一设备补充';
 remote.chapters!.push({...chapter(),id:'chapter-two',title:'第二章',content:[{text:'新章节'}]});
 const merged=mergeBookChanges(base,local,remote);
 assert.equal(merged.title,'新的书名');assert.deepEqual(merged.chapters!.map(c=>c.title),['解放','第二章']);
 assert.equal(merged.chapters![0].content[0].text,'另一设备补充');
 assert.equal(merged.chapters![1].content[0].text,'新章节');
});
test('migration IDs, attribution and serialized key order do not create false text conflicts',()=>{
 const base={id:'chapter-one',title:'旧章名',memoryIds:[],content:[{text:'原文\n'}]};
 const local={...articleChapter(base),title:'解放'};
 const remote=articleChapter(base);remote.content[0]={text:'原文',blockId:remote.content[0].blockId,sourceIds:['source-kept']};
 const merged=mergeArticleChanges(base,local,remote);
 assert.equal(merged.title,'解放');assert.deepEqual(merged.content[0].sourceIds,['source-kept']);
 assert.equal(sameArticleContent({...local,title:remote.title},remote),true);
});
test('same confirmed draft and empty chapter normalize consistently without manufacturing edits',()=>{
 const empty={id:'chapter-empty',title:'空章',memoryIds:[],content:[]};
 assert.equal(sameArticleContent(empty,empty),true);
 const base=chapter();base.content[0].text='保留换行\n';
 assert.equal(mergeArticleChanges(base,{...base,title:'新名'},base).content[0].text,'保留换行\n');
});
test('deletion versus later edits is a real conflict, not permission to resurrect or erase a chapter',()=>{
 const base=draft([chapter()]),local=draft([]),remote=structuredClone(base);remote.chapters![0].title='改过的章名';
 assert.throws(()=>mergeBookChanges(base,local,remote),{code:'DRAFT_MERGE_CONFLICT'});
});
