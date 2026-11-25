import assert from 'node:assert/strict';
import test from 'node:test';
import { articleChapter } from '../miniprogram/services/articleModules';
import { clearAiConsent } from '../miniprogram/services/aiConsent';
import { createDemoRoomStateForTests } from './fixtures';
import { current } from '../miniprogram/domain/storyBookCore';

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
    showToast() {}, disableAlertBeforeUnload() {}, hideKeyboard() {},
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
    p.loadArticleRecovery=async()=>{throw Error('暂时无法读取历史书稿，修改已保留');};
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

test('chat sentence edits can be reviewed, rejected, accepted and reopened without changing the other section', async () => {
  const {p, page, requests} = await setup();
  const before = '那一下，我看见了，也记住了。';
  const after = '那一下，我一直记得。';
  const wechat = '爸，今天你把伞往我这边挪，我看见啦。';
  const content = '## 书稿\n那天下雨，爸爸来车站接我。\n' + before + '\n\n## 给爸爸的微信\n' + wechat;
  p.chapters[0] = articleChapter({ id:'a', title:'车站的两把伞', content:[{text:content}], memoryIds:[] });
  p.selectComponent = () => undefined;
  let savedChapter = p.chapters[0];
  (wx as any).cloud.callFunction = async ({name,data}:any) => {
    assert.equal(name,'storyBooks');
    assert.equal(data.action,'articleSave');
    requests.push(data);
    savedChapter = data.chapter;
    return {result:{revisionId:'revision-accepted',version:3}};
  };
  await open(p,'a');
  await p.openXiaoyi();
  const send = async () => {
    p.onXiaoyiAnswerInput({detail:{value:`把书稿最后一句改成『${after}』`}});
    await p.askXiaoyiQuestion();
    const id = p.data.xiaoyiMessages.at(-1).id;
    p.openSentenceReview({currentTarget:{dataset:{id}}});
    assert.equal(p.data.sentenceReview.before,before);
    assert.equal(p.data.sentenceReview.after,after);
    assert.match(p.data.sentenceReview.suffix, /给爸爸的微信/);
  };
  await send();
  await p.rejectSentenceEdit();
  assert.equal(p.data.xiaoyiMessages.at(-1).sentenceEdit.status, 'rejected');
  assert.equal(p.data.article.content[0].text, content);
  assert.equal(requests.length, 0);
  await send();
  await p.acceptSentenceEdit();
  const expected = content.replace(before,after);
  assert.equal(p.data.article.content[0].text, expected);
  assert.equal(requests.length,1);
  assert.equal(savedChapter.content[0].text,expected);

  const reopened = page();
  reopened.chapters[0] = savedChapter;
  reopened.story = {...reopened.story, version:3, currentRevisionId:'revision-accepted'};
  reopened.revisionId = 'revision-accepted';
  await open(reopened,'a');
  await reopened.openXiaoyi();
  assert.equal(reopened.data.article.content[0].text,expected);
  assert.deepEqual(reopened.data.xiaoyiMessages.flatMap((item:any)=>item.sentenceEdit?.status || []), ['rejected','accepted']);
});

test('a suggestion cannot overwrite newer unsaved text in its source block', async () => {
  const {p,requests} = await setup();
  p.chapters[0] = articleChapter({id:'a',title:'书稿',content:[{text:'原来的一句。'}],memoryIds:[]});
  await open(p,'a');
  await p.openXiaoyi();
  p.onXiaoyiAnswerInput({detail:{value:'把最后一句改成「建议改法。」'}});
  await p.askXiaoyiQuestion();
  const id = p.data.xiaoyiMessages.at(-1).id;
  type(p,'我已经手动改了这一句。');
  p.openSentenceReview({currentTarget:{dataset:{id}}});
  assert.equal(p.data.sentenceReview,null);
  assert.equal(p.data.xiaoyiMessages.at(-1).sentenceEdit.status,'stale');
  assert.equal(p.articlePending.content[0].text,'我已经手动改了这一句。');
  assert.equal(requests.length,0);
});

