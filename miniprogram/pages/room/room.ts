import { loadAccountActivity, groupAccountActivity, openSharedArticle, type AccountActivity } from '../../services/accountActivity';
import { addFamilyMemberRemoteFirst, updateMemberRemoteFirst, restoreMemberRemoteFirst } from '../../services/roomRepository';
import { deleteMemberWithConfirm } from '../../services/memberActions';
import { loadCurrentAccount, saveCurrentAccountName } from '../../services/accountService';
import {
  contributionRelatedMemberIds,
  contributionStoryTitle,
  FamilyMember,
  FamilyRoomState,
  isActiveMember,
  memoryAiLabel,
  memoryPool,
  MemoryContribution,
} from "../../domain/biography";
import { loadRoomStateRemoteFirst, stageRoomStateForStories, stageRoomStateForArchive, takeStagedRoomStateForRoom } from "../../services/roomRepository";
import { memoryPlacements } from "../../services/manuscript";
import { loadSharedFamilyRoom } from "../../services/familyInviteService";
import { logLoadError } from "../../services/loadErrorLog";
import { bookmarkDateParts } from "../../services/memoryDates";
import { loadPendingReturns, PendingReturn, senderLabel } from "../../services/storyReturnsInbox";

interface RoomLoadOptions { familyId?: string; account?: string; edit?: string; storyId?:string; }

function decodeFamilyId(value = ""): string {
  try { return decodeURIComponent(value).trim(); } catch { return ""; }
}

/**
 * 记忆之家：先是人，再是记忆。
 * 点「你」看全部记忆，点某个人看和 ta 有关的记忆；写没写进书都在这里。
 * 人员编辑与分享往来均在本页展开。
 */

const ME = "me";

/** A book told as "自己" is the account owner's own; the owner is「你」，不单列成一个人。 */
const isSelf = (member: FamilyMember) => member.relation === "自己";

interface PersonTab {
  id: string;
  name: string;
  relation: string;
  avatarText: string;
  count: number;
  /** 这位家人有几封等你决定的回信；0 时界面上什么都不显示。 */
  letters: number;
  account?: boolean;
}

/** 某位家人发回的、等主人决定要不要放进书里的回信。 */
interface LetterRow {
  returnId: string;
  text: string;
  dateLabel: string;
  where: string;
}

interface MemoryRow {
  id: string;
  title: string;
  text: string;
  dateLabel: string;
  dateParts: string[];
  storyLabel: string;
  placeLabel: string;
  aiLabel: string;
}

/** 和某个人有关的记忆：聊的时候点到了 ta，或者这段记忆本来就记在 ta 名下（旧数据）。 */
function memoriesWith(memories: MemoryContribution[], memberId: string): MemoryContribution[] {
  return memories.filter((memory) =>
    memory.authorMemberId === memberId || contributionRelatedMemberIds(memory).includes(memberId));
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}

