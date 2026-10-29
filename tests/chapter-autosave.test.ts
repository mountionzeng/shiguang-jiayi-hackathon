import assert from 'node:assert/strict';
import test from 'node:test';
import { createDemoRoomStateForTests } from './fixtures';
import { draftWithChapters } from '../miniprogram/services/chapters';
import { makeRevision, currentManuscript } from '../miniprogram/services/manuscript';

let definition: any;
(globalThis as any).Page = (value: any) => { definition = value; };
let imported = false;
async function setup() {
  if (!imported) { await import('../miniprogram/pages/book/book'); imported = true; }
  const state = createDemoRoomStateForTests();
  const draft = draftWithChapters({ title: '测试书', paragraphs: [], sourceCount: 0, generatedAt: '2026-09-24', generationMode: 'local-demo' }, [
    { id: 'chapter-a', title: '第一章', memoryIds: [], content: [{text:'原文\n'}] },
  ]);
  state.manuscriptRevisions = [makeRevision('owner', draft, '', 'draft', '原版')];
  const stored = new Map<string, any>([['shiguang-family-room-v5', state], ['shiguang-current-member-v1','owner']]);
  (globalThis as any).wx = {
    getStorageSync: (key: string) => structuredClone(stored.get(key)),
    setStorageSync: (key: string, value: any) => stored.set(key, structuredClone(value)),
    removeStorageSync: (key: string) => stored.delete(key),
    enableAlertBeforeUnload() {}, disableAlertBeforeUnload() {}, offKeyboardHeightChange() {},
    showToast() {}, showModal: (opts: any) => opts.success({ confirm: true }),
  };
  (globalThis as any).getApp = () => ({globalData:{cloudReady:false}});
  function page() {
    const p: any = { ...definition, data:structuredClone(definition.data), chapters:[], contentBuffer:[], requestedMemoryIds:[], photoPaths:{}, imageIds:{}, backdropUrls:{} };
    p.setData = (value: any) => Object.assign(p.data,value);
    p.activeChapterId = 'chapter-a'; p.data.view = 'chapter';
    return p;
  }
  const p = page(); await p.refresh();
  const input = (p: any, text: string) => p.onEditorInput({detail:{delta:{ops:[{insert:text}]},text}});
  return {p, page, stored, input};
}

test('每次正文输入都留草稿，页面销毁后可恢复最后一次输入', async () => {
  const {p,page,input} = await setup();
  input(p,'第一段\n'); input(p,'第一段\n第二段\n');
  // Simulate process termination: no unload callback and no network save.
  const reopened = page(); await reopened.refresh();
  assert.equal(reopened.bodyBuffer,'第一段\n第二段\n');
  assert.equal(reopened.data.editing,true);
});

test('点目录自动保存，重开正文和其他章节不丢失', async () => {
  const {p,page,input,stored} = await setup(); input(p,'新写的长段落\n');
  await p.backToContents();
  assert.equal(p.data.view,'contents');
  assert.equal(currentManuscript(stored.get('shiguang-family-room-v5'),'owner').draft!.chapters![0].content[0].text,'新写的长段落\n');
  const reopened = page(); await reopened.refresh(); assert.equal(reopened.bodyBuffer.trim(),'新写的长段落');
  assert.equal(reopened.data.editing,false);
});

test('本机存储失败必须可见，不能显示已留存或静默退出', async () => {
  const {p,input} = await setup();
  (wx as any).setStorageSync = () => {throw Error('quota');};
  input(p,'不能丢掉这段\n');
  assert.match(p.data.saveNotice,/本机.*失败/);
  await p.backToContents(); assert.equal(p.data.view,'chapter');
});

test('无法读取原生编辑器最新正文时不能把旧缓存当作完整草稿退出', async () => {
  const {p,input,stored} = await setup(); input(p,'最后已知输入\n');
  const before = structuredClone(stored.get('shiguang-family-room-v5').manuscriptRevisions);
  p.editorContext = {getContents: ({fail}:any) => fail(Error('native read failed'))};
  await p.onBack();
  assert.equal(p.data.view,'chapter');
  assert.equal(p.data.editing,true);
  assert.match(p.data.saveNotice,/无法读取/);
  assert.deepEqual(stored.get('shiguang-family-room-v5').manuscriptRevisions,before);
});

