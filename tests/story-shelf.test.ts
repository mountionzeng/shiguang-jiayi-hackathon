import assert from "node:assert/strict";
import test from "node:test";

import {
  accountOwner,
  BiographyDraft,
  createContribution,
  FamilyRoomState,
  ManuscriptRevision,
} from "../miniprogram/domain/biography";
import { shelfStoryLabel, storyShelf } from "../miniprogram/services/storyShelf";
import { createDemoRoomStateForTests } from "./fixtures";
import { createManuscriptReader, currentManuscript, manuscriptHistory, memoryPlacements } from '../miniprogram/services/manuscript';

function revision(memberId: string, title: string, savedAt: string, chapters = 1): ManuscriptRevision {
  const draft: BiographyDraft = {
    title,
    paragraphs: ["第一章　开头", "那一年我们搬进了老屋。"],
    sourceCount: 1,
    generatedAt: savedAt,
    generationMode: "local-demo",
    chapters: Array.from({ length: chapters }, (_, index) => ({
      id: `chapter-${index}`,
      title: `第${index + 1}段`,
      memoryIds: [],
      content: [{ text: index === 0 ? "那一年我们搬进了老屋。" : "后来的事。" }],
    })),
  };
  return { id: `revision-${memberId}-${savedAt}`, memberId, kind: "version", label: "保存", savedAt, sourceFingerprint: "", draft };
}

test("the account owner is the 自己 book first, then the account's first profile", () => {
  const members = createDemoRoomStateForTests().members;
  assert.equal(accountOwner(members)?.id, "owner");

  const withSelf = members.concat({ id: "self", name: "岱", relation: "自己", avatarText: "岱", role: "contributor", kind: "recording-profile" });
  assert.equal(accountOwner(withSelf)?.id, "self");

  const deletedSelf = withSelf.map((member) => member.id === "self" ? { ...member, deletedAt: "2026-09-11T00:00:00.000Z" } : member);
  assert.equal(accountOwner(deletedSelf)?.id, "owner");

  const ownerIsPerson = members.map((member) => member.id === "owner" ? { ...member, kind: "person" as const } : member);
  assert.equal(accountOwner(ownerIsPerson), undefined);
});

test("the shelf lists every named story in the memory pool, newest first, without family-review posts", () => {
  const initial = createDemoRoomStateForTests();
  const byMom = createContribution({
    id: "mom-wedding",
    authorMemberId: "member-1",
    authorName: "林秋",
    relation: "女儿",
    text: "那天下着小雨，我们骑自行车去领的证。",
    storyTitle: "爸妈的婚礼",
    scope: "personal",
    visibility: "private",
    now: new Date("2026-09-01T00:00:00.000Z"),
  });
  const state: FamilyRoomState = { ...initial, contributions: initial.contributions.concat(byMom) };

  const shelf = storyShelf(state);
  assert.deepEqual(shelf.map((story) => story.title), ["爸妈的婚礼", "外公接我放学"]);
  assert.deepEqual(shelf[1].memoryIds, ["demo-personal-rain"]);
  assert.equal(shelfStoryLabel(shelf[0]), "1 段记忆");
  assert.equal(state.contributions.length, initial.contributions.length + 1, "reading the shelf writes nothing");
});

test("each profile's manuscript is a story, merged with the same-named story", () => {
  const initial = createDemoRoomStateForTests();
  const state: FamilyRoomState = {
    ...initial,
    manuscriptRevisions: [
      revision("owner", "外公接我放学", "2026-09-05T00:00:00.000Z", 3),
      revision("member-1", "我这一辈子", "2026-09-10T00:00:00.000Z"),
      revision("member-2", "  ", "2026-08-01T00:00:00.000Z"),
    ],
  };

  const shelf = storyShelf(state);
  assert.deepEqual(shelf.map((story) => [story.title, story.manuscriptMemberId, story.memoryIds.length]), [
    ["我这一辈子", "member-1", 0],
    ["外公接我放学", "owner", 1],
    ["还没取名的书稿", "member-2", 0],
  ]);
  assert.equal(shelfStoryLabel(shelf[1]), "已整理 3 章 · 1 段记忆");
  assert.equal(shelf[0].excerpt, "那一年我们搬进了老屋。");

  const deleted = { ...state, members: state.members.map((member) => member.id === "member-1" ? { ...member, deletedAt: "2026-09-11T00:00:00.000Z" } : member) };
  assert.ok(!storyShelf(deleted).some((story) => story.manuscriptMemberId === "member-1"), "a deleted profile's book is hidden, not removed");
  assert.equal(deleted.manuscriptRevisions?.length, 3);
});