test('article chat keeps long manuscript context, revises the preceding suggestion and restores the adopted edit', async t => {
  const {p, page, stored, requests} = await setup();
  const oldApp = (globalThis as any).getApp;
  (globalThis as any).getApp = () => ({globalData:{aiReady:true,cloudReady:true}});
  clearAiConsent();
  stored.set('aiConsentDecision',{granted:true,version:1});
  t.after(() => {clearAiConsent(); (globalThis as any).getApp = oldApp;});
  const opening = '爸爸到车站接我的那天，雨落得又细又密。他提着两把伞，见了面又把手里的伞朝我这边挪了一点。';
  const early = '那天下雨，爸爸来车站接我，还把伞往我这里挪。';
  const rewritten = '那天爸到车站来接我，又把伞往我这边挪了挪。';
  const closing = '再经过车站的那天，雨落得又细又密。入口旁的人也打着伞。';
  const wechat = '爸，今天你把伞往我这边挪，我看见啦。';
  const filler = Array.from({length:85}, (_, i) => `第${i + 1}段。窗外灯亮着，街上有人撑伞回家。`.repeat(6)).join('\n');
  p.chapters[0] = articleChapter({id:'a',title:'车站的两把伞',memoryIds:[],content:[
    {text:'书稿\n'+opening},{text:filler},{text:closing},{text:'给爸爸的微信（原样保留）\n'+wechat},
  ]});
  let savedChapter = p.chapters[0];
  const calls: any[] = [];
  (wx as any).cloud.callFunction = async ({name,data}:any) => {
    if (name === 'storyBooks') {
      requests.push(data);
      savedChapter = data.chapter;
      return {result:{revisionId:'revision-long-3',version:3}};
    }
    assert.equal(name,'chatInterview');
    assert.equal(data.action,'articleTurn');
    const {sourceText,articleWriting,answer} = data.input;
    const all = articleWriting.paragraphs.map((p:any)=>sourceText.slice(p.start,p.end));
    const start = all.indexOf(opening);
    const end = all.indexOf(closing);
    calls.push({...data.input, all});
    assert.ok(sourceText.includes('第43段') && sourceText.includes(closing) && sourceText.includes(wechat));
    assert.equal(articleWriting.paragraphs[all.indexOf(wechat)].editable,false);
    let decision;
    if (answer === '前面写车站的那段收短一点') {
      assert.equal(articleWriting.revisionId,'revision-new');
      decision = {kind:'edit',target:start,start:0,end:opening.length,replacement:early};
    } else if (answer === '把刚才那段再改得口语一点') {
      assert.equal(articleWriting.recent.target,start);
      assert.equal(articleWriting.recent.draft,early);
      decision = {kind:'edit',target:start,start:0,end:opening.length,replacement:rewritten};
    } else if (articleWriting.chosen !== undefined) {
      assert.equal(articleWriting.chosen,end);
      decision = {kind:'edit',target:end,start:0,end:closing.length,replacement:'后来路过车站，那天下着细雨。'};
    } else {
      assert.equal(articleWriting.revisionId,'revision-long-3');
      assert.equal(articleWriting.recent.draft,rewritten);
      decision = {kind:'clarify',targets:[all.indexOf(rewritten),end]};
    }
    return {result:{turnId:data.turnId,status:'ready',reply:'小忆的建议',decision}};
  };
  const send = async (instance:any, value:string) => {
    instance.onXiaoyiAnswerInput({detail:{value}});
    await instance.askXiaoyiQuestion();
    return instance.data.xiaoyiMessages.at(-1);
  };
  await open(p,'a');
  await p.openXiaoyi();
  p.selectComponent = () => undefined;
  const first = await send(p,'前面写车站的那段收短一点');
  assert.equal(first.sentenceEdit.before,opening);
  assert.equal(first.sentenceEdit.after,early);
  assert.equal(requests.length,0);
  const next = await send(p,'把刚才那段再改得口语一点');
  assert.equal(next.sentenceEdit.before,opening);
  assert.equal(next.sentenceEdit.after,rewritten);
  p.openSentenceReview({currentTarget:{dataset:{id:next.id}}});
  await p.acceptSentenceEdit();
  assert.equal(requests.length,1);
  assert.deepEqual(savedChapter.content.map((b:any)=>b.text),['书稿\n'+rewritten,filler,closing,'给爸爸的微信（原样保留）\n'+wechat]);

  const reopened = page();
  reopened.chapters[0] = savedChapter;
  reopened.story = {...reopened.story,version:3,currentRevisionId:'revision-long-3'};
  reopened.revisionId = 'revision-long-3';
  await open(reopened,'a');
  await reopened.openXiaoyi();
  assert.equal(reopened.data.xiaoyiMessages.find((m:any)=>m.id===next.id).sentenceEdit.status,'accepted');
  const ask = await send(reopened,'车站那段再收短一些');
  assert.deepEqual(ask.writingChoices.items.map((item:any)=>item.excerpt),[rewritten,closing]);
  await reopened.chooseArticleWritingPassage({currentTarget:{dataset:{id:ask.id,choice:1}}});
  const selected = reopened.data.xiaoyiMessages.at(-1).sentenceEdit;
  assert.equal(selected.before,closing);
  assert.equal(calls.length,4);
  assert.equal(requests.length,1,'selecting an excerpt prepares a suggestion and does not save');
});