test('网络保存失败仍能回目录，重新进入保留草稿并可重试保存', async () => {
  const {p,page,input,stored} = await setup(); input(p,'断网前输入\n');
  const write = wx.setStorageSync;
  (wx as any).setStorageSync = (key:string,value:any) => {
    if (key === 'shiguang-family-room-v5') throw Error('模拟网络失败');
    write(key,value);
  };
  await p.backToContents(); assert.equal(p.data.view,'contents');
  assert.equal(p.data.editing,true, 'local retention must not masquerade as a successful save');
  assert.match(p.data.saveNotice,/草稿已保留/);
  const reopened = page(); await reopened.refresh(); assert.equal(reopened.bodyBuffer,'断网前输入\n');
  assert.equal(reopened.data.view,'contents');
  (wx as any).setStorageSync = write;
  await reopened.backToContents(); assert.equal(reopened.data.view,'contents');
  assert.equal(currentManuscript(stored.get('shiguang-family-room-v5'),'owner').draft!.chapters![0].content[0].text,'断网前输入\n');
});

test('保存过程中到达的新输入不会被保存回执覆盖，退出可保存完整内容', async () => {
  const {p,page,input} = await setup(); input(p,'先写的\n');
  const saving = p.saveEdits(true); input(p,'先写的\n保存中继续输入\n');
  await saving;
  assert.equal(p.bodyBuffer,'先写的\n保存中继续输入\n');
  assert.equal(p.data.editing,true);
  await p.backToContents(); assert.equal(p.data.view,'contents');
  const reopened = page(); await reopened.refresh(); assert.equal(reopened.bodyBuffer.trim(),'先写的\n保存中继续输入');
});

test('断网后跨章编辑，旧保存请求恢复成功时不能抹掉另一章更新的本机文字', async () => {
  const {p,input,stored} = await setup();
  p.chapters.push({id:'chapter-b',title:'第二章',memoryIds:[],content:[{text:'第二章原文\n'}]});
  const write=wx.setStorageSync;
  (wx as any).setStorageSync=(key:string,value:any)=>{
    if(key==='shiguang-family-room-v5') throw Error('offline');
    write(key,value);
  };
  input(p,'第一次待重试的正文\n');
  await p.saveEdits();
  input(p,'第一章后续的新正文\n');
  await p.backToContents();
  await p.openChapter({currentTarget:{dataset:{id:'chapter-b'}}});
  input(p,'第二章的新正文\n');
  (wx as any).setStorageSync=write;
  await p.saveEdits();
  assert.equal(p.data.editing,true, 'acknowledging the older request must leave the newer draft pending');
  assert.equal(p.chapters[0].content[0].text,'第一章后续的新正文\n');
  await p.saveEdits();
  const saved=currentManuscript(stored.get('shiguang-family-room-v5'),'owner');
  assert.deepEqual(saved.draft!.chapters!.map(c=>c.content[0].text),['第一章后续的新正文\n','第二章的新正文\n']);
});

test('云端已有新版时保留本机正文，不覆盖新版', async () => {
  const {p,page,input,stored} = await setup(); input(p,'本机尚未提交\n');
  const state = stored.get('shiguang-family-room-v5');
  const remote = structuredClone(state.manuscriptRevisions[0].draft);
  remote.chapters[0].content = [{text:'另一个编辑器的新正文\n'}];
  const revision = makeRevision('owner',remote,'','draft','新版'); revision.savedAt='2099-01-01';
  state.manuscriptRevisions.push(revision);
  const reopened = page(); await reopened.refresh();
  assert.match(reopened.data.saveNotice,/另有新版/);
  assert.equal(reopened.bodyBuffer,'本机尚未提交\n');
  assert.equal(reopened.data.view,'contents', 'a stale recovered draft must not force the user back into a chapter');
  await reopened.openChapter({currentTarget:{dataset:{id:'chapter-a'}}});
  assert.equal(reopened.data.view,'chapter');
  await reopened.backToContents(); assert.equal(reopened.data.view,'contents');
  const again = page(); await again.refresh();
  assert.equal(again.bodyBuffer,'本机尚未提交\n');
  assert.equal(currentManuscript(stored.get('shiguang-family-room-v5'),'owner').revisionId,revision.id);
});

