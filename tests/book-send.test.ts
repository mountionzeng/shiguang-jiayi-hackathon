import assert from 'node:assert/strict';
import test from 'node:test';
import { snapshotFromState, selectSendText, SendSelection } from '../miniprogram/services/bookSend';
import { createDemoRoomStateForTests } from './fixtures';
import { makeRevision } from '../miniprogram/services/manuscript';
import { draftWithChapters } from '../miniprogram/services/chapters';

function fixture() {
  const state = createDemoRoomStateForTests();
  const draft = draftWithChapters({ title: '全书', paragraphs: [], sourceCount: 0, generatedAt: '', generationMode: 'local-demo' }, [
    { id: 'chapter-one', title: '第一段日子', memoryIds: [], content: [{ text: '原文🌿\n\n下一段' }, { photoId: 'photo-private' }, { text: '图片后面的字' }] },
    { id: 'chapter-two', title: '第二段日子', memoryIds: [], content: [{ text: '第二章全文，不可丢失。' }] },
  ]);
  const revision = { ...makeRevision('owner', draft, '', 'draft', '已保存'), storyId: 'story-test' };
  state.manuscriptRevisions = [revision];
  state.stories = [{ id: 'story-test', familyId: 'family-test', title: '全书', currentRevisionId: revision.id, version: 3,
    protagonistMemberIds: [], memoryIds: [], createdAt: '', updatedAt: '' }];
  return { state, expected: { storyId: 'story-test', revisionId: revision.id, version: 3 } };
}
const selection: SendSelection = { scope: 'book', chapterIds: [], textChapterId: '', text: '' };

test('整书预览保留完整正文和空行，不自动加入私密照片', () => {
  const { state, expected } = fixture();
  const snapshot = snapshotFromState(state, expected, 'account-a');
  const result = selectSendText(snapshot, selection);
  assert.equal(result.length, 2);
  assert.equal(result[0].text, '原文🌿\n\n下一段\n图片后面的字');
  assert.equal(result[1].text, '第二章全文，不可丢失。');
  assert.equal(JSON.stringify(result).includes('photo-private'), false);
  result[0].text = '修改预览对象';
  assert.match(snapshot.chapters[0].text, /^原文/);
  assert.match(state.manuscriptRevisions![0].draft.chapters![0].content[0].text!, /^原文/);
});

test('章节多选保留书稿顺序，重复ID不重复正文，未知章节不能静默丢弃', () => {
  const { state, expected } = fixture(), snapshot = snapshotFromState(state, expected, 'a');
  assert.deepEqual(selectSendText(snapshot, { ...selection, scope: 'chapters', chapterIds: ['chapter-two', 'chapter-one', 'chapter-two'] }).map(c => c.id), ['chapter-one', 'chapter-two']);
  assert.throws(() => selectSendText(snapshot, { ...selection, scope: 'chapters', chapterIds: ['missing'] }), /重新选择/);
});

test('直接选段必须属于当前保存原文，不接受改写文本或其他章节文字', () => {
  const { state, expected } = fixture(), snapshot = snapshotFromState(state, expected, 'a');
  const input = { ...selection, scope: 'text' as const, textChapterId: 'chapter-one', text: '🌿\n\n下一段' };
  assert.equal(selectSendText(snapshot, input)[0].text, input.text);
  assert.equal(selectSendText(snapshot, input)[0].characterCount, Array.from(input.text).length);
  assert.throws(() => selectSendText(snapshot, { ...input, text: '伪造正文' }), /原文/);
  assert.throws(() => selectSendText(snapshot, { ...input, textChapterId: 'chapter-two' }), /原文/);
});

test('版本更新、删除和受保护副本不能进入发送快照', () => {
  const { state, expected } = fixture();
  assert.throws(() => snapshotFromState(state, { ...expected, version: 2 }, 'a'), /更新/);
  assert.throws(() => snapshotFromState(state, { ...expected, revisionId: 'old' }, 'a'), /更新/);
  state.stories![0].sourcePolicyRequired = true;
  assert.throws(() => snapshotFromState(state, expected, 'a'), /副本/);
  state.stories![0].sourcePolicyRequired = false; state.stories![0].deletedAt = 'today';
  assert.throws(() => snapshotFromState(state, expected, 'a'), /无法读取/);
});

