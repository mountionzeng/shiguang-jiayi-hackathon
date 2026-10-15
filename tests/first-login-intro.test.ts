import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  buildFirstLoginIntro,
  FIRST_LOGIN_INTRO_KEY,
  FIRST_LOGIN_INTRO_VERSION,
  hasSeenFirstLoginIntro,
  loadIntroInvite,
  markFirstLoginIntroSeen,
} from "../miniprogram/services/firstLoginIntro";

function withWx<T>(wxMock: unknown, run: () => Promise<T> | T): Promise<T> {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "wx");
  Object.defineProperty(globalThis, "wx", { configurable: true, writable: true, value: wxMock });
  return Promise.resolve()
    .then(run)
    .finally(() => {
      if (previous) Object.defineProperty(globalThis, "wx", previous);
      else delete (globalThis as Record<string, unknown>).wx;
    });
}

function storageWx(initial: Record<string, unknown> = {}) {
  const store = new Map<string, unknown>(Object.entries(initial));
  return {
    store,
    wx: {
      getStorageSync: (key: string) => store.get(key),
      setStorageSync: (key: string, value: unknown) => store.set(key, value),
    },
  };
}

test("自己下载进来的人看到通用说明，覆盖是什么、独立空间、别人看不到、称呼可改", () => {
  const intro = buildFirstLoginIntro();
  const text = [intro.title, intro.lead, ...intro.points].join("\n");
  assert.equal(intro.invite, undefined);
  assert.match(text, /拾光家忆/);
  assert.match(text, /只属于自己的记忆之家/);
  assert.match(text, /只有你自己看得到/);
  assert.match(text, /称呼可以随时在「我的」里修改/);
  assert.equal(intro.button, "知道了");
});

test("被邀请进来的人在最上面看到邀请人的话和自己的称呼，仍保留通用说明", () => {
  const intro = buildFirstLoginIntro({
    inviterName: "岱",
    inviterMessage: "想请你帮我补几段小时候的事",
    roomName: "岱的记忆之家",
    memberName: "小舅",
  });
  assert.ok(intro.invite);
  assert.match(intro.invite.heading, /岱邀请你来/);
  assert.equal(intro.invite.message, "想请你帮我补几段小时候的事");
  assert.match(intro.invite.detail, /「岱的记忆之家」/);
  assert.match(intro.invite.detail, /大家叫你「小舅」/);
  assert.match(intro.invite.detail, /由对方决定/);
  assert.match(intro.points.join("\n"), /只属于自己的记忆之家/);
});

test("邀请信息只有一部分时不显示空的占位，空白字符串按没有处理", () => {
  const partial = buildFirstLoginIntro({ roomName: "老屋", inviterName: "  ", inviterMessage: "" });
  assert.ok(partial.invite);
  assert.equal(partial.invite.heading, "有朋友邀请你来");
  assert.equal(partial.invite.message, "");
  assert.doesNotMatch(partial.invite.detail, /大家叫你/);
  assert.equal(buildFirstLoginIntro({ inviterName: " ", roomName: "" }).invite, undefined);
});

test("已读记录只存本机：没记过就该弹，点知道了之后不再弹，且按版本号判断", async () => {
  const { wx, store } = storageWx();
  await withWx(wx, () => {
    assert.equal(hasSeenFirstLoginIntro(), false);
    markFirstLoginIntroSeen();
    assert.equal(hasSeenFirstLoginIntro(), true);
    const saved = store.get(FIRST_LOGIN_INTRO_KEY) as { version: number; seenAt: string };
    assert.equal(saved.version, FIRST_LOGIN_INTRO_VERSION);
    assert.ok(!Number.isNaN(Date.parse(saved.seenAt)));
    store.set(FIRST_LOGIN_INTRO_KEY, { version: FIRST_LOGIN_INTRO_VERSION - 1, seenAt: "x" });
    assert.equal(hasSeenFirstLoginIntro(), false);
    store.set(FIRST_LOGIN_INTRO_KEY, "garbage");
    assert.equal(hasSeenFirstLoginIntro(), false);
  });
});

test("读不到本机存储时当作看过，不会每次打开都拦住用户；写失败不抛错", async () => {
  await withWx({}, () => {
    assert.equal(hasSeenFirstLoginIntro(), true);
    assert.doesNotThrow(() => markFirstLoginIntroSeen());
  });
  await withWx({
    getStorageSync: () => { throw new Error("storage unavailable"); },
    setStorageSync: () => { throw new Error("storage full"); },
  }, () => {
    assert.equal(hasSeenFirstLoginIntro(), true);
    assert.doesNotThrow(() => markFirstLoginIntroSeen());
  });
});

function cloudWx(handlers: Record<string, (data: Record<string, unknown>) => unknown>, calls: string[] = []) {
  return {
    cloud: {
      callFunction: async ({ name, data }: { name: string; data: Record<string, unknown> }) => {
        calls.push(`${name}:${String(data.action)}`);
        const handler = handlers[`${name}:${String(data.action)}`];
        if (!handler) throw new Error(`unexpected ${name}:${String(data.action)}`);
        return { result: handler(data) };
      },
    },
  };
}

const ACCOUNT = { accountLinked: true, account: { accountId: "account_1", primaryFamilyId: "family_mine", displayName: "" } };

