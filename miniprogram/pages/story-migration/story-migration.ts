import { BiographyDraft, ManuscriptRevision, Story, StoryMigrationAssetItem, StoryMigrationChapterItem, StoryMigrationItem } from "../../domain/biography";
import * as storyCore from "../../domain/storyBookCore";
import { currentManuscript, makeRevision } from "../../services/manuscript";
import { loadRoomStateRemoteFirst } from "../../services/roomRepository";
import { createStoryBook, resolveStoryAsset, resolveStoryChapter } from "../../services/storyBooks";

Page({
  data: {
    pending: [] as StoryMigrationChapterItem[],
    pendingAssets: [] as StoryMigrationAssetItem[],
    stories: [] as Story[],
    newTitles: {} as Record<string,string>,
    resolving: "",
    notice: "",
  },
  onShow() { void this.refresh(); },
  async refresh() {
    try {
      const state = await loadRoomStateRemoteFirst();
      const unresolved=(state.storyMigration?.pending ?? []).filter(item => !item.resolvedStoryId);
      this.setData({
        pending: unresolved.filter((item:StoryMigrationItem):item is StoryMigrationChapterItem=>item.kind===undefined || item.kind==='chapter'),
        pendingAssets: unresolved.filter((item:StoryMigrationItem):item is StoryMigrationAssetItem=>item.kind==='image' || item.kind==='image-job'),
        stories: (state.stories ?? []).filter(story => !story.deletedAt),
        notice: "",
      });
    } catch (error) { this.setData({ notice: error instanceof Error ? error.message : "待确认内容暂时加载失败" }); }
  },
  assign(event: { currentTarget: { dataset: { pending: string; story: string } } }) {
    const pendingId = event.currentTarget.dataset.pending;
    const storyId = event.currentTarget.dataset.story;
    if (!pendingId || !storyId || this.data.resolving) return;
    wx.showModal({
      title: "放入这本书？",
      content: "这一章会作为新版本加入所选故事，原迁移记录仍可追溯。",
      success: result => { if (result.confirm) void this.resolve(pendingId, storyId); },
    });
  },
  onNewTitle(event: { currentTarget: { dataset: { pending: string } }; detail: { value: string } }) {
    this.setData({newTitles:{...this.data.newTitles,[event.currentTarget.dataset.pending]:event.detail.value}});
  },
  createNew(event: { currentTarget: { dataset: { pending: string } } }) {
    const pendingId=event.currentTarget.dataset.pending, title=(this.data.newTitles[pendingId] || '').trim();
    if(!pendingId || this.data.resolving)return;
    if(!title){this.setData({notice:'请先填写新故事的名称'});return;}
    void this.createAndResolve(pendingId,title);
  },
  async createAndResolve(pendingId:string,title:string) {
    this.setData({resolving:pendingId,notice:''});
    try {
      const storyId='story-'+storyCore.hash('migration|'+pendingId);
      const state=await loadRoomStateRemoteFirst();
      const existing=(state.stories || []).find(story=>story.id===storyId && !story.deletedAt);
      const story=existing || (await createStoryBook({storyId,title,writingMode:'objective',memoryIds:[],requestId:'migration-create-'+storyCore.hash(pendingId)})).story;
      await this.resolve(pendingId,story.id);
    } catch(error) {
      this.setData({notice:error instanceof Error ? error.message : '新建故事失败，请重试'});
    } finally {
      this.setData({resolving:''});
    }
  },
  assignAsset(event:{currentTarget:{dataset:{pending:string;story:string}}}) {
    const {pending:pendingId,story:storyId}=event.currentTarget.dataset;
    if(!pendingId || !storyId || this.data.resolving)return;
    void this.resolveAsset(pendingId,storyId);
  },
  async resolveAsset(pendingId:string,storyId:string) {
    this.setData({resolving:pendingId,notice:''});
    try {
      const state=await loadRoomStateRemoteFirst();
      const story=(state.stories || []).find(item=>item.id===storyId && !item.deletedAt);
      if(!story)throw new Error('这本书已不可用');
      await resolveStoryAsset(story,pendingId);
      await this.refresh();
      this.setData({notice:'已把旧配图资源归入所选故事书'});
    } catch(error) {
      this.setData({notice:error instanceof Error ? error.message : '处理失败，请重试'});
    } finally { this.setData({resolving:''}); }
  },
  createNewAsset(event:{currentTarget:{dataset:{pending:string}}}) {
    const pendingId=event.currentTarget.dataset.pending,title=(this.data.newTitles[pendingId] || '').trim();
    if(!pendingId || this.data.resolving)return;
    if(!title){this.setData({notice:'请先填写新故事的名称'});return;}
    void this.createAndResolveAsset(pendingId,title);
  },
  async createAndResolveAsset(pendingId:string,title:string) {
    this.setData({resolving:pendingId,notice:''});
    try {
      const storyId='story-'+storyCore.hash('migration|'+pendingId), state=await loadRoomStateRemoteFirst();
      const existing=(state.stories || []).find(story=>story.id===storyId && !story.deletedAt);
      const story=existing || (await createStoryBook({storyId,title,writingMode:'objective',memoryIds:[],requestId:'migration-create-'+storyCore.hash(pendingId)})).story;
      await this.resolveAsset(pendingId,story.id);
    } catch(error) {
      this.setData({notice:error instanceof Error ? error.message : '新建故事失败，请重试'});
    } finally { this.setData({resolving:''}); }
  },
  async resolve(pendingId: string, storyId: string) {
    this.setData({ resolving: pendingId, notice: "" });
    try {
      const state = await loadRoomStateRemoteFirst();
      const story = (state.stories ?? []).find(item => item.id === storyId && !item.deletedAt);
      if (!story) throw new Error("这本书已不可用");
      const current = currentManuscript(state, story.id);
      const base: BiographyDraft = current.draft ?? {
        title: story.bookTitle || story.title, paragraphs: [], sourceCount: story.memoryIds.length,
        generatedAt: new Date().toISOString(), generationMode: "local-demo", chapters: [],
      };
      const revision: ManuscriptRevision = makeRevision(story.legacy?.memberId || "", base, current.sourceFingerprint, "version", "确认迁移章节");
      revision.storyId = story.id;
      revision.expectedStoryVersion = story.version;
      revision.sourceRevisionId = current.revisionId || undefined;
      await resolveStoryChapter(story, pendingId, revision);
      await this.refresh();
      this.setData({ notice: "已放入所选故事书" });
    } catch (error) { this.setData({ notice: error instanceof Error ? error.message : "处理失败，请重试" }); }
    finally { this.setData({ resolving: "" }); }
  },
  onShareAppMessage() { return { title: "拾光家忆｜把重要的故事慢慢写下来", path: "/pages/index/index" }; },
  onShareTimeline() { return { title: "拾光家忆｜把重要的故事慢慢写下来" }; },
});
