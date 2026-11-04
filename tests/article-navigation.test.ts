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

test('editing a conflicting article clears stale saved notices and stays explicitly local', async () => {
  const {p,stored,requests} = await setup();
  await open(p,'a');
  p.articleConflict=true;
  p.setData({saveNotice:'修改已保存'});
  type(p,'冲突后新输入');
  assert.equal(p.data.saveNotice,'');
  assert.match(p.data.articleStatus,/仅存本机/);
  assert.doesNotMatch(p.data.articleStatus,/正在保存|已保存到云端/);
  assert.equal(stored.get(p.articleKey()).chapter.content[0].text,'冲突后新输入');
  assert.equal(await p.flushArticle(),false);
  assert.equal(requests.length,0);
});

test('article scrolling ends above the keyboard and restores its full height when dismissed', async () => {
  const {p} = await setup();
  await open(p,'a');
  p.fullWindowHeight=760;
  p.onKeyboardHeight({detail:{height:300}});
  assert.equal(p.data.viewportHeight,460,'the last paragraph must be scrollable above the IME');
  p.setData({xiaoyiOpen:true});
  p.updateViewport();
  assert.equal(p.data.viewportHeight,460,'the companion keeps its manually sized keyboard layout');
  p.onKeyboardHeight({detail:{height:0}});
  assert.equal(p.data.viewportHeight,760);
});

test('rapid title confirmations serialize saves and reopen with the newest title', async () => {
  const {p,page,stored,requests}=await setup();
  await open(p,'a');
  let finishFirst:any;
  (wx as any).cloud.callFunction=({data}:any)=>{
    requests.push(data);
    if(requests.length===1)return new Promise(resolve=>{finishFirst=()=>resolve({result:{revisionId:'revision-title-1',version:3}});});
    return Promise.resolve({result:{revisionId:'revision-title-2',version:4}});
  };
  const first=p.onArticleTitleBlur({detail:{value:'第一次改名'}});
  while(!finishFirst) await Promise.resolve();
  const second=p.onArticleTitleBlur({detail:{value:'最后确认的标题'}});
  finishFirst();
  assert.deepEqual(await Promise.all([first,second]),[true,true]);
  assert.equal(requests.length,2,'concurrent blur/confirm must not duplicate the next write');
  assert.equal(requests[1].chapter.title,'最后确认的标题');
  assert.equal(requests[1].expectedVersion,3);
  assert.equal(p.data.article.title,'最后确认的标题');
  assert.equal(stored.has(p.articleKey()),false);
  const reopened=page();reopened.chapters=p.chapters;await open(reopened,'a');
  assert.equal(reopened.data.article.title,'最后确认的标题');
});

test('title-only offline edit survives reopening and retries the same request', async () => {
  const {p,page,stored,requests}=await setup();await open(p,'a');
  (wx as any).cloud.callFunction=async({data}:any)=>{requests.push(data);throw Error('网络中断');};
  assert.equal(await p.onArticleTitleBlur({detail:{value:'离线输入的新标题'}}),false);
  const backup=stored.get(p.articleKey());
  assert.equal(backup.chapter.title,'离线输入的新标题');
  const reopened=page();await open(reopened,'a');
  assert.equal(reopened.data.article.title,'离线输入的新标题');
  (wx as any).cloud.callFunction=async({data}:any)=>{requests.push(data);return {result:{revisionId:'revision-title-retry',version:3}};};
  assert.equal(await reopened.onArticleTitleBlur({detail:{value:'离线输入的新标题'}}),true);
  assert.equal(requests[requests.length - 1].requestId,backup.attempt.requestId);
  assert.equal(reopened.data.article.title,'离线输入的新标题');
});

test('confirmed chapter rename updates the directory, manuscript and editing buffers together',async()=>{
  const {p}=await setup();await open(p,'a');
  p.data.draft={title:'书名',paragraphs:['原文a','原文b'],sourceCount:0,chapters:structuredClone(p.chapters)};
  (wx as any).cloud.callFunction=async()=>({result:{revisionId:'revision-title-saved',version:3}});
  await p.onArticleTitleBlur({detail:{value:'新的章节名'}});
  assert.equal(p.data.chapterRows[0].title,'新的章节名');
  assert.equal(p.data.draft.chapters[0].title,'新的章节名');
  assert.equal(p.chapterTitleBuffer,'新的章节名');
  await p.backToContents();assert.equal(p.data.chapterRows[0].title,'新的章节名');
});

test('unsynced chapter title appears in the directory with local-only status and never overwrites the saved manuscript',async()=>{
  const {p,page,stored}=await setup();await open(p,'a');
  assert.equal(await p.onArticleTitleBlur({detail:{value:'手机改过的章名'}}),false);
  await p.backToContents();
  assert.equal(p.data.chapterRows[0].title,'手机改过的章名');
  assert.equal(p.data.chapterRows[0].localOnly,true);
  assert.equal(p.chapters[0].title,'a','do not promote an unconfirmed edit to a saved draft');
  await open(p,'b');await p.backToContents();
  assert.equal(p.data.chapterRows[0].title,'手机改过的章名');
  const reopened=page();assert.equal(reopened.data.chapterRows[0].title,'手机改过的章名');
  assert.equal(stored.get(p.articleKey().replace(/:b$/,':a')).chapter.title,'手机改过的章名');
});