test("加入过别人的记忆之家才算被邀请；只有自己的空间时是通用说明；整个过程只读", async () => {
  const calls: string[] = [];
  const own = cloudWx({
    "getOpenId:get": () => ACCOUNT,
    "familyInvite:listRooms": () => ({ rooms: [{ familyId: "family_mine", roomName: "我的", memberName: "我", relation: "本人", avatarText: "我" }] }),
  }, calls);
  await withWx(own, async () => assert.equal(await loadIntroInvite(), undefined));

  const invited = cloudWx({
    "getOpenId:get": () => ACCOUNT,
    "familyInvite:listRooms": () => ({
      rooms: [
        { familyId: "family_mine", roomName: "我的", memberName: "我", relation: "本人", avatarText: "我" },
        { familyId: "family_dai", roomName: "岱的记忆之家", memberName: "小舅", relation: "亲友", avatarText: "小" },
      ],
    }),
  }, calls);
  await withWx(invited, async () => {
    assert.deepEqual(await loadIntroInvite(), { roomName: "岱的记忆之家", memberName: "小舅" });
  });
  assert.ok(calls.every((call) => call === "getOpenId:get" || call === "familyInvite:listRooms"), calls.join(","));
});

test("查询邀请失败或超时时退回通用说明，不阻塞、不抛错", async () => {
  await withWx(cloudWx({
    "getOpenId:get": () => ACCOUNT,
    "familyInvite:listRooms": () => { throw new Error("FUNCTION_NOT_FOUND"); },
  }), async () => assert.equal(await loadIntroInvite(), undefined));

  // 账号读取在模块内共享同一个进行中的请求，挂起的调用必须在用例结束前失败，
  // 否则会把后面用例也卡住。
  const rejectors: Array<(error: Error) => void> = [];
  const hanging = {
    cloud: { callFunction: () => new Promise((_, reject) => { rejectors.push(reject); }) },
  };
  await withWx(hanging, async () => {
    const started = Date.now();
    assert.equal(await loadIntroInvite(30), undefined);
    assert.ok(Date.now() - started < 1000);
    rejectors.forEach((reject) => reject(new Error("test cleanup")));
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
});

test("首页只挂接说明组件；组件不写账号、不改称呼、不碰云端写操作", () => {
  const index = fs.readFileSync("miniprogram/pages/index/index.wxml", "utf8");
  assert.match(index, /<first-login-intro><\/first-login-intro>/);
  assert.match(fs.readFileSync("miniprogram/pages/index/index.json", "utf8"), /"first-login-intro": "\/components\/first-login-intro\/first-login-intro"/);
  const source = [
    fs.readFileSync("miniprogram/services/firstLoginIntro.ts", "utf8"),
    fs.readFileSync("miniprogram/components/first-login-intro/first-login-intro.ts", "utf8"),
  ].join("\n");
  assert.doesNotMatch(source, /saveCurrentAccountName|updateProfile|acceptFamilyInvitation|createFamilyInvitation|submitSharedContribution/);
  assert.doesNotMatch(source, /callFunction/);
});

test("说明组件：未看过时弹出，点知道了后关闭并记录，已看过的不再弹", async () => {
  const previousComponent = Object.getOwnPropertyDescriptor(globalThis, "Component");
  let definition: { data: Record<string, unknown>; lifetimes: { attached(this: unknown): void }; methods: Record<string, (...args: unknown[]) => unknown> } | undefined;
  Object.defineProperty(globalThis, "Component", {
    configurable: true,
    writable: true,
    value: (value: typeof definition) => { definition = value; },
  });
  try {
    const componentModule = "../miniprogram/components/first-login-intro/first-login-intro";
    await import(componentModule);
    assert.ok(definition);
    const make = () => {
      const events: string[] = [];
      const instance: Record<string, unknown> & { data: Record<string, unknown> } = {
        data: { ...definition!.data, inviterName: "", inviterMessage: "" },
        setData(update: Record<string, unknown>) { Object.assign(this.data, update); },
        triggerEvent: (name: string) => events.push(name),
        ...definition!.methods,
      };
      return { instance, events };
    };

    const first = storageWx();
    await withWx({ ...first.wx, cloud: cloudWx({ "getOpenId:get": () => ACCOUNT, "familyInvite:listRooms": () => ({ rooms: [] }) }).cloud }, async () => {
      const { instance, events } = make();
      definition!.lifetimes.attached.call(instance);
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(instance.data.visible, true);
      assert.equal((instance.data.content as { invite?: unknown }).invite, undefined);
      (instance.dismiss as () => void)();
      assert.equal(instance.data.visible, false);
      assert.deepEqual(events, ["close"]);
      assert.equal(hasSeenFirstLoginIntro(), true);

      const again = make();
      definition!.lifetimes.attached.call(again.instance);
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(again.instance.data.visible, false);
    });

    const invitedWx = storageWx();
    await withWx({ ...invitedWx.wx, cloud: cloudWx({ "getOpenId:get": () => ACCOUNT, "familyInvite:listRooms": () => ({ rooms: [] }) }).cloud }, async () => {
      const { instance } = make();
      instance.data.inviterName = "岱";
      instance.data.inviterMessage = "来聊聊吧";
      definition!.lifetimes.attached.call(instance);
      await new Promise((resolve) => setTimeout(resolve, 20));
      const invite = (instance.data.content as { invite?: { heading: string; message: string } }).invite;
      assert.equal(invite?.heading, "岱邀请你来");
      assert.equal(invite?.message, "来聊聊吧");
    });
  } finally {
    if (previousComponent) Object.defineProperty(globalThis, "Component", previousComponent);
    else delete (globalThis as Record<string, unknown>).Component;
  }
});