test('messy notes become a draft, then an exact two-section local story after the user confirms', async t => {
  const {p, page, stored} = await setup();
  const oldApp = (globalThis as any).getApp;
  (globalThis as any).getApp = () => ({globalData:{aiReady:true,cloudReady:true}});
  clearAiConsent();
  stored.set('aiConsentDecision',{granted:true,version:1});
  t.after(() => {clearAiConsent(); (globalThis as any).getApp = oldApp;});
  const final = '那天下雨，爸爸来车站接我。他带了两把伞，见面后，还是把他那把往我这边挪了挪。';
  const verbatim = '爸，今天你把伞往我这边挪，我看见啦。';
  const notes = '零散笔记\n下雨，爸爸来车站接我。两把伞。爸爸把他撑的那把往我这里挪。\n\n'
    + '旧稿：他递给我一把，我们并肩走着。\n这两处我记不清。\n\n'
    + '重复记录：' + '雨天和车站是我确定记得的事。'.repeat(50) + '\n\n'
    + '留给爸爸的微信（定稿）：' + verbatim;
  const rough = final + '那一下，我看见了，也记住了。';
  const responses = [
    {reply:'我先把这些笔记收着。'},
    {reply:'记得的事：下雨，爸爸到车站接你，带了两把伞。\n旧稿里还拿不准的：递伞、并肩走。\n已经定下来的微信：'+verbatim},
    {reply:rough,decision:{kind:'draft',label:'书稿'}},
    {reply:final,decision:{kind:'draft',label:'书稿'}},
  ];
  const calls:any[] = [];
  (wx as any).cloud.callFunction = async ({name,data}:any) => {
    assert.equal(name,'chatInterview');
    calls.push(data.input);
    return {result:{turnId:data.turnId,status:'ready',...responses[calls.length - 1]}};
  };
  const send = async (instance:any, value:string) => {
    instance.onXiaoyiAnswerInput({detail:{value}});
    await instance.askXiaoyiQuestion();
    return instance.data.xiaoyiMessages.at(-1);
  };
  await open(p,'a');
  await p.openXiaoyi();
  await send(p,notes);
  assert.equal(calls[0].answer,notes);
  assert.match((await send(p,'帮我理一下')).text,/拿不准/);
  assert.equal(calls[1].conversation[0].text,notes);
  assert.equal((await send(p,'帮我把车站那天的事写出来')).text,rough);
  assert.equal((await send(p,'我想把这段放进书里。读到爸爸把伞往我这边挪了挪，就可以停了')).articleDraftLabel,'书稿');
  assert.equal(calls[3].conversation.at(-1).text,rough);
  const original = createDemoRoomStateForTests();
  original.storyMigration = {version:1,status:'active',pending:[]};
  original.stories = [];
  original.manuscriptRevisions = [];
  stored.set('shiguang-family-room-v5',original);
  delete (wx as any).cloud;
  const nav:string[] = [];
  (wx as any).navigateTo = ({url}:any) => nav.push(url);
  const command = '这版就定了。帮我建一份叫《车站的两把伞》的文档，把刚才的书稿和之前定下来的那条微信分开放进去，两段都按原话保存';
  const result = await send(p,command);
  assert.equal(calls.length,4,'saving calls no writing model');
  const {storyId} = result.writingDocument;
  const saved = current(stored.get('shiguang-family-room-v5'),storyId).draft!;
  assert.equal(saved.introduction,'');
  assert.deepEqual(saved.chapters!.map(section=>[section.title,section.content[0].text]),[['书稿',final],['留给爸爸的微信',verbatim]]);
  assert.equal(p.data.article.content[0].text,'原文a');
  await send(p,command);
  assert.equal(stored.get('shiguang-family-room-v5').stories.length,1);
  const reopened = page();
  await open(reopened,'a');
  await reopened.openXiaoyi();
  reopened.openArticleDocument({currentTarget:{dataset:{id:result.id}}});
  assert.equal(nav[nav.length - 1],'/pages/book/book?storyId='+storyId);
});

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
  assert.match(p.data.articleStatus,/留在本机/);
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
  p.createSelectorQuery=()=>({select(){return this;},fields(){return this;},boundingClientRect(){return this;},exec(callback:any){callback([{top:60,bottom:460,scrollTop:800}]);}});
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
  p.createSelectorQuery=()=>({select(){return this;},fields(){return this;},boundingClientRect(){return this;},exec(callback:any){callbacks.push(callback);}});
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
  p.createSelectorQuery=()=>({select(){return this;},fields(){return this;},boundingClientRect(){return this;},exec(callback:any){callbacks.push(callback);}});
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
    assert.match(p.data.saveNotice,/同步|保存|保留|network unavailable/);
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