test('旧版本草稿可返回目录并切换章节，两章本机编辑都保留且不覆盖云端新版', async () => {
  const {p,page,input,stored} = await setup();
  p.chapters.push({id:'chapter-b',title:'第二章',memoryIds:[],content:[{text:'第二章原文\n'}]});
  input(p,'第一章未同步\n');
  const state = stored.get('shiguang-family-room-v5');
  const remote = structuredClone(state.manuscriptRevisions[0].draft);
  remote.chapters[0].content = [{text:'云端新正文\n'}];
  const revision = makeRevision('owner',remote,'','draft','新版'); revision.savedAt='2099-01-01';
  state.manuscriptRevisions.push(revision);
  const remoteBefore = structuredClone(state.manuscriptRevisions);
  await p.onBack();
  assert.equal(p.data.view,'contents');
  assert.equal(p.data.chapterRows.length,2);
  assert.equal(p.data.editing,true);
  await p.openChapter({currentTarget:{dataset:{id:'chapter-b'}}});
  assert.equal(p.activeChapterId,'chapter-b');
  input(p,'第二章也未同步\n');
  await p.onBack();
  assert.equal(p.data.view,'contents');
  await p.openChapter({currentTarget:{dataset:{id:'chapter-a'}}});
  assert.equal(p.bodyBuffer.trim(),'第一章未同步');
  await p.onBack();
  const reopened = page(); await reopened.refresh();
  assert.equal(reopened.data.view,'contents');
  assert.deepEqual(reopened.chapters.map((c:any)=>c.content[0].text),['第一章未同步\n','第二章也未同步\n']);
  assert.deepEqual(stored.get('shiguang-family-room-v5').manuscriptRevisions,remoteBefore);
  let home=''; (wx as any).reLaunch=({url}:any)=>{home=url;};
  await reopened.goHome();
  assert.equal(home,'/pages/index/index');
  const afterHome=page(); await afterHome.refresh();
  assert.deepEqual(afterHome.chapters,reopened.chapters);
});

test('明确放弃草稿后重开恢复保存版本', async () => {
  const {p,page,input} = await setup(); input(p,'用户决定放弃的内容\n');
  p.cancelEdit();
  const reopened = page(); await reopened.refresh(); assert.equal(reopened.bodyBuffer,'原文');
  assert.equal(reopened.data.editing,false);
});

test('故事版本变化但正文编号未变时，旧草稿也从目录恢复且保留版本护栏', async () => {
  const {page,input,stored} = await setup();
  const state = stored.get('shiguang-family-room-v5');
  const revision = state.manuscriptRevisions[0]; revision.storyId='story-conflict';
  state.storyMigration={version:1,status:'active',pending:[]};
  state.stories=[{id:'story-conflict',familyId:'family-test',title:'测试书',bookTitle:'测试书',writingMode:'creative',
    memoryIds:[],protagonistMemberIds:['owner'],version:1,currentRevisionId:revision.id,createdAt:'2026-10-22',updatedAt:'2026-10-22'}];
  const p=page(); p.requestedStoryKey='story-conflict'; await p.refresh();
  input(p,'故事版本冲突的本机正文\n');
  state.stories[0].version=2;
  const reopened=page(); reopened.requestedStoryKey='story-conflict'; await reopened.refresh();
  assert.equal(reopened.data.view,'contents');
  assert.match(reopened.data.saveNotice,/另有新版/);
  assert.equal(reopened.bodyBuffer,'故事版本冲突的本机正文\n');
  assert.equal(await reopened.saveEdits(),false);
  assert.match(reopened.data.saveNotice,/故事已有更新/);
  assert.equal(stored.get('shiguang-family-room-v5').stories[0].version,2);
  assert.equal(currentManuscript(stored.get('shiguang-family-room-v5'),'story-conflict').revisionId,revision.id);
});

test('不同账号、故事的草稿键隔离，旧回执不能清掉新草稿', async () => {
  await setup();
  const {chapterDraftKey,writeChapterDraft,clearChapterDraft,readChapterDraft} = await import('../miniprogram/services/chapterDraft');
  assert.notEqual(chapterDraftKey('user-a','story-1'),chapterDraftKey('user-b','story-1'));
  assert.notEqual(chapterDraftKey('user-a','story-1'),chapterDraftKey('user-a','story-2'));
  const key=chapterDraftKey('user-a','story-1');
  const value:any={draft:{chapters:[]},chapterId:'a',view:'chapter',revisionId:'r',fingerprint:''};
  const old=writeChapterDraft(key,value),latest=writeChapterDraft(key,value);
  clearChapterDraft(key,old.token); assert.equal(readChapterDraft(key)?.token,latest.token);
});

