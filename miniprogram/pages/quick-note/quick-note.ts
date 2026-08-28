import {
  createContribution,
  FamilyMember,
  MAX_MEMORY_LENGTH,
  MemoryScope,
} from "../../domain/biography";
import {
  appendContribution,
  loadCurrentMember,
  loadRoomState,
} from "../../services/roomStorage";

interface ShareOption {
  id: string;
  name: string;
  relation: string;
  avatarText: string;
}

function toShareOption(member: FamilyMember): ShareOption {
  return {
    id: member.id,
    name: member.name,
    relation: member.relation,
    avatarText: member.avatarText,
  };
}

Page({
  data: {
    stage: "write" as "write" | "organize",
    memberName: "",
    memberRelation: "",

    text: "",
    textLength: 0,
    tooLong: false,

    destination: "personal" as MemoryScope,
    shareTargetId: "",
    shareOptions: [] as ShareOption[],

    keyboardHeight: 0,
    saving: false,
  },

  alertBeforeUnloadEnabled: false,

  onLoad() {
    const state = loadRoomState();
    const member = loadCurrentMember(state);
    this.setData({
      memberName: member.name,
      memberRelation: member.relation,
      shareOptions: state.members
        .filter((candidate) => candidate.id !== member.id)
        .map(toShareOption),
    });
  },

  onInput(event: { detail: { value: string } }) {
    const text = event.detail.value;
    this.setData({
      text,
      textLength: text.length,
      tooLong: text.length > MAX_MEMORY_LENGTH,
    });

    const shouldWarnBeforeUnload = Boolean(text.trim());
    if (shouldWarnBeforeUnload && !this.alertBeforeUnloadEnabled) {
      wx.enableAlertBeforeUnload({ message: "这段感受还没有保存，确定现在离开吗？" });
      this.alertBeforeUnloadEnabled = true;
    } else if (!shouldWarnBeforeUnload && this.alertBeforeUnloadEnabled) {
      wx.disableAlertBeforeUnload();
      this.alertBeforeUnloadEnabled = false;
    }
  },

  onKeyboardHeightChange(event: { detail: { height: number } }) {
    this.setData({ keyboardHeight: event.detail.height });
  },

  continueToOrganize() {
    if (!this.data.text.trim()) {
      wx.showToast({ title: "先写下一句话吧", icon: "none" });
      return;
    }
    if (this.data.tooLong) {
      wx.showToast({ title: `最多 ${MAX_MEMORY_LENGTH} 字`, icon: "none" });
      return;
    }
    this.setData({ stage: "organize", keyboardHeight: 0 });
  },

  backToWrite() {
    this.setData({ stage: "write" });
  },

  chooseDestination(event: { currentTarget: { dataset: { scope?: unknown } } }) {
    const destination = event.currentTarget.dataset.scope;
    if (destination !== "personal" && destination !== "family") {
      wx.showToast({ title: "请选择故事归属", icon: "none" });
      return;
    }
    this.setData({
      destination,
      shareTargetId: destination === "personal" ? this.data.shareTargetId : "",
    });
  },

  chooseShareTarget(event: { currentTarget: { dataset: { id: string } } }) {
    this.setData({ shareTargetId: event.currentTarget.dataset.id ?? "" });
  },

  save() {
    if (this.data.saving) return;
    this.setData({ saving: true });

    try {
      const state = loadRoomState();
      const member = loadCurrentMember(state);
      const isPersonal = this.data.destination === "personal";
      const shareTarget =
        isPersonal && this.data.shareTargetId
          ? state.members.find((candidate) => candidate.id === this.data.shareTargetId)
          : undefined;
      if (isPersonal && this.data.shareTargetId && !shareTarget) {
        throw new Error("这位家人已不在当前房间，请重新选择");
      }
      appendContribution(
        createContribution({
          authorMemberId: member.id,
          authorName: member.name,
          relation: member.relation,
          text: this.data.text,
          title: this.data.text.trim().slice(0, 18),
          memoryType: "note",
          scope: this.data.destination,
          visibility: isPersonal ? "private" : "family",
          sharedWithMemberId: shareTarget?.id,
        }),
        state,
      );

      wx.disableAlertBeforeUnload();
      this.alertBeforeUnloadEnabled = false;
      wx.showToast({
        title: isPersonal
          ? shareTarget
            ? `已存入我的书，并分享给${shareTarget.name}`
            : "已存入我的人生之书"
          : "已保存为家庭记忆，等待确认",
        icon: "none",
        duration: 2500,
      });
      setTimeout(() => wx.navigateBack(), 900);
    } catch (error) {
      this.setData({ saving: false });
      wx.showToast({
        title: error instanceof Error ? error.message : "暂时无法保存",
        icon: "none",
      });
    }
  },
});
