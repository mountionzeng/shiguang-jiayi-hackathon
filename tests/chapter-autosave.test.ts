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

test('网络保存失败留在编辑页，重新进入恢复草稿后可重试', async () => {
  const {p,page,input,stored} = await setup(); input(p,'断网前输入\n');
  const write = wx.setStorageSync;
  (wx as any).setStorageSync = (key:string,value:any) => {
    if (key === 'shiguang-family-room-v5') throw Error('模拟网络失败');
    write(key,value);
  };
  await p.backToContents(); assert.equal(p.data.view,'chapter');
  assert.match(p.data.saveNotice,/草稿已保留/);
  const reopened = page(); await reopened.refresh(); assert.equal(reopened.bodyBuffer,'断网前输入\n');
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
  await reopened.backToContents(); assert.equal(reopened.data.view,'chapter');
  assert.equal(currentManuscript(stored.get('shiguang-family-room-v5'),'owner').revisionId,revision.id);
});

test('明确放弃草稿后重开恢复保存版本', async () => {
  const {p,page,input} = await setup(); input(p,'用户决定放弃的内容\n');
  p.cancelEdit();
  const reopened = page(); await reopened.refresh(); assert.equal(reopened.bodyBuffer,'原文');
  assert.equal(reopened.data.editing,false);
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