test('a legacy conflict caused by another chapter changing automatically saves on exit', async () => {
  const {p,stored}=await setup();
  const base=structuredClone(p.chapters);
  const draft=(chapters:any[])=>({title:'满城',paragraphs:[],sourceCount:0,generatedAt:'',generationMode:'local-demo',chapters});
  p.chapters[1]={...p.chapters[1],title:'另一章新名字'};
  p.data.draft=draft(p.chapters);
  stored.set(p.articleKey('a'),{revisionId:'revision-old',storyVersion:1,conflict:true,
    chapter:{...base[0],title:'解放'}});
  const writes:any[]=[];
  p.loadArticleRecovery=async()=>({story:p.story,draft:draft(p.chapters),base:draft(base)});
  (wx as any).cloud.callFunction=async({data}:any)=>{
    assert.equal(data.action,'articleSave');writes.push(data);
    return {result:{revisionId:'revision-recovered',version:3}};
  };
  await open(p,'a');await p.backToContents();
  assert.equal(writes.length,1);
  assert.equal(writes[0].expectedVersion,2);
  assert.equal(writes[0].revisionId,'revision-new');
  assert.equal(p.chapters[0].title,'解放');
  assert.equal(p.chapters[1].title,'另一章新名字');
  assert.equal(stored.has(p.articleKey('a')),false);
  assert.equal(p.data.chapterRows[0].localOnly,false);
});

test('typing during conflict recovery is included in the automatically retried save',async()=>{
 const {p,stored,requests}=await setup();const base=structuredClone(p.chapters);
 stored.set(p.articleKey('a'),{revisionId:'revision-old',storyVersion:1,conflict:true,chapter:{...base[0],title:'解放'}});
 await open(p,'a');let release:any;
 p.loadArticleRecovery=()=>new Promise(resolve=>{release=()=>resolve({story:p.story,draft:{title:'满城',chapters:p.chapters},base:{chapters:base}});});
 (wx as any).cloud.callFunction=async({data}:any)=>{requests.push(data);return {result:{revisionId:'revision-recovered',version:3}};};
 const saving=p.flushArticle();while(!release)await Promise.resolve();
 type(p,'恢复期间继续写的最后一句');release();
 assert.equal(await saving,true);
 assert.equal(requests[0].chapter.title,'解放');assert.equal(requests[0].chapter.content[0].text,'恢复期间继续写的最后一句');
 assert.equal(stored.has(p.articleKey()),false);
});

test('whole-book sharing automatically saves a closed chapter and uses its new revision',async()=>{
 const {p,stored,requests}=await setup();const base=structuredClone(p.chapters);
 await open(p,'b');const urls=prepareSharing(p);
 stored.set(p.articleKey('a'),{revisionId:'revision-old',storyVersion:1,conflict:true,chapter:{...base[0],title:'解放'}});
 let remote={story:p.story,draft:p.data.draft,base:{chapters:base}};
 p.loadArticleRecovery=async()=>remote;
 (wx as any).cloud.callFunction=async({data}:any)=>{
   requests.push(data);remote={...remote,story:{...p.story,version:3,currentRevisionId:'revision-background'},draft:{...p.data.draft,chapters:p.chapters.map((c:any)=>c.id===data.chapter.id?data.chapter:c)}};
   return {result:{revisionId:'revision-background',version:3}};
 };
 p.refresh=async()=>{p.story=remote.story;p.revisionId=remote.story.currentRevisionId;p.chapters=remote.draft.chapters;p.setData({draft:remote.draft,savedRevisionId:p.revisionId,...p.chapterData()});};
 await p.chooseSend(shareEvent);
 assert.equal(requests.length,1);assert.equal(urls.length,1);assert.match(urls[0],/revisionId=revision-background&version=3/);
 assert.equal(p.activeChapterId,'b');assert.equal(p.data.chapterRows[0].title,'解放');assert.equal(p.data.chapterRows[0].localOnly,false);
 assert.equal(stored.has(p.articleKey('a')),false);
});

