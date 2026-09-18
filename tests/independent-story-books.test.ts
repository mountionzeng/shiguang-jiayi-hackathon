import assert from 'node:assert/strict';
import test from 'node:test';
import {createEmptyRoomState} from '../miniprogram/domain/biography';
import * as core from '../miniprogram/domain/storyBookCore';

const initial = () => core.migrate(createEmptyRoomState(),'family_test','2026-09-17T00:00:00Z');
const create = (state: ReturnType<typeof initial>, id: string, name: string) => core.apply(state,{action:'create',storyId:id,title:name,writingMode:'objective',requestId:'create-'+id,memoryIds:[]});
test('empty books persist independently; title and mode never change another book', () => {
  const a = create(initial(),'story-a','童年');
  const b = create(a,'story-b','母亲');
  const changed = core.apply(b,{action:'update',storyId:'story-a',expectedVersion:1,requestId:'rename-a-0001',patch:{bookTitle:'院子里的夏天',writingMode:'creative'}});
  assert.equal(changed.stories![0].title,'童年');
  assert.equal(changed.stories![0].bookTitle,'院子里的夏天');
  assert.deepEqual(changed.stories![1],b.stories![1]);
  assert.equal(core.current(changed,'story-a').draft,undefined);
  assert.throws(()=>core.current(changed,'story-missing'),/不可用/);
});
test('idempotent retry succeeds but stale and conflicting requests do not', () => {
  const a = create(initial(),'story-a','童年');
  const op = {action:'update',storyId:'story-a',expectedVersion:1,requestId:'rename-a-0001',patch:{bookTitle:'夏天'}};
  const b = core.apply(a,op);
  assert.deepEqual(core.apply(b,op),b);
  assert.throws(()=>core.apply(b,{...op,patch:{bookTitle:'秋天'}}),/冲突/);
  assert.throws(()=>core.apply(b,{...op,requestId:'rename-a-0002'}),/已有更新/);
});
test('migration separates certain chapters, keeps ambiguous originals and is repeatable', () => {
  const state = createEmptyRoomState();
  state.contributions = ['童年','母亲'].map((storyTitle,i)=>({id:'m'+i,storyTitle,scope:'personal' as const,authorMemberId:'owner',authorName:'我',relation:'自己',text:'原话'+i,visibility:'private' as const,reviewStatus:'confirmed' as const,createdAt:'2026-09-17'}));
  const chapters = [
    {id:'chapter-a',title:'夏天',memoryIds:['m0'],content:[{text:'A'}]},
    {id:'chapter-b',title:'思念',memoryIds:['m1'],content:[{text:'B'}]},
    {id:'chapter-c',title:'混合',memoryIds:['m0','m1'],content:[{text:'C'}]},
  ];
  state.manuscriptRevisions=[{id:'old-1',memberId:'owner',kind:'version',label:'旧稿',savedAt:'2026-09-17',sourceFingerprint:'',draft:{title:'我的书',chapters,...core.flatten(chapters),sourceCount:2,generatedAt:'2026-09-17',generationMode:'local-demo'}}];
  const before = JSON.stringify(state);
  const next = core.migrate(state,'family_test');
  assert.equal(JSON.stringify(state),before);
  assert.equal(next.stories!.length,2);
  assert.equal(next.storyMigration!.pending.length,1);
  const pending=next.storyMigration!.pending[0];
  assert.ok(pending.kind===undefined || pending.kind==='chapter');
  assert.equal(pending.chapter.content[0].text,'C');
  for (const story of next.stories!) {
    assert.equal(story.writingMode,'objective');
    assert.equal(core.current(next,story.id).draft!.chapters!.length,1);
  }
  assert.deepEqual(core.migrate(next),next);
});

test('migration never merges same-title memories from different recording profiles', () => {
  const state = createEmptyRoomState();
  state.contributions = ['owner-a','owner-b'].map((authorMemberId,index)=>({
    id:'same-title-'+index,
    storyTitle:'故乡',
    scope:'personal' as const,
    authorMemberId,
    authorName:index ? '乙' : '甲',
    relation:'自己',
    text:'各自的故乡记忆',
    visibility:'private' as const,
    reviewStatus:'confirmed' as const,
    createdAt:'2026-09-17',
  }));

  const migrated=core.migrate(state,'family_test');
  assert.equal(migrated.stories!.length,2);
  assert.equal(new Set(migrated.stories!.map(story=>story.id)).size,2);
  assert.equal(new Set(migrated.stories!.map(story=>story.title)).size,2);
  assert.deepEqual(migrated.stories!.map(story=>story.memoryIds),[['same-title-0'],['same-title-1']]);
});