Page({
  roomSnapshot: undefined as FamilyRoomState | undefined,
  loadSequence: 0,
  activitySequence: 0,
  requestedAccount: '',
  requestedEdit: false,
  allActivity: [] as AccountActivity[],
  onHide() { this.loadSequence++; this.activitySequence++; },
  onUnload() { this.loadSequence++; this.activitySequence++; },
  lettersById: new Map<string, PendingReturn>(),
  data: {
    accessStoryId: '',
    people: [] as PersonTab[],
    sharedArticles: [] as AccountActivity[], activityError: '', activityLoading: false, openingShare: false,
    editorOpen: false, editingId: '', nameInput: '', relationInput: '', personSaving: false,
    canEditPerson: false, trash: [] as FamilyMember[], trashOpen: false,

    activeId: ME,
    activeName: "你",
    memories: [] as MemoryRow[],
    hasMemories: false,
    hasAnyMemory: false,
    loadError: "",
    loading: true,
    loadingDetails: false,
    viewerId: "",
    viewerName: "",
    viewerRole: "" as FamilyMember["role"] | "",
    sharedFamilyId: "",
    canInvite: true,
    letters: [] as LetterRow[],
  },

  onLoad(options: RoomLoadOptions = {}) {
    this.allActivity = [];
    this.requestedEdit = options.edit === 'me';
    this.requestedAccount = options.account ? 'account:' + decodeFamilyId(options.account) : '';
    this.setData({ sharedFamilyId: decodeFamilyId(options.familyId), accessStoryId: options.storyId || '', activeId: options.account ? 'account:' + decodeFamilyId(options.account) : ME, editorOpen: false, editingId: '' });
  },

  onShow() {
    if (!this.data.sharedFamilyId) void this.refreshActivity();
    const staged = takeStagedRoomStateForRoom();
    if (staged && !this.data.sharedFamilyId) void this.refresh(staged, true);
    void this.refresh().catch((error) => { logLoadError("room", error); this.setData({ loading: false, loadingDetails: false, loadError: "记忆暂时没加载出来，请重试。" }); });
  },

  async refresh(state?: FamilyRoomState, preview = false) {
    const sequence = state ? this.loadSequence : ++this.loadSequence;
    let currentState: FamilyRoomState;
    let viewer: FamilyMember | undefined;
    let viewerRole: FamilyMember["role"] | "";
    if (!state && this.data.sharedFamilyId) {
      const shared = await loadSharedFamilyRoom(this.data.sharedFamilyId);
      currentState = shared.state;
      const matchedViewer = currentState.members.find(member => member.id === shared.viewerMemberId);
      if (!matchedViewer) throw new Error("成员身份已失效，请重新接受邀请");
      viewer = matchedViewer;
      viewerRole = shared.viewerRole;
    } else {
      currentState = state ?? await loadRoomStateRemoteFirst({view: "memories"});
      viewer = currentState.members.find(member => member.relation === "自己") ?? currentState.members[0];
      // 新用户还没有人物档案时，个人记忆之家仍可浏览空状态。
      viewerRole = viewer?.role ?? "";
    }
    if (sequence !== this.loadSequence) return;
    // Staged memories must paint immediately; only the authoritative refresh reads letters.
    const returns: PendingReturn[] = this.data.sharedFamilyId || preview ? [] : await loadPendingReturns();
    if (sequence !== this.loadSequence) return;
    this.roomSnapshot = this.data.sharedFamilyId ? undefined : currentState;
    const lettersBy = new Map<string, PendingReturn[]>();
    returns.forEach(item => {
      const id = (item as PendingReturn & { senderMemberId?: string }).senderMemberId || "";
      if (id) lettersBy.set(id, [...(lettersBy.get(id) ?? []), item]);
    });
    const pool = memoryPool(currentState.contributions);
    const placements = memoryPlacements(currentState);
    const people: PersonTab[] = [
      { id: ME, name: "你", relation: "全部记忆", avatarText: "我", count: pool.length, letters: returns.length },
      ...currentState.members.filter((member) => isActiveMember(member) && !isSelf(member)).map((member) => ({
        id: member.id,
        name: member.name,
        relation: member.relation,
        avatarText: member.avatarText,
        count: memoriesWith(pool, member.id).length,
        letters: (lettersBy.get(member.id) ?? []).length,
      })),
    ];
    for (const contact of groupAccountActivity(this.allActivity)) people.push({ id: 'account:' + contact.id, name: contact.name, relation: '分享给我的内容', avatarText: contact.avatar, count: contact.count, letters: 0, account: true });
    const active = people.find((person) => person.id === (this.requestedAccount || this.data.activeId)) ?? people[0];
    const shown = active.id === ME ? pool : memoriesWith(pool, active.id);
    const memories: MemoryRow[] = shown
      .slice()
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map((memory) => {
        const places = placements.get(memory.id) ?? [];
        return {
          id: memory.id,
          title: memory.title ?? "",
          text: memory.text,
          dateLabel: formatDate(memory.createdAt),
          dateParts: bookmarkDateParts(memory.createdAt),
          storyLabel: contributionStoryTitle(memory),
          placeLabel: places.length
            ? "写进了 " + places.map((place) => `${place.bookName}的书${place.chapter}`).join("、")
            : "还没写进书",
          aiLabel: preview ? "" : memoryAiLabel(memory),
        };
      });

    this.lettersById = new Map(returns.map(item => [item.returnId, item]));
    const shownLetters = active.id === ME ? returns : (lettersBy.get(active.id) ?? []);
    const letters: LetterRow[] = shownLetters.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(item => ({
      returnId: item.returnId,
      text: item.blocks.map(block => block.text).join("\n\n"),
      dateLabel: formatDate(item.createdAt),
      where: (active.id === ME ? senderLabel(item) + " · " : "") + "回信给你的书",
    }));
    this.setData({
      people,
      loading: false,
      loadingDetails: preview,
      letters,
      activeId: active.id,
      activeName: active.name,
      memories,
      hasMemories: memories.length > 0,
      hasAnyMemory: pool.length > 0,
      loadError: "",
      viewerId: viewer?.id ?? "",
      viewerName: viewer?.name ?? "",
      viewerRole,
      canInvite: this.data.sharedFamilyId ? viewerRole === "owner" : true,
      canEditPerson: !this.data.sharedFamilyId && !active.account,
      trash: currentState.members.filter(member => member.deletedAt),
      sharedArticles: this.allActivity.filter(event => active.id === ME || active.id === 'account:' + event.accountKey),
    });
    if (this.requestedEdit && !preview) { this.requestedEdit = false; void this.editPerson(); }
  },

  choosePerson(event: { currentTarget: { dataset: { id: string } } }) {
    this.requestedAccount = '';
    this.setData({ activeId: event.currentTarget.dataset.id, editorOpen: false });
    void this.refresh(this.roomSnapshot, this.data.loadingDetails).catch((error) => { logLoadError("room", error); this.setData({ loadError: "记忆暂时没加载出来，请重试。" }); });
  },

  openMemory(event: { currentTarget: { dataset: { id: string } } }) {
    stageRoomStateForArchive(event.currentTarget.dataset.id, this.data.loadingDetails ? undefined : this.roomSnapshot);
    wx.navigateTo({ url: "/pages/archive/archive?id=" + encodeURIComponent(event.currentTarget.dataset.id) });
  },

  openLetter(event: { currentTarget: { dataset: { id: string } } }) {
    const item = this.lettersById.get(event.currentTarget.dataset.id);
    if (!item) return;
    wx.navigateTo({ url: "/pages/book/book?storyId=" + encodeURIComponent(item.sourceStoryId) + "&chapterId=" + encodeURIComponent(item.sourceChapterId) });
  },

  openPeople() { this.addPersonForm(); },
  async refreshActivity() {
    const sequence = ++this.activitySequence;
    this.setData({ activityLoading: true, activityError: '' });
    try {
      const events = await loadAccountActivity();
      if (sequence !== this.activitySequence) return;
      this.allActivity = events.map(event => ({ ...event, at: formatDate(event.at) }));
      if (this.roomSnapshot) await this.refresh(this.roomSnapshot, this.data.loadingDetails);
    } catch (error) { if (sequence === this.activitySequence) this.setData({ activityError: error instanceof Error ? error.message : '分享暂时没有加载出来' }); }
    finally { if (sequence === this.activitySequence) this.setData({ activityLoading: false }); }
  },
  async openShared(event: { currentTarget: { dataset: { id: string } } }) {
    const item = this.allActivity.find(row => row.id === event.currentTarget.dataset.id);
    if (!item || this.data.openingShare) return;
    this.setData({ openingShare: true });
    wx.showLoading({ title: '打开文章…', mask: true });
    try { await openSharedArticle(item); }
    catch (error) { wx.showToast({ title: error instanceof Error ? error.message : '暂时打不开，请重试', icon: 'none' }); }
    finally { wx.hideLoading(); this.setData({ openingShare: false }); }
  },
  addPersonForm() {
    if (this.data.sharedFamilyId || this.data.personSaving) return;
    this.setData({ editorOpen: true, editingId: '', nameInput: '', relationInput: '' });
  },
  async editPerson() {
    if (this.data.sharedFamilyId || !this.data.canEditPerson || this.data.personSaving) return;
    const member = this.roomSnapshot?.members.find(row => row.id === this.data.activeId);
    if (this.data.activeId === ME) {
      try { const account = await loadCurrentAccount(); this.setData({ editorOpen: true, editingId: ME, nameInput: account.displayName || '', relationInput: '' }); }
      catch (error) { wx.showToast({ title: error instanceof Error ? error.message : '名字暂时没加载出来', icon: 'none' }); }
    } else if (member) this.setData({ editorOpen: true, editingId: member.id, nameInput: member.name, relationInput: member.relation });
  },
  onNameInput(event: WechatMiniprogram.Input) { this.setData({ nameInput: event.detail.value }); },
  onRelationInput(event: WechatMiniprogram.Input) { this.setData({ relationInput: event.detail.value }); },
  closePersonEditor() { if (!this.data.personSaving) this.setData({ editorOpen: false }); },
  async savePerson() {
    if (this.data.sharedFamilyId || this.data.personSaving) return;
    if (!this.data.nameInput.trim()) { wx.showToast({ title: '请写下名字', icon: 'none' }); return; }
    if (this.data.editingId !== ME && this.data.relationInput.trim() === '自己') { wx.showToast({ title: '你自己已在头像栏里', icon: 'none' }); return; }
    this.setData({ personSaving: true });
    try {
      if (this.data.editingId === ME) await saveCurrentAccountName(this.data.nameInput);
      else if (this.data.editingId) await updateMemberRemoteFirst(this.data.editingId, this.data.nameInput, this.data.relationInput, { view: 'home' });
      else await addFamilyMemberRemoteFirst(this.data.nameInput, this.data.relationInput, 'person', { view: 'home' });
      this.setData({ editorOpen: false, editingId: '' }); await this.refresh();
      wx.showToast({ title: '已保存', icon: 'success' });
    } catch (error) { wx.showToast({ title: error instanceof Error ? error.message : '保存失败，请重试', icon: 'none' }); }
    finally { this.setData({ personSaving: false }); }
  },
  async removePerson() {
    if (this.data.sharedFamilyId || this.data.personSaving || !this.data.editingId || this.data.editingId === ME) return;
    const state = this.roomSnapshot, member = state?.members.find(row => row.id === this.data.editingId);
    if (!state || !member || member.id === this.data.viewerId) return;
    this.setData({ personSaving: true });
    try { if (await deleteMemberWithConfirm(member, state, { view: 'home' })) { this.setData({ editorOpen: false, activeId: ME }); await this.refresh(); } }
    finally { this.setData({ personSaving: false }); }
  },
  toggleTrash() { this.setData({ trashOpen: !this.data.trashOpen }); },
  async restorePerson(event: { currentTarget: { dataset: { id: string } } }) {
    if (this.data.sharedFamilyId || this.data.personSaving) return;
    this.setData({ personSaving: true });
    try { await restoreMemberRemoteFirst(event.currentTarget.dataset.id, { view: 'home' }); await this.refresh(); }
    catch (error) { wx.showToast({ title: error instanceof Error ? error.message : '恢复失败', icon: 'none' }); }
    finally { this.setData({ personSaving: false }); }
  },

  startInterview() {
    const query = this.data.sharedFamilyId ? `?familyId=${encodeURIComponent(this.data.sharedFamilyId)}` : "";
    wx.navigateTo({ url: `/pages/interview/interview${query}` });
  },

  closeAccess() { this.setData({ accessStoryId: '' }); },
  async inviteFamilyMember() {
    const stories = this.roomSnapshot?.stories?.filter(story => !story.deletedAt) || [];
    if (!stories.length) { wx.showToast({title:'先写一个故事，再邀请亲友一起读',icon:'none'}); return; }
    try {
      const chosen = await new Promise<number>((resolve,reject) => wx.showActionSheet({itemList:stories.map(story=>story.title || '未命名故事'),success:result=>resolve(result.tapIndex),fail:reject}));
      if(stories[chosen])this.setData({accessStoryId:stories[chosen].id});
    } catch { /* Cancel leaves the page unchanged. */ }
  },

  retryLoad() { this.onShow(); },

  goHome() {
    wx.reLaunch({ url: "/pages/index/index" });
  },
  openPersonalStories() {
    stageRoomStateForStories(this.roomSnapshot);
    wx.reLaunch({ url: "/pages/stories/stories" });
  },
  onShareAppMessage(): {title:string;path:string} { const access = this.selectComponent('#book-access'); if (access && this.data.accessStoryId) return access.onShareAppMessage(); return { title: "拾光家忆｜把重要的故事慢慢写下来", path: "/pages/index/index" }; },
  onShareTimeline() { return { title: "拾光家忆｜把重要的故事慢慢写下来" }; },
});
