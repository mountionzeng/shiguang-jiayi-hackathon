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

interface RoomLoadOptions { familyId?: string; }

function decodeFamilyId(value = ""): string {
  try { return decodeURIComponent(value).trim(); } catch { return ""; }
}

/**
 * 记忆之家：先是人，再是记忆。
 * 点「你」看全部记忆，点某个人看和 ta 有关的记忆；写没写进书都在这里。
 * 名单本身（加人、删人、恢复）在「家人和朋友」页。
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
  onUnload() { this.loadSequence++; },
  data: {
    people: [] as PersonTab[],
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
  },

  onLoad(options: RoomLoadOptions = {}) {
    this.setData({ sharedFamilyId: decodeFamilyId(options.familyId) });
  },

  onShow() {
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
    this.roomSnapshot = this.data.sharedFamilyId ? undefined : currentState;
    const pool = memoryPool(currentState.contributions);
    const placements = memoryPlacements(currentState);
    const people: PersonTab[] = [
      { id: ME, name: "你", relation: "全部记忆", avatarText: "我", count: pool.length },
      ...currentState.members.filter((member) => isActiveMember(member) && !isSelf(member)).map((member) => ({
        id: member.id,
        name: member.name,
        relation: member.relation,
        avatarText: member.avatarText,
        count: memoriesWith(pool, member.id).length,
      })),
    ];
    const active = people.find((person) => person.id === this.data.activeId) ?? people[0];
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

    this.setData({
      people,
      loading: false,
      loadingDetails: preview,
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
    });
  },

  choosePerson(event: { currentTarget: { dataset: { id: string } } }) {
    this.setData({ activeId: event.currentTarget.dataset.id });
    void this.refresh(this.roomSnapshot, this.data.loadingDetails).catch((error) => { logLoadError("room", error); this.setData({ loadError: "记忆暂时没加载出来，请重试。" }); });
  },

  openMemory(event: { currentTarget: { dataset: { id: string } } }) {
    stageRoomStateForArchive(event.currentTarget.dataset.id, this.data.loadingDetails ? undefined : this.roomSnapshot);
    wx.navigateTo({ url: "/pages/archive/archive?id=" + encodeURIComponent(event.currentTarget.dataset.id) });
  },

  openPeople() {
    wx.navigateTo({ url: "/pages/profiles/profiles?mode=people" });
  },

  startInterview() {
    const query = this.data.sharedFamilyId ? `?familyId=${encodeURIComponent(this.data.sharedFamilyId)}` : "";
    wx.navigateTo({ url: `/pages/interview/interview${query}` });
  },

  inviteFamilyMember() { wx.navigateTo({ url: "/pages/invite/invite" }); },

  retryLoad() { this.onShow(); },

  goHome() {
    wx.reLaunch({ url: "/pages/index/index" });
  },
  openPersonalStories() {
    stageRoomStateForStories(this.roomSnapshot);
    wx.reLaunch({ url: "/pages/stories/stories" });
  },
  onShareAppMessage() { return { title: "拾光家忆｜把重要的故事慢慢写下来", path: "/pages/index/index" }; },
  onShareTimeline() { return { title: "拾光家忆｜把重要的故事慢慢写下来" }; },
});