type PageDefinition = Record<string, any>;
let book: PageDefinition;
async function bookPage() {
  if (!book) {
    (globalThis as any).Page = (value: PageDefinition) => { book = value; };
    await import('../miniprogram/pages/book/book');
  }
  const page: PageDefinition = { ...book, data: structuredClone(book.data), story: { id: 'story-test', version: 3 } };
  page.setData = (patch: PageDefinition) => Object.assign(page.data, patch);
  Object.assign(page.data, { view: 'contents', draft: {}, savedRevisionId: 'revision-before' });
  return page;
}
const sendEvent = (destination = 'social') => ({ currentTarget: { dataset: { destination } } });

test('发送等保存完成后用新版本跳转，重复点击只开一次', async () => {
  const page = await bookPage();
  let saved!: (success: boolean) => void;
  page.finishEditing = () => new Promise<boolean>(resolve => { saved = resolve; });
  const urls: string[] = [];
  (globalThis as any).wx = { navigateTo: ({ url, success }: any) => { urls.push(url); success(); } };
  const first = page.chooseSend(sendEvent());
  await page.chooseSend(sendEvent());
  assert.equal(urls.length, 0);
  page.data.savedRevisionId = 'revision-after'; page.story.version = 4;
  saved(true); await first;
  assert.equal(urls.length, 1);
  assert.match(urls[0], /social\/index\?storyId=story-test&revisionId=revision-after&version=4$/);
  assert.equal(page.data.preparingSend, false);
});

test('保存失败保留编辑页与正文，不启动任何发送', async () => {
  const page = await bookPage(); let calls = 0;
  page.bodyBuffer = '尚未保存的完整正文'; page.data.editing = true;
  page.finishEditing = async () => false;
  (globalThis as any).wx = { navigateTo: () => { calls++; } };
  await page.chooseSend(sendEvent('family'));
  assert.equal(calls, 0); assert.equal(page.bodyBuffer, '尚未保存的完整正文'); assert.equal(page.data.editing, true);
});

test('离页或切章后到达的保存回执不再跳转', async () => {
  const page = await bookPage(); let saved!: (value: boolean) => void, calls = 0;
  page.finishEditing = () => new Promise(resolve => { saved = resolve; });
  (globalThis as any).wx = { navigateTo: () => { calls++; } };
  const task = page.chooseSend(sendEvent()); page.onHide(); saved(true); await task;
  assert.equal(calls, 0);
  const task2 = page.chooseSend(sendEvent()); page.data.view = 'chapter'; saved(true); await task2;
  assert.equal(calls, 0);
});

test('受保护副本即使直接调用handler也不能发送', async () => {
  const page = await bookPage(); let calls = 0;
  page.data.protectedCopy = true; page.finishEditing = async () => { calls++; return true; };
  await page.chooseSend(sendEvent()); assert.equal(calls, 0);
});

let social: PageDefinition;
async function socialPage() {
  if (!social) {
    (globalThis as any).Page = (value: PageDefinition) => { social = value; };
    await import('../miniprogram/packages/story-sharing/pages/social/index');
  }
  const page: PageDefinition = { ...social, data: structuredClone(social.data), hidden: false };
  page.setData = (patch: PageDefinition) => Object.assign(page.data, patch);
  const { state, expected } = fixture();
  page.expected = expected; page.snapshot = snapshotFromState(state, expected, 'a');
  page.data.chapters = page.snapshot.chapters.map((c: any) => ({ ...c, checked: false }));
  return page;
}

test('切换章节后晚到的原生选区不能污染新章选择', async () => {
  const page = await socialPage(); let complete!: (result: any) => void;
  page.data.editorReady = true;
  page.editor = { getSelectionText: ({ success }: any) => { complete = success; }, setContents: ({ success }: any) => success() };
  page.captureSelection(); page.chooseTextChapter({ detail: { value: '1' } }); complete({ text: '原文' });
  assert.equal(page.data.selectedText, ''); assert.equal(page.data.characterCount, 0);
});

test('离页清掉私人快照并忽略晚到封面结果', async () => {
  const page = await socialPage();
  const { storyCoverApi } = await import('../miniprogram/services/storyCoverService');
  const previous = storyCoverApi.resolveUrl; let complete!: (url: string) => void;
  storyCoverApi.resolveUrl = () => new Promise(resolve => { complete = resolve; });
  try {
    const task = page.resolveCover(page.snapshot, page.epoch);
    page.onHide(); complete('https://late-image'); await task;
    assert.equal(page.snapshot, undefined); assert.equal(page.data.coverUrl, ''); assert.deepEqual(page.data.chapters, []);
  } finally { storyCoverApi.resolveUrl = previous; }
});

