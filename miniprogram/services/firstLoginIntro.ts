import { loadCurrentAccount } from "./accountService";
import { loadJoinedFamilyRooms } from "./familyInviteService";

/**
 * 第一次登录说明：只讲清楚，不写任何账号数据。
 * 「看过了」只记在本机，换手机或重装会再看一次；云端账号规则（getOpenId）不动。
 * 改文案后想让所有人重看，把 VERSION 加一。
 */
export const FIRST_LOGIN_INTRO_KEY = "firstLoginIntroSeen";
export const FIRST_LOGIN_INTRO_VERSION = 1;

/** 被邀请进来的人看到的补充信息；全部可选，缺的就不显示。 */
export interface IntroInvite {
  /** 邀请人的称呼。 */
  inviterName?: string;
  /** 邀请人写的话原文。 */
  inviterMessage?: string;
  /** 加入的记忆之家名。 */
  roomName?: string;
  /** 大家现在叫他的名字（沿用邀请人起的名字）。 */
  memberName?: string;
}

export interface IntroContent {
  title: string;
  lead: string;
  points: string[];
  /** 仅被邀请时出现，放在最上面。 */
  invite?: { heading: string; message: string; detail: string };
  button: string;
}

interface StoredSeen {
  version: number;
  seenAt: string;
}

function storageAvailable(): boolean {
  return typeof wx !== "undefined" && typeof wx.getStorageSync === "function";
}

/** 读不到本机存储时当作看过，宁可少弹一次，也不要每次打开都拦住用户。 */
export function hasSeenFirstLoginIntro(): boolean {
  if (!storageAvailable()) return true;
  try {
    const stored = wx.getStorageSync<StoredSeen | "">(FIRST_LOGIN_INTRO_KEY);
    return Boolean(stored) && typeof stored === "object" && stored.version >= FIRST_LOGIN_INTRO_VERSION;
  } catch {
    return true;
  }
}

export function markFirstLoginIntroSeen(): void {
  if (!storageAvailable() || typeof wx.setStorageSync !== "function") return;
  try {
    wx.setStorageSync(FIRST_LOGIN_INTRO_KEY, {
      version: FIRST_LOGIN_INTRO_VERSION,
      seenAt: new Date().toISOString(),
    } satisfies StoredSeen);
  } catch (error) {
    console.warn("第一次登录说明的已读记录暂未保存", error);
  }
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function buildFirstLoginIntro(invite?: IntroInvite): IntroContent {
  const inviterName = clean(invite?.inviterName);
  const inviterMessage = clean(invite?.inviterMessage);
  const roomName = clean(invite?.roomName);
  const memberName = clean(invite?.memberName);
  const invited = Boolean(inviterName || inviterMessage || roomName || memberName);

  const content: IntroContent = {
    title: "欢迎来到拾光家忆",
    lead: "这里帮你把说过的话、想起的事，一点点整理成属于自己和家人的故事书。",
    points: [
      "你有一个只属于自己的记忆之家，用微信登录时已经为你准备好了，不用另外建。",
      "你写下和说出的内容只有你自己看得到；只有你主动分享给某个人，对方才看得到。",
      "称呼可以随时在「我的」里修改。",
    ],
    button: "知道了",
  };
  if (!invited) return content;

  const who = inviterName ? `${inviterName}邀请你来` : "有朋友邀请你来";
  const joined = roomName ? `你已经加入「${roomName}」` : "你已经加入对方的记忆之家";
  const called = memberName ? `，大家叫你「${memberName}」` : "";
  content.invite = {
    heading: who,
    message: inviterMessage,
    detail: `${joined}${called}。你可以读对方分享给你的章节，也可以回信；写进书里与否，由对方决定。`,
  };
  return content;
}

function withTimeout<T>(task: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), timeoutMs);
    task.then(
      (value) => { clearTimeout(timer); resolve(value); },
      () => { clearTimeout(timer); resolve(undefined); },
    );
  });
}

/**
 * 只读：看自己是否被加进了别人的记忆之家。失败或超时一律当作「自己下载进来的」，
 * 通用说明照样能显示。不写账号、不建空间。
 */
export function loadIntroInvite(timeoutMs = 3000): Promise<IntroInvite | undefined> {
  const task = (async (): Promise<IntroInvite | undefined> => {
    const [account, rooms] = await Promise.all([loadCurrentAccount(), loadJoinedFamilyRooms()]);
    const invited = rooms.find((room) => room.familyId && room.familyId !== account.primaryFamilyId);
    if (!invited) return undefined;
    return { roomName: invited.roomName, memberName: invited.memberName };
  })();
  return withTimeout(task, timeoutMs);
}