test('an old acknowledged request cannot roll the directory back from a newer loaded revision',async()=>{
 const {p,stored}=await setup();const base=structuredClone(p.chapters),attempt={requestId:'request-old',storyId:p.story.id,revisionId:'revision-start',expectedVersion:1,chapter:{...base[0],title:'已保存过的名字'}};
 stored.set(p.articleKey('a'),{revisionId:'revision-start',storyVersion:1,chapter:attempt.chapter,attempt});
 p.story={...p.story,version:4,currentRevisionId:'revision-four'};p.revisionId='revision-four';p.chapters[0]={...base[0],title:'之后改过的名字'};
 p.loadArticleRecovery=async()=>({story:p.story,draft:{title:'满城',chapters:p.chapters},base:{chapters:[attempt.chapter,base[1]]}});
 (wx as any).cloud.callFunction=async()=>({result:{revisionId:'revision-accepted',version:2}});
 await open(p,'a');assert.equal(await p.flushArticle(),true);
 assert.equal(p.story.version,4);assert.equal(p.revisionId,'revision-four');assert.equal(p.data.article.title,'之后改过的名字');
 assert.equal(stored.has(p.articleKey('a')),false);
});

test('returning to the page automatically retries a pending offline article without another save tap',async()=>{
 const {p,stored,requests}=await setup();await open(p,'a');type(p,'断网时写下的完整正文');
 (wx as any).cloud.callFunction=async({data}:any)=>{requests.push(data);return {result:{revisionId:'revision-online',version:3}};};
 p.onShow();assert.ok(p.bookSyncing);await p.bookSyncing;
 assert.equal(requests.length,1);assert.equal(p.articlePending,null);assert.equal(stored.has(p.articleKey()),false);
 assert.equal(p.chapters[0].content[0].text,'断网时写下的完整正文');
});

test('a rejected article request does not pin later corrected text to its old payload', async () => {
  const {p,stored,requests}=await setup();
  (wx as any).cloud.callFunction=async ({data}:any)=>{
    requests.push(data);
    return data.chapter.content[0].text==='第一份待修改的原稿'
      ? {result:{error:'STORY_BOOK_ERROR',code:'CONTENT_REJECTED',message:'文字未通过内容检查'}}
      : {result:{revisionId:'revision-corrected',version:3}};
  };
  await open(p,'a'); type(p,'第一份待修改的原稿');
  assert.equal(await p.flushArticle(),false);
  type(p,'用户已经改好的最新文字');
  assert.equal(await p.flushArticle(),true);
  assert.equal(requests[requests.length-1].chapter.content[0].text,'用户已经改好的最新文字');
  assert.notEqual(requests[requests.length-1].requestId,requests[0].requestId);
  assert.equal(stored.has(p.articleKey()),false);
});


test('new input during a rejection is saved automatically while unchanged review stays local',async()=>{
 const {p,stored,requests}=await setup();await open(p,'a');type(p,'等待检测的原稿');
 let release:any;
 (wx as any).cloud.callFunction=async({data}:any)=>{
   requests.push(data);
   if(requests.length===1)return new Promise(resolve=>{release=()=>resolve({result:{error:'STORY_BOOK_ERROR',code:'MODERATION_REVIEW',message:'需复核'}});});
   return {result:{revisionId:'revision-latest',version:3}};
 };
 const saving=p.flushArticle();while(!release)await Promise.resolve();type(p,'检测期间继续写的最新稿');release();
 assert.equal(await saving,true);assert.equal(requests.length,2);assert.equal(requests[1].chapter.content[0].text,'检测期间继续写的最新稿');
 assert.notEqual(requests[0].requestId,requests[1].requestId);assert.equal(stored.has(p.articleKey()),false);
 type(p,'仍需复核的稿子');let rejectedCalls=0;
 (wx as any).cloud.callFunction=async()=>{rejectedCalls++;return {result:{error:'STORY_BOOK_ERROR',code:'MODERATION_REVIEW',message:'需复核'}};};
 assert.equal(await p.flushArticle(),false);assert.equal(rejectedCalls,1);assert.equal(p.articleAttempt,null);
 assert.equal(stored.get(p.articleKey()).chapter.content[0].text,'仍需复核的稿子');
 assert.match(p.data.articleStatus,/需复核/);
});

