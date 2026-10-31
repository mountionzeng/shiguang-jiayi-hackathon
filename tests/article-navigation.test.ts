import assert from 'node:assert/strict';
import test from 'node:test';
import { articleChapter } from '../miniprogram/services/articleModules';

let definition: any;
async function setup() {
  if (!definition) {
    (globalThis as any).Page = (value: any) => { definition = value; };
    await import('../miniprogram/pages/book/book');
  }
  const stored = new Map<string, any>();
  const requests: any[] = [];
  (globalThis as any).wx = {
    getStorageSync: (key: string) => structuredClone(stored.get(key)),
    setStorageSync: (key: string, value: any) => stored.set(key, JSON.parse(JSON.stringify(value))),
    removeStorageSync: (key: string) => stored.delete(key),
    showToast() {}, disableAlertBeforeUnload() {},
    cloud: { callFunction: async ({ data }: any) => {
      requests.push(data);
      return {result:{error:'VERSION_CONFLICT',message:'文章已在别处修改，请重新打开后重试'}};
    } },
  };
  const page = () => {
    const p: any = {...definition, data:structuredClone(definition.data),
      chapters:['a','b'].map(id => articleChapter({id, title:id, memoryIds:[], content:[{text:`原文${id}`}]})),
      memories:[], pendingReturns:[], photoPaths:{}, imageIds:{}, backdropUrls:{},
      story:{id:'story-test', version:2, currentRevisionId:'revision-new'}, revisionId:'revision-new', activeChapterId:'a',
    };
    p.setData = (update: any) => Object.assign(p.data, update);
    p.releaseArticleChat = () => {};
    p.seedEditor = () => {};
    p.refresh = async () => {};
    p.loadChapterChanges = async () => {};
    p.data.view = 'contents';
    p.setData(p.chapterData());
    return p;
  };
  return {p:page(), page, stored, requests};
}
const open = (p: any, id: string) => p.openChapter({currentTarget:{dataset:{id}}});
const type = (p: any, text: string) => {
  const chapter = {...p.data.article, content:p.data.article.content.map((b:any, i:number) => i ? b : {...b,text})};
  p.onArticleChange({detail:{chapter}}); clearTimeout(p.articleTimer);
};

test('a restored conflicting article cannot trap chapter navigation or spill into another chapter', async () => {
  const {p, page, stored, requests} = await setup();
  stored.set(p.articleKey(), {revisionId:'revision-old', chapter:{...p.chapters[0],content:[{...p.chapters[0].content[0],text:'本机未提交'}]}});
  p.setData(p.chapterData());
  await open(p,'b');
  assert.equal(p.activeChapterId,'b'); assert.equal(p.data.view,'chapter');
  assert.equal(p.articlePending,null); assert.equal(p.data.article.content[0].text,'原文b');
  await p.backToContents(); await open(p,'a');
  assert.equal(p.data.article.content[0].text,'本机未提交');
  assert.equal(p.articleConflict,true);
  type(p,'冲突后继续写');
  await p.backToContents();
  const reopened=page(); await open(reopened,'a');
  assert.equal(reopened.data.article.content[0].text,'冲突后继续写');
  assert.equal(reopened.articleConflict,true);
  assert.equal(requests.length,0,'never rebase a conflicting draft onto the new revision');
});

test('server version rejection still permits browsing and retains the original save request', async () => {
  const {p,stored,requests} = await setup();
  await open(p,'a'); type(p,'本机新写的正文');
  await p.backToContents();
  assert.equal(p.data.view,'contents');
  const saved=stored.get(p.articleKey());
  assert.equal(saved.chapter.content[0].text,'本机新写的正文');
  assert.equal(saved.attempt.requestId,requests[0].requestId);
  assert.equal(saved.conflict,true);
  await open(p,'b');
  assert.equal(p.activeChapterId,'b');
  await p.backToContents(); await open(p,'a');
  assert.equal(p.data.article.content[0].text,'本机新写的正文');
  assert.equal(await p.flushArticle(),false);
  assert.equal(requests.length,1,'known conflicts do not repeatedly call the server');
});

test('failed local backup blocks navigation visibly rather than dropping article input', async () => {
  const {p} = await setup(); await open(p,'a'); type(p,'不能丢失');
  (wx as any).setStorageSync=()=>{throw Error('quota');};
  await open(p,'b');
  assert.equal(p.activeChapterId,'a'); assert.equal(p.data.view,'chapter');
  assert.match(p.data.articleStatus,/本机|空间/);
  assert.equal(p.articlePending.content[0].text,'不能丢失');
});

test('an unknown save result reuses the request id after leaving and reopening the chapter', async () => {
  const {p,requests} = await setup();
  (wx as any).cloud.callFunction=async ({data}:any)=>{requests.push(data); throw Error('offline');};
  await open(p,'a'); type(p,'离线原稿');
  await p.backToContents(); const original=requests[0];
  await open(p,'b'); await p.backToContents(); await open(p,'a');
  (wx as any).cloud.callFunction=async ({data}:any)=>{requests.push(data);return {result:{revisionId:'revision-saved',version:3}};};
  assert.equal(await p.flushArticle(),true);
  assert.equal(requests[requests.length - 1].requestId,original.requestId);
  assert.equal(p.articlePending,null);
  assert.equal(requests.filter(r => r.requestId !== original.requestId).length,0);
});