test('article caret scrolls only enough to show the active line and ignores an old chapter', async () => {
  const {p} = await setup(); await open(p,'a');
  p.data.keyboardHeight=300;
  p.createSelectorQuery=()=>({select(){return this;},fields(){return this;},exec(callback:any){callback([{top:60,bottom:460,scrollTop:800}]);}});
  p.onArticleCaret({detail:{chapterId:'a',top:438,bottom:470}});
  assert.equal(p.data.articleScrollTop,826);
  p.onArticleCaret({detail:{chapterId:'a',top:80,bottom:112}});
  assert.equal(p.data.articleScrollTop,826,'already visible text does not reset scroll or the caret');
  p.onArticleCaret({detail:{chapterId:'a',top:48,bottom:80}});
  assert.equal(p.data.articleScrollTop,772,'editing an earlier line scrolls up, not to paragraph end');
  p.onArticleCaret({detail:{chapterId:'old',top:700,bottom:732}});
  assert.equal(p.data.articleScrollTop,772);
});

test('late caret measurements cannot move the article after keyboard dismissal or newer input', async () => {
  const {p} = await setup(); await open(p,'a'); p.data.keyboardHeight=300;
  const callbacks:any[]=[];
  p.createSelectorQuery=()=>({select(){return this;},fields(){return this;},exec(callback:any){callbacks.push(callback);}});
  p.onArticleCaret({detail:{chapterId:'a',top:500,bottom:530}});
  p.onArticleCaret({detail:{chapterId:'a',top:430,bottom:460}});
  callbacks[1]([{top:60,bottom:460,scrollTop:800}]);
  assert.equal(p.data.articleScrollTop,816);
  callbacks[0]([{top:60,bottom:460,scrollTop:800}]);
  assert.equal(p.data.articleScrollTop,816);
  p.onArticleCaret({detail:{chapterId:'a',top:500,bottom:530}});
  p.onKeyboardHeight({detail:{height:0}});
  p.onKeyboardHeight({detail:{height:300}});
  callbacks[2]([{top:60,bottom:460,scrollTop:800}]);
  assert.equal(p.data.articleScrollTop,816);
});


test('manual scrolling and leaving the page cancel pending automatic caret scrolling', async () => {
  const {p} = await setup(); await open(p,'a'); p.data.keyboardHeight=300;
  const callbacks:any[]=[];
  p.createSelectorQuery=()=>({select(){return this;},fields(){return this;},exec(callback:any){callbacks.push(callback);}});
  for (const leave of [() => p.onArticleScroll({detail:{scrollTop:200}}), () => p.onHide(), () => p.onUnload()]) {
    p.onArticleCaret({detail:{chapterId:'a',top:500,bottom:530}});
    leave();
    callbacks[callbacks.length-1]([{top:60,bottom:460,scrollTop:800}]);
    assert.equal(p.data.articleScrollTop,200);
  }
});


const shareEvent = {currentTarget:{dataset:{destination:'family'}}};
function prepareSharing(p: any) {
  p.data.draft = {title:'验收故事',paragraphs:[],sourceCount:0,generatedAt:'',generationMode:'local-demo',chapters:p.chapters};
  p.data.savedRevisionId = p.revisionId;
  const urls: string[] = [];
  (wx as any).navigateTo = ({url,success}:any) => { urls.push(url); success(); };
  return urls;
}

test('sharing waits for every article save, including input typed while the first receipt is pending', async () => {
  const {p, requests} = await setup(); await open(p,'a'); const urls = prepareSharing(p);
  type(p,'第一份新正文'); p.onArticleTitle({detail:{value:'新章节名'}}); clearTimeout(p.articleTimer);
  const receipts: Array<(value:any)=>void> = [];
  (wx as any).cloud.callFunction=({data}:any)=>{requests.push(data);return new Promise(resolve=>receipts.push(resolve));};
  const pending = p.chooseSend(shareEvent);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(urls.length,0,'must not navigate with the previous saved revision');
  assert.equal(requests.length,1);
  type(p,'第二份完整正文');
  receipts[0]({result:{revisionId:'revision-first',version:3}});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(urls.length,0);
  assert.equal(requests.length,2);
  receipts[1]({result:{revisionId:'revision-final',version:4}});
  await pending;
  assert.equal(urls.length,1);
  assert.match(urls[0],/revisionId=revision-final&version=4/);
  assert.equal(p.chapters[0].title,'新章节名');
  assert.equal(p.chapters[0].content[0].text,'第二份完整正文');
  assert.equal(p.articlePending,null);
});

test('sharing a failed or conflicted article never falls back to the older cloud manuscript', async () => {
  for (const conflict of [false,true]) {
    const {p, stored}=await setup(); await open(p,'a'); const urls=prepareSharing(p);
    type(p,'只能留在本机的新正文'); p.articleConflict=conflict;
    (wx as any).cloud.callFunction=async()=>{throw Error('network unavailable');};
    await p.chooseSend(shareEvent);
    assert.deepEqual(urls,[]);
    assert.equal(stored.get(p.articleKey()).chapter.content[0].text,'只能留在本机的新正文');
    assert.match(p.data.saveNotice,/同步|保存/);
  }
});

test('whole-book sharing checks unsynced drafts in chapters other than the current one', async () => {
  const {p,stored}=await setup(); await open(p,'b'); const urls=prepareSharing(p);
  stored.set(p.articleKey('a'),{revisionId:'revision-old',conflict:true,chapter:{...p.chapters[0],title:'未同步的新标题'}});
  await p.chooseSend(shareEvent);
  assert.deepEqual(urls,[]);
  assert.match(p.data.saveNotice,/未同步的新标题/);
  assert.ok(stored.has(p.articleKey('a')));
});

test('send from contents opens the book menu even after reading an article', async () => {
  const {p}=await setup(); await open(p,'a'); await p.backToContents();
  let book=0, article=0;
  p.toggleSend=()=>{book++;}; p.sendArticle=async()=>{article++;};
  p.sendCurrentArticle();
  assert.equal(book,1); assert.equal(article,0);
});