test('leaving after moderation review keeps the real cause instead of promising a network fix',async()=>{
 const {p,stored}=await setup();await open(p,'a');type(p,'本机完整原稿');
 (wx as any).cloud.callFunction=async()=>({result:{error:'STORY_BOOK_ERROR',code:'MODERATION_REVIEW',message:'内容检查返回需复核，暂未同步'}});
 assert.equal(await p.finishArticleNavigation(),true);
 assert.match(p.data.saveNotice,/需复核/);
 assert.doesNotMatch(p.data.saveNotice,/恢复联网|重新打开时会自动保存/);
 assert.equal(stored.get(p.articleKey()).chapter.content[0].text,'本机完整原稿');
});


test('opening WeChat sharing dismisses the old claim sheet so another send prepares a fresh card', async () => {
  const {p}=await setup(); await open(p,'a');
  const token='A'.repeat(43);
  p.setData({articleShareUrl:`https://www.drinkingtime.top/chapter/claim/${token}`,articleShareTitle:'最新标题',articleShareRevision:p.revisionId,articleShareChapterId:p.activeChapterId});
  const message=p.onShareAppMessage({from:'button',target:{dataset:{chapterShare:true}}});
  assert.equal(message.title,'最新标题');
  assert.equal(message.path,`/pages/book/book?chapterClaim=${token}`);
  assert.equal(p.data.articleShareUrl,'');
  let sends=0;
  p.sendArticle=async()=>{sends++;};
  p.sendCurrentArticle();
  assert.equal(sends,1);
});

test('full article media waits for actual save acknowledgment and fixes complete source and options',async()=>{
 const {p,stored,requests}=await setup();await open(p,'a');
 p.selectComponent=()=>({dismissKeyboard(){}});
 p.data.article=articleChapter({...p.data.article,content:[{text:'第一段'},{text:'第二段'}]});p.chapters[0]=p.data.article;
 p.data.mediaSelectedBlock=p.data.article.content[1].blockId;
 p.openArticleMediaPanel({currentTarget:{dataset:{kind:'music'}}});
 assert.equal(p.data.mediaPanelText,'第一段\n\n第二段');
 type(p,'最新第一段');let release:any;let task:any;
 (wx as any).cloud.callFunction=async({data}:any)=>{requests.push(data);return new Promise(resolve=>{release=resolve;});};
 p.processArticleMedia=async(t:any)=>{task=structuredClone(t);};
 const pending=p.generateArticleMedia({currentTarget:{dataset:{kind:'music'}}});
 while(!release)await new Promise(resolve=>setImmediate(resolve));
 assert.equal(Boolean(task),false);release({result:{revisionId:'revision-confirmed',version:3}});await pending;
 assert.equal(task.scope,'chapter');assert.equal(task.text,'最新第一段\n\n第二段');assert.equal(task.revisionId,'revision-confirmed');
 assert.equal(task.blockId,p.data.article.content[0].blockId);assert.equal(stored.get(p.mediaTaskKey())[0].requestId,task.requestId);
});
test('image requirements and phone references are frozen into the durable task without adding manuscript photos',async()=>{
 const {p}=await setup();await open(p,'a');p.selectComponent=()=>({dismissKeyboard(){}});
 p.data.mediaSelectedBlock=p.data.article.content[0].blockId;p.openArticleMediaPanel({currentTarget:{dataset:{kind:'image'}}});
 p.onMediaArtDirection({detail:{value:'暖色水彩'}});p.data.mediaReferences=[{id:'photo-reference',path:'/local/ref.jpg'}];
 let task:any;p.processArticleMedia=async(t:any)=>{task=structuredClone(t);};
 await p.generateArticleMedia({currentTarget:{dataset:{kind:'image'}}});
 assert.equal(task.artDirection,'暖色水彩');assert.deepEqual(task.referencePhotoIds,['photo-reference']);assert.deepEqual(task.phoneReferencePhotoIds,['photo-reference']);
 assert.equal(p.data.article.content.some((b:any)=>b.photoId==='photo-reference'),false);
 p.openArticleMediaPanel({currentTarget:{dataset:{kind:'music'}}});assert.equal(p.data.mediaArtDirection,'');assert.deepEqual(p.data.mediaReferences,[]);
});
test('failed save exposes its actual conflict and never submits media',async()=>{
 const {p}=await setup();await open(p,'a');type(p,'本机修改');p.loadArticleRecovery=async()=>{throw new Error('同一段在两处修改，请核对');};
 p.processArticleMedia=async()=>assert.fail('must not generate from an unsaved version');
 await p.generateArticleMedia({currentTarget:{dataset:{kind:'narration'}}});
 assert.match(p.data.mediaStatus,/同一段在两处修改/);assert.equal(p.articlePending.content[0].text,'本机修改');
});