test('indexed manuscripts retain explicit revision selection, legacy fallbacks, tie order and errors', () => {
  const state = createDemoRoomStateForTests();
  const first = { ...revision('owner', '指定旧版本', '2026-09-01'), id: 'revision-a', storyId: 'story-a' };
  const second = { ...revision('owner', '较新版本', '2026-09-02'), id: 'revision-b', storyId: 'story-a' };
  const unrelated = { ...second, id: 'revision-other', storyId: 'story-other' };
  state.stories = [{ id: 'story-a', title: '测试', familyId: 'fixture', protagonistMemberIds: [], memoryIds: [],
    createdAt: '', updatedAt: '', currentRevisionId: first.id }];
  state.manuscriptRevisions = [second, first, unrelated,
    { ...revision('owner', '同日A', '2026-09-03'), id: 'legacy-a' },
    { ...revision('owner', '同日B', '2026-09-03'), id: 'legacy-b' }];
  state.legacyPersonalDrafts = { 'member-1': revision('member-1', '旧档案', '').draft };
  const before = JSON.stringify(state);
  const reader = createManuscriptReader(state);
  for (const id of ['story-a', 'owner', 'member-1', 'member-2']) {
    assert.deepEqual(reader.current(id), currentManuscript(state, id));
    assert.deepEqual(reader.history(id), manuscriptHistory(state, id));
  }
  assert.equal(reader.current('story-a').draft?.title, '指定旧版本');
  assert.equal(reader.current('owner').draft?.title, '同日B');
  assert.equal(JSON.stringify(state), before, 'indexing must not sort or edit source arrays');
  assert.throws(() => reader.current('story-missing'), /不可用/);
  const missing = { ...state, manuscriptRevisions: [second] };
  assert.throws(() => createManuscriptReader(missing).current('story-a'), /未加载完整/);
  const deleted = { ...state, stories: state.stories.map(story => ({ ...story, deletedAt: '2026-09-24' })) };
  assert.throws(() => createManuscriptReader(deleted).current('story-a'), /不可用/);
  state.stories[0].currentRevisionId = second.id;
  assert.equal(createManuscriptReader(state).current('story-a').draft?.title, '较新版本', 'next render uses fresh data');
});

test('independent shelf preserves contribution excerpt order, repeated IDs and current chapter placement', () => {
  const state = createDemoRoomStateForTests();
  const memory = state.contributions[0];
  state.contributions = [
    { ...memory, id: 'first', text: '按素材顺序选摘要' },
    { ...memory, id: 'second', text: '故事列表排在前面的素材' },
    { ...memory, id: 'deleted', deletedAt: '2026-09-24' },
  ];
  state.stories = [{ id: 'story-a', title: '测试', familyId: 'fixture', protagonistMemberIds: [],
    memoryIds: ['second', 'first', 'second', 'deleted', 'missing'], createdAt: '', updatedAt: '' }];
  state.storyMigration = { version: 1, status: 'active', pending: [] };
  assert.deepEqual(storyShelf(state)[0].memoryIds, ['second', 'first', 'second']);
  assert.equal(storyShelf(state)[0].excerpt, '按素材顺序选摘要');
  const saved = { ...revision('owner', '书稿', '2026-09-24'), id: 'current', storyId: 'story-a' };
  saved.draft.chapters![0].memoryIds = ['first', 'second'];
  state.manuscriptRevisions = [saved];
  state.stories[0].currentRevisionId = saved.id;
  assert.equal(memoryPlacements(state).get('first')?.[0].storyId, 'story-a');
  state.stories[0].deletedAt = '2026-09-25';
  assert.deepEqual(storyShelf(state), []);
  assert.equal(memoryPlacements(state).size, 0);
});
