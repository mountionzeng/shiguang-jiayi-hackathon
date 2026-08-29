import {
  createContribution,
  FamilyRoomState,
  reviewContribution,
} from "../miniprogram/domain/biography";

export function createDemoRoomStateForTests(): FamilyRoomState {
  return {
    roomName: "林家的拾光房间",
    protagonistName: "林致远",
    members: [
      { id: "elder", name: "林致远", relation: "主人公", avatarText: "远", role: "elder" },
      { id: "owner", name: "林岚", relation: "外孙女", avatarText: "岚", role: "owner" },
      { id: "member-1", name: "林秋", relation: "女儿", avatarText: "秋", role: "contributor" },
      { id: "member-2", name: "陈野", relation: "女婿", avatarText: "野", role: "contributor" },
      { id: "friend-1", name: "周明", relation: "多年好友", avatarText: "明", role: "contributor" },
    ],
    contributions: [
      createContribution({
        id: "demo-personal-rain",
        authorMemberId: "owner",
        authorName: "林岚",
        relation: "外孙女",
        text: "我小时候最喜欢下雨天，因为放学走到巷口时，总能看见外公带着两把伞在那里等我。",
        storyTitle: "外公接我放学",
        scope: "personal",
        visibility: "private",
        now: new Date("2026-08-28T02:05:00.000Z"),
      }),
      reviewContribution(
        createContribution({
          id: "demo-memory-rain",
          authorMemberId: "owner",
          authorName: "林岚",
          relation: "外孙女",
          text: "小时候每逢下雨，外公都会提前站在巷口等我放学，手里总多带一把小伞。",
          scope: "family",
          visibility: "family",
          now: new Date("2026-08-28T02:10:00.000Z"),
        }),
        "confirmed",
        "elder",
      ),
      createContribution({
        id: "demo-memory-radio",
        authorMemberId: "member-1",
        authorName: "林秋",
        relation: "女儿",
        text: "父亲年轻时喜欢修收音机，邻居家的机器坏了也常来找他。具体是哪一年，我记不清了。",
        scope: "family",
        visibility: "family",
        now: new Date("2026-08-28T02:18:00.000Z"),
      }),
    ],
    personalDrafts: {},
  };
}