test('reference picker survives native hide and cancel without changing manuscript or losing requirements',async()=>{
 const {p}=await setup();await open(p,'a');p.selectComponent=()=>({dismissKeyboard(){}});
 p.data.mediaSelectedBlock=p.data.article.content[0].blockId;p.openArticleMediaPanel({currentTarget:{dataset:{kind:'image'}}});
 p.onMediaArtDirection({detail:{value:'保留暖色'}});const before=JSON.stringify(p.data.article);let cancel:any;
 (wx as any).chooseMedia=({fail}:any)=>{cancel=fail;};
 const pending=p.addMediaReference();assert.equal(p.data.mediaPickingReference,true);p.onHide();
 assert.equal(p.data.mediaPanelKind,'image');cancel({errMsg:'chooseMedia:fail cancel'});await pending;
 assert.equal(p.data.mediaPickingReference,false);assert.equal(p.data.mediaPanelNotice,'');assert.equal(p.data.mediaArtDirection,'保留暖色');assert.equal(JSON.stringify(p.data.article),before);
});

test('inline audio reflects playback events and resumes without requesting a new URL',async t=>{
  const {p}=await setup();p.data.view='chapter';p.data.storyId='story-test';p.flushArticle=async()=>true;
  const handlers:Record<string,()=>void>={};let requests=0,plays=0,destroyed=0;
  const player={src:'',paused:true,destroy(){destroyed++;},play(){plays++;this.paused=false;handlers.play();},pause(){this.paused=true;handlers.pause();},onPlay(fn:()=>void){handlers.play=fn;},onPause(fn:()=>void){handlers.pause=fn;},onEnded(fn:()=>void){handlers.ended=fn;},onError(fn:()=>void){handlers.error=fn;}};
  const old=(globalThis as any).wx;
  (globalThis as any).wx={...old,createInnerAudioContext:()=>player,cloud:{callFunction:async()=>{requests++;return {result:{url:'https://example.test/audio.wav'}};}}};
  t.after(()=>{(globalThis as any).wx=old;});
  const event={currentTarget:{dataset:{id:'audio-module'}}};
  await p.playArticleAudio(event);assert.equal(p.data.mediaAudioState,'playing');
  await p.playArticleAudio(event);assert.equal(p.data.mediaAudioState,'paused');
  await p.playArticleAudio(event);assert.equal(p.data.mediaAudioState,'playing');assert.equal(requests,1);assert.equal(plays,2);
  p.releaseArticleAudio();handlers.play();assert.equal(p.data.mediaAudioState,'idle');assert.equal(destroyed,1);
});

test('leaving inline audio while its URL loads prevents stale playback',async t=>{
  const {p}=await setup();p.data.view='chapter';p.data.storyId='story-test';p.flushArticle=async()=>true;
  let resolve:any,created=0;const old=(globalThis as any).wx;
  (globalThis as any).wx={...old,createInnerAudioContext:()=>{created++;throw Error('stale playback');},cloud:{callFunction:()=>new Promise(r=>{resolve=r;})}};
  t.after(()=>{(globalThis as any).wx=old;});
  const running=p.playArticleAudio({currentTarget:{dataset:{id:'audio-module'}}});await Promise.resolve();
  p.releaseArticleAudio();resolve({result:{url:'https://example.test/audio.wav'}});await running;
  assert.equal(created,0);assert.equal(p.data.mediaAudioState,'idle');
});
