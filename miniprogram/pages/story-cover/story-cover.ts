import { storyCoverApi } from '../../services/storyCoverService';
import { isActiveJob, qualityLabel, moderationLabel, storyImageApi, StoryImage, StoryImageJob } from '../../services/storyImageService';

interface ReferenceCard { id: string; kind: 'photo' | 'image'; url: string; selected: boolean }
interface CoverCard extends StoryImage { selected: boolean; qualityLabel: string; moderationLabel: string; ready: boolean }
const message = (error: unknown) => error instanceof Error ? error.message : '暂时没完成，请稍后再试';

Page({
  data: {
    storyId: '', title: '', coverImageId: '', version: 0, chapterCount: 0, textLength: 0,
    references: [] as ReferenceCard[], selectedCount: 0, covers: [] as CoverCard[], jobs: [] as StoryImageJob[],
    loading: true, submitting: false, selecting: false, activeJob: false, notice: '', loadError: '',
  },
  hidden: false, unloaded: false, refreshId: 0,
  timer: undefined as ReturnType<typeof setTimeout> | undefined,
  onLoad(options: {storyId?: string}) {
    this.setData({storyId: options.storyId || ''});
  },
  onShow() { this.hidden = false; void this.refresh().catch(error => this.setData({loading:false, loadError:message(error)})); },
  onHide() { this.hidden = true; this.stopPoll(); },
  onUnload() { this.unloaded = true; this.stopPoll(); },
  stopPoll() { if (this.timer !== undefined) clearTimeout(this.timer); this.timer = undefined; },
  async refresh() {
    const id = ++this.refreshId;
    const [source, list] = await Promise.all([storyCoverApi.sources(this.data.storyId), storyImageApi.listStoryImages(this.data.storyId)]);
    if (this.unloaded || id !== this.refreshId) return;
    const chosen = new Set(this.data.references.filter(item => item.selected).map(item => item.id));
    const references: ReferenceCard[] = [
      ...source.photos.map(photo => ({id:photo.photoId, kind:'photo' as const, url:photo.url, selected:chosen.has(photo.photoId)})),
      ...list.images.filter(image => image.moderation === 'pass' && image.url).map(image => ({id:image.imageId,kind:'image' as const,url:image.url,selected:chosen.has(image.imageId)})),
    ];
    this.setData({
      title:source.title, version:source.version, coverImageId:source.coverImageId,
      chapterCount:source.chapterCount, textLength:source.textLength,
      references, selectedCount:references.filter(item => item.selected).length,
      covers:list.images.filter(image => image.purpose === 'cover').map(image => ({...image,
        selected:image.imageId === source.coverImageId, qualityLabel:qualityLabel(image),
        moderationLabel:moderationLabel(image.moderation), ready:image.moderation === 'pass'})),
      jobs:list.pending.filter(job => job.purpose === 'cover'),
      activeJob:list.pending.some(job => job.purpose === 'cover' && isActiveJob(job)), loading:false, loadError:'',
    });
    this.schedulePoll();
  },
  schedulePoll() {
    this.stopPoll();
    if (this.hidden || this.unloaded) return;
    if (this.data.jobs.some(isActiveJob) || this.data.covers.some(image => image.moderation === 'pending' || image.quality === 'pending')) {
      this.timer = setTimeout(() => { void this.poll(); }, 4000);
    }
  },
  async poll() {
    if (this.hidden || this.unloaded) return;
    try {
      for (const job of this.data.jobs.filter(isActiveJob)) {
        const result = await storyImageApi.checkImageJob(job.jobId, this.data.storyId);
        if (this.hidden || this.unloaded) return;
        this.setData({notice:result.job.status === 'stored' ? '封面画好了，看看是否喜欢' : result.job.message});
      }
      await this.refresh();
    } catch (error) {
      if (!this.hidden && !this.unloaded) { this.setData({notice:message(error)}); this.schedulePoll(); }
    }
  },
  toggleReference(event: {currentTarget:{dataset:{id:string}}}) {
    if (this.data.submitting || this.data.selecting) return;
    const target = this.data.references.find(item => item.id === event.currentTarget.dataset.id);
    if (!target) return;
    if (!target.selected && this.data.selectedCount >= 3) { this.setData({notice:'最多选 3 张参考图'}); return; }
    const references = this.data.references.map(item => item.id === target.id ? {...item,selected:!item.selected} : item);
    this.setData({references, selectedCount:references.filter(item => item.selected).length, notice:''});
  },
  async generate() {
    if (this.data.submitting || this.data.selecting || this.data.loading || this.data.jobs.some(isActiveJob)) return;
    this.setData({submitting:true, notice:'正在阅读整本书，构思封面…'});
    const selected = this.data.references.filter(item => item.selected);
    try {
      const job = await storyCoverApi.submit({storyId:this.data.storyId,
        referenceImageIds:selected.filter(item => item.kind === 'image').map(item => item.id),
        referencePhotoIds:selected.filter(item => item.kind === 'photo').map(item => item.id)});
      if (this.unloaded) return;
      this.setData({notice:job.message});
      await this.refresh();
    } catch (error) {
      if (!this.unloaded) {
        this.setData({notice:message(error)});
        // A dropped response may still have queued a paid job. Read it before allowing another tap.
        await this.refresh().catch(() => undefined);
      }
    } finally { if (!this.unloaded) this.setData({submitting:false}); }
  },
  async choose(event: {currentTarget:{dataset:{id:string}}}) {
    if (this.data.selecting || this.data.submitting) return;
    const imageId = event.currentTarget.dataset.id;
    const cover = this.data.covers.find(item => item.imageId === imageId);
    if (imageId && (!cover?.ready || cover.selected)) return;
    this.setData({selecting:true, notice:''});
    try {
      await storyCoverApi.select(this.data.storyId, imageId, this.data.version);
      if (this.unloaded) return;
      await this.refresh();
      this.setData({notice:imageId ? '已设为封面，书内和首页都会同步显示' : '已恢复原来的纸本封面'});
    } catch (error) { if (!this.unloaded) this.setData({notice:message(error)}); }
    finally { if (!this.unloaded) this.setData({selecting:false}); }
  },
  preview(event: {currentTarget:{dataset:{url:string}}}) { wx.previewImage({current:event.currentTarget.dataset.url, urls:this.data.covers.map(image => image.url).filter(Boolean)}); },
  onShareAppMessage() { return {title:"拾光家忆｜把重要的故事慢慢写下来", path:"/pages/index/index"}; },
  onShareTimeline() { return {title:"拾光家忆｜把重要的故事慢慢写下来"}; },
  retry() { void this.refresh().catch(error => this.setData({loadError:message(error),loading:false})); },
});