test('较迟的原生编辑器读取不能覆盖刚到达的新输入', async () => {
  const {p,input} = await setup(); input(p,'旧内容\n');
  let complete: any;
  p.editorContext = {getContents: ({success}:any) => {complete=success;}};
  const collection = p.collectEditor(); input(p,'最新内容\n');
  complete({delta:{ops:[{insert:'旧内容\n'}]}}); await collection;
  assert.equal(p.bodyBuffer,'最新内容\n');
});

test('页面卸载前同步留存，即使后台保存失败也能恢复', async () => {
  const {p,page,input} = await setup(); input(p,'退出时的完整正文\n');
  const write=wx.setStorageSync;
  (wx as any).setStorageSync=(key:string,value:any)=>{if(key==='shiguang-family-room-v5')throw Error('offline');write(key,value);};
  p.onUnload(); await p.editSave;
  const reopened=page(); await reopened.refresh();
  assert.equal(reopened.bodyBuffer,'退出时的完整正文\n');
});

test('不支持的粘贴图像保留文字，不能自动提交旧正文', async () => {
  const {p,page,stored} = await setup();
  const original=currentManuscript(stored.get('shiguang-family-room-v5'),'owner').revisionId;
  p.onEditorInput({detail:{delta:{ops:[{insert:'粘贴文字'},{insert:{image:'unsupported'}}]},text:'粘贴文字\n'}});
  await p.saveEdits(true);
  assert.equal(currentManuscript(stored.get('shiguang-family-room-v5'),'owner').revisionId,original);
  const reopened=page(); await reopened.refresh(); assert.equal(reopened.bodyBuffer,'粘贴文字\n');
  assert.ok(reopened.editorError);
});

 test('收到的章节正文展示只在排版中引用的图片，不把图片追加进原文', async () => {
  const {p} = await setup();
  p.story = {...p.story, sourcePolicyRequired:true};
  const chapter = p.chapters[0];
  chapter.packageAssets = {'asset-test':{photoId:'photo-layout-only',aiGenerated:false}};
  chapter.layout = {canvas:{width:900,height:1200},settings:{},pages:[{label:'正文',modules:[{id:'pic',kind:'image',assetId:'asset-test',rect:{x:0,y:0,width:300,height:200}}]}]};
  p.photoPaths['photo-layout-only'] = 'https://example.test/photo.jpg';
  const before = structuredClone(chapter.content);
  const display = p.chapterData();
  assert.equal(display.currentLayoutPages[0].modules[0].imagePath, 'https://example.test/photo.jpg');
  assert.equal(display.chapterRows[0].photoCount,1);
  assert.deepEqual(chapter.content,before);
});

test('received layout backdrop resolves its imported photo while native backdrop keeps priority', async () => {
  const {p} = await setup();
  p.chapters[0].layout = {settings:{bodyTextureAssetId:'asset-backdrop'}};
  p.chapters[0].packageAssets = {'asset-backdrop':{photoId:'photo-received'}};
  p.photoPaths['photo-received'] = 'https://example.test/received.jpg';
  assert.equal(p.activeBackdropUrl(),'https://example.test/received.jpg');
  p.chapters[0].backdropImageId = 'native-backdrop';
  p.backdropUrls['native-backdrop'] = 'https://example.test/native.jpg';
  assert.equal(p.activeBackdropUrl(),'https://example.test/native.jpg');
  p.activeChapterId = 'chapter-missing';assert.equal(p.activeBackdropUrl(),'');
});

test('a recipient without a story or profile can load the book shell before accepting a share', async () => {
  const {p,stored} = await setup();
  const state=stored.get('shiguang-family-room-v5');
  state.members=[];state.stories=[];state.contributions=[];state.manuscriptRevisions=[];
  stored.set('shiguang-family-room-v5',state);
  p.requestedStoryKey='';p.requestedMemberId='';p.data.editing=false;
  await p.refresh(state);
  assert.equal(p.localDraftKey,'');
  assert.equal(p.data.loadError,'');
  assert.equal(p.chapters.length,0);
});