test('reopened uncertain save reconciles its request against a newer server revision without resending new edits', async () => {
  const {p,page,stored,requests}=await setup();
  (wx as any).cloud.callFunction=async ({data}:any)=>{requests.push(data);throw Error('response lost');};
  await open(p,'a'); type(p,'已送出但回执丢失'); await p.backToContents();
  const request=requests[0];
  const reopened=page(); reopened.revisionId='revision-accepted';
  reopened.story={...reopened.story,currentRevisionId:'revision-accepted',version:3};
  await open(reopened,'b');
  await reopened.backToContents(); await open(reopened,'a');
  (wx as any).cloud.callFunction=async ({data}:any)=>{requests.push(data);return {result:{revisionId:'revision-accepted',version:3}};};
  assert.equal(await reopened.flushArticle(),true);
  assert.equal(requests[requests.length-1].requestId,request.requestId);
  assert.equal(stored.has(reopened.articleKey()),false);
});

test('new chapter is not trapped by a conflicting article and does not publish its draft into the book', async () => {
  const {p,stored}=await setup();
  await open(p,'a'); type(p,'只在本机的冲突正文'); await p.backToContents();
  const key=p.articleKey();
  p.persist=async (draft:any)=>{
    assert.equal(draft.chapters[0].content[0].text,'原文a');
    p.chapters=draft.chapters;
    return true;
  };
  await p.selectTool({currentTarget:{dataset:{action:'new-chapter'}}});
  assert.equal(p.chapters.length,3);
  assert.equal(p.activeChapterId,p.chapters[2].id);
  assert.equal(stored.get(key).chapter.content[0].text,'只在本机的冲突正文');
  assert.equal(stored.get(key).conflict,true);
});

test('new chapter refreshes a rejected article baseline before saving structural changes', async () => {
  const {p,stored}=await setup();
  await open(p,'a'); type(p,'手机待核对正文'); await p.backToContents();
  await open(p,'b'); await p.backToContents();
  p.refresh=async()=>{
    p.revisionId='revision-latest'; p.story={...p.story,version:3,currentRevisionId:'revision-latest'};
    p.chapters=p.chapters.map((c:any)=>c.id==='a'?{...c,content:[{text:'云端最新正文'}]}:c);
  };
  p.persist=async(draft:any)=>{
    assert.equal(p.revisionId,'revision-latest');
    assert.equal(p.story.version,3);
    assert.equal(draft.chapters[0].content[0].text,'云端最新正文');
    p.chapters=draft.chapters; return true;
  };
  await p.createChapter({currentTarget:{dataset:{}}});
  assert.equal(p.chapters.length,3);
  assert.ok([...stored.values()].some((v:any)=>v.chapter?.content[0]?.text==='手机待核对正文'));
});

test('dragging after an article conflict reorders latest chapters without overwriting their text', async()=>{
  const {p}=await setup(); await open(p,'a'); type(p,'本机草稿'); await p.backToContents();
  p.windowWidth=375;
  p.refresh=async()=>{
    p.revisionId='revision-latest'; p.story={...p.story,version:3,currentRevisionId:'revision-latest'};
    p.chapters=p.chapters.map((c:any)=>({...c,content:[{text:`最新${c.id}`}]}));
  };
  p.persist=async(draft:any)=>{
    assert.equal(p.revisionId,'revision-latest');
    assert.deepEqual(draft.chapters.map((c:any)=>c.content[0].text),['最新b','最新a']);
    p.chapters=draft.chapters; return true;
  };
  p.startChapterDrag({currentTarget:{dataset:{id:'a'}},touches:[{clientY:100}]});
  p.moveChapterDrag({touches:[{clientY:180}]});
  await p.endChapterDrag();
  assert.deepEqual(p.chapters.map((c:any)=>c.id),['b','a']);
});

test('a failed baseline refresh preserves the article draft and prevents a structural write', async()=>{
  const {p,stored}=await setup(); await open(p,'a'); type(p,'保留的正文'); await p.backToContents();
  p.refresh=async()=>{throw Error('网络暂时不可用');};
  p.persist=async()=>assert.fail('must not write from a stale baseline');
  await p.createChapter({currentTarget:{dataset:{}}});
  assert.equal(p.chapters.length,2);
  assert.match(p.data.saveNotice,/网络/);
  assert.equal(p.chapterManaging,false);
  assert.equal(stored.get(p.articleKey()).chapter.content[0].text,'保留的正文');
});

test('a second create tap during preparation cannot create a duplicate chapter', async()=>{
  const {p}=await setup(); let release!:()=>void;
  p.prepareChapterManagement=()=>new Promise<boolean>(resolve=>{release=()=>resolve(true);});
  let writes=0; p.persist=async(draft:any)=>{writes++;p.chapters=draft.chapters;return true;};
  const first=p.createChapter({currentTarget:{dataset:{}}});
  await p.createChapter({currentTarget:{dataset:{}}});
  release(); await first;
  assert.equal(writes,1); assert.equal(p.chapters.length,3);
});

test('a concurrently changed chapter order is shown without overwriting it with an old gesture', async()=>{
  const {p}=await setup(); await open(p,'a'); type(p,'本机草稿'); await p.backToContents(); p.windowWidth=375;
  p.refresh=async()=>{p.chapters=[...p.chapters].reverse();};
  p.persist=async()=>assert.fail('must ask for a new gesture on the latest order');
  p.startChapterDrag({currentTarget:{dataset:{id:'a'}},touches:[{clientY:100}]});
  p.moveChapterDrag({touches:[{clientY:180}]}); await p.endChapterDrag();
  assert.deepEqual(p.chapters.map((c:any)=>c.id),['b','a']);
  assert.match(p.data.saveNotice,/重新拖动/);
});
