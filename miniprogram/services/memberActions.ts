import { FamilyMember, FamilyRoomState, memoryPool } from "../domain/biography";
import { deleteMemberRemoteFirst } from "./roomRepository";

function deleteMessage(member: FamilyMember, state: FamilyRoomState): string {
  if (member.kind === "person") {
    return `会把「${member.name}」从记忆的「涉及的人」和「谁可以看」里去掉，记忆本身不删。ta 会放进「最近删除」，恢复后这些需要重新设置。`;
  }
  const told = memoryPool(state.contributions).filter((memory) => memory.authorMemberId === member.id).length;
  return `「${member.name}」的书稿和所有版本会放进「最近删除」，不再显示，随时可以恢复。`
    + (told ? `ta 讲过的 ${told} 段记忆留在记忆库里，其他书照样能用。` : "");
}

/**
 * Asks in plain words, then soft-deletes. Resolves to the new state, or undefined when
 * the user cancels or the delete fails (the failure is shown; retrying is safe).
 */
export function deleteMemberWithConfirm(
  member: FamilyMember,
  state: FamilyRoomState,
): Promise<FamilyRoomState | undefined> {
  return new Promise((resolve) => wx.showModal({
    title: `删除「${member.name}」？`,
    content: deleteMessage(member, state),
    confirmText: "删除",
    confirmColor: "#c75245",
    success: async (result) => {
      if (!result.confirm) { resolve(undefined); return; }
      wx.showLoading({ title: "正在删除", mask: true });
      try {
        const next = await deleteMemberRemoteFirst(member.id);
        wx.hideLoading();
        wx.showToast({ title: "已放进最近删除", icon: "none" });
        resolve(next);
      } catch (error) {
        wx.hideLoading();
        wx.showToast({ title: error instanceof Error ? error.message : "删除没有完成，请重试", icon: "none" });
        resolve(undefined);
      }
    },
    fail: () => resolve(undefined),
  }));
}