test('预览前账号复核失败时清除旧账号的正文和封面', async () => {
  const page = await socialPage(); const { state } = fixture();
  // Align the version with this fresh fixture while retaining the old account snapshot.
  state.manuscriptRevisions![0].id = page.expected.revisionId;
  state.stories![0].currentRevisionId = page.expected.revisionId;
  page.data.scope = 'book'; page.data.coverUrl = 'previous-private-cover'; page.data.title = 'previous-private-title';
  (globalThis as any).wx = { getStorageSync: (key: string) => key === 'shiguang-family-room-v5' ? structuredClone(state) : '', setStorageSync() {} };
  await page.previewSelection();
  assert.equal(page.snapshot, undefined); assert.deepEqual(page.data.chapters, []);
  assert.equal(page.data.title, ''); assert.equal(page.data.coverUrl, ''); assert.equal(page.data.preview, false);
  assert.match(page.data.notice, /账号/);
});

test('导出未开放时不读取云端导出素材、不渲染图片', async () => {
  const page=await socialPage(); page.data.preview=true;page.data.exportAvailable=false;
  page.verifySnapshot=()=>{throw new Error('should not run');};
  await page.generateImages(); assert.deepEqual(page.data.imagePaths,[]);
});

test('没有封面时可以从图片预览进入 AI 封面制作页', async () => {
  const page = await socialPage(); const urls: string[] = [];
  (globalThis as any).wx = { navigateTo: ({ url }: any) => urls.push(url) };
  page.makeCover();
  assert.equal(page.returningFromCover, true);
  assert.deepEqual(urls, ['/pages/story-cover/story-cover?storyId=story-test']);
});

test('相册部分失败后续存只保存剩余图片，每次重试重新核对权限', async () => {
  const page=await socialPage();const {bookExportApi}=await import('../miniprogram/services/bookExport');
  const original=bookExportApi.material; let verified=0;const saved:string[]=[];
  page.verifySnapshot=async()=>{};page.exportSelection={};page.descriptor={id:'descriptor'};
  page.data.imagePaths=['cover','page1','page2'];
  bookExportApi.material=async()=>{verified++;return {descriptor:page.descriptor,coverUrl:''};};
  (globalThis as any).wx={saveImageToPhotosAlbum:({filePath,success,fail}:any)=>{if(filePath==='page1'&&saved.length===1){saved.push('failed');fail({errMsg:'permission deny'});}else{saved.push(filePath);success();}}};
  try {
    await page.saveImages();assert.deepEqual(page.data.savedIndices,[0]);assert.match(page.data.notice,/允许保存/);
    await page.saveImages();assert.deepEqual(saved,['cover','failed','page1','page2']);assert.equal(verified,2);
    assert.deepEqual(page.data.savedIndices,[0,1,2]);
  } finally {bookExportApi.material=original;}
});

test('离页停止后续相册写入并清理临时图片', async () => {
  const page=await socialPage();const {bookExportApi}=await import('../miniprogram/services/bookExport');
  const original=bookExportApi.material;const removed:string[]=[],saved:string[]=[];
  page.verifySnapshot=async()=>{};page.exportSelection={};page.descriptor={id:'descriptor'};page.data.imagePaths=['cover','page1'];
  bookExportApi.material=async()=>({descriptor:page.descriptor,coverUrl:''});
  (globalThis as any).wx={getFileSystemManager:()=>({unlink:({filePath}:any)=>removed.push(filePath)}),saveImageToPhotosAlbum:({filePath,success}:any)=>{saved.push(filePath);page.onHide();success();}};
  try{await page.saveImages();assert.deepEqual(saved,['cover']);assert.deepEqual(removed,['cover','page1']);assert.deepEqual(page.data.imagePaths,[]);assert.equal(page.snapshot,undefined);}
  finally{bookExportApi.material=original;}
});

test('导出权限撤销后不写相册并清掉已有图片',async()=>{
  const page=await socialPage();const {bookExportApi}=await import('../miniprogram/services/bookExport');const original=bookExportApi.material;
  page.verifySnapshot=async()=>{};page.exportSelection={};page.descriptor={id:'descriptor'};page.data.imagePaths=['private'];
  const removed:string[]=[];(globalThis as any).wx={getFileSystemManager:()=>({unlink:({filePath}:any)=>removed.push(filePath)}),saveImageToPhotosAlbum:()=>{throw new Error('must not save');}};
  bookExportApi.material=async()=>{throw new Error('权限已撤销');};
  try{await page.saveImages();assert.deepEqual(removed,['private']);assert.deepEqual(page.data.imagePaths,[]);assert.match(page.data.notice,/撤销/);}finally{bookExportApi.material=original;}
});
