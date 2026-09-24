import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { createEmptyRoomState, FamilyRoomState } from '../miniprogram/domain/biography';
import { storyShelf } from '../miniprogram/services/storyShelf';
import { memoryPlacements } from '../miniprogram/services/manuscript';

// Synthetic data only. These CPU measurements are not device/network timings.
function fixture(books: number, memories: number, versions: number): FamilyRoomState {
  const state = createEmptyRoomState();
  state.storyMigration = { status: 'active', version: 1, pending: [] };
  state.contributions = Array.from({ length: memories }, (_, i) => ({
    id: `memory-${i}`, authorMemberId: 'owner', authorName: '测试者', relation: '自己',
    text: '虚构的性能测试文字。'.repeat(50), scope: 'personal', visibility: 'private',
    reviewStatus: 'confirmed', createdAt: '2026-09-24',
  }));
  state.stories = Array.from({ length: books }, (_, i) => ({
    id: `story-${i}`, familyId: 'fixture', title: `测试故事${i}`, protagonistMemberIds: [],
    memoryIds: state.contributions.filter((_, j) => j % books === i).map(m => m.id),
    createdAt: '2026-09-24', updatedAt: '2026-09-24', currentRevisionId: `revision-${i}-${versions - 1}`,
  }));
  state.manuscriptRevisions = state.stories.flatMap(story => Array.from({ length: versions }, (_, i) => ({
    id: `revision-${story.id.slice(6)}-${i}`, storyId: story.id, memberId: 'owner', kind: 'version',
    label: '测试版本', savedAt: String(i).padStart(8, '0'), sourceFingerprint: '',
    draft: { title: story.title, paragraphs: ['虚构书稿'], sourceCount: 1, generatedAt: '', generationMode: 'local-demo',
      chapters: [{ id: 'chapter-1', title: '', memoryIds: story.memoryIds, content: [{ text: '虚构书稿' }] }],
    },
  })));
  return state;
}

for (const [books, memories, versions] of [[20, 200, 20], [100, 2000, 100]]) {
  const state = fixture(books, memories, versions);
  const output = () => [storyShelf(state), [...memoryPlacements(state)]];
  const expected = JSON.stringify(output());
  for (let i = 0; i < 5; i++) output();
  const times = Array.from({ length: 25 }, () => {
    const start = performance.now();
    const result = output();
    const elapsed = performance.now() - start;
    assert.equal(JSON.stringify(result), expected);
    return elapsed;
  }).sort((a, b) => a - b);
  console.log(JSON.stringify({ books, memories, revisions: books * versions,
    medianMs: +times[12].toFixed(3), p95Ms: +times[23].toFixed(3),
    resultSha256: createHash('sha256').update(expected).digest('hex'),
  }));
}
