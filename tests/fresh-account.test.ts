import assert from "node:assert/strict";
import test from "node:test";

// 审核员用的是全新微信账号：云端没有房间、没有人、没有记忆，也没填称呼。
// 这里只模拟 wx 的 I/O，页面、仓库、云存储代码都照常运行。

type Definition = { data?: Record<string, unknown>; methods?: Record<string, unknown>; [key: string]: unknown };
type Instance = { data: Record<string, unknown>; setData(update: Record<string, unknown>): void; [key: string]: unknown };

/** 真机上 doc(id).get() 读不存在的文档时，基础库给的错误。 */
const MISSING_DOC_ERROR = (id: string) => Object.assign(new Error("document.get:fail"), {
  errCode: -1,
  errMsg: `document.get:fail document.get:fail cannot find document with _id ${id}, please make sure that the document exists and you have the corresponding Read permission`,
});

function freshAccount() {
  const tables = new Map<string, Map<string, any>>();
  const records = (name: string) => {
    if (!tables.has(name)) tables.set(name, new Map());
    return tables.get(name)!;
  };
  const local = new Map<string, unknown>();
  const errors: unknown[][] = [];
  const previous = { wx: (globalThis as any).wx, getApp: (globalThis as any).getApp, error: console.error };
  console.error = (...args: unknown[]) => { errors.push(args); };
  (globalThis as any).getApp = () => ({ globalData: { cloudReady: true } });
  (globalThis as any).wx = {
    getStorageSync: (key: string) => local.get(key),
    setStorageSync: (key: string, value: unknown) => local.set(key, value),
    removeStorageSync: (key: string) => local.delete(key),
    showToast: () => undefined,
    navigateTo: () => undefined,
    reLaunch: () => undefined,
    setNavigationBarTitle: () => undefined,
    cloud: {
      callFunction: async ({ name }: { name: string }) => {
        if (name === "getOpenId") return { result: { openid: "fresh-reviewer", accountLinked: true } };
        throw new Error(`unexpected cloud function ${name}`);
      },
      database: () => ({
        serverDate: () => new Date(),
        collection: (name: string) => ({
          where: (filter: Record<string, unknown>) => {
            let offset = 0;
            let size = 20;
            const query = {
              orderBy: () => query,
              skip: (n: number) => { offset = n; return query; },
              limit: (n: number) => { size = n; return query; },
              get: async () => ({
                data: [...records(name)].map(([id, data]) => ({ ...data, _id: id }))
                  .filter(data => Object.entries(filter).every(([key, value]) => data[key] === value))
                  .slice(offset, offset + size),
              }),
            };
            return query;
          },
          doc: (id: string) => ({
            get: async () => {
              if (!records(name).has(id)) throw MISSING_DOC_ERROR(id);
              return { data: { ...records(name).get(id), _id: id } };
            },
            set: async ({ data }: any) => { records(name).set(id, structuredClone(data)); },
            update: async ({ data }: any) => { records(name).set(id, { ...records(name).get(id), ...data }); },
            remove: async () => { records(name).delete(id); },
          }),
        }),
      }),
    },
  };
  return {
    records,
    errors,
    restore() {
      (globalThis as any).wx = previous.wx;
      (globalThis as any).getApp = previous.getApp;
      console.error = previous.error;
    },
  };
}

let imports = 0;
async function capturePage(path: string): Promise<Instance> {
  let definition: Definition | undefined;
  const previous = (globalThis as any).Page;
  (globalThis as any).Page = (captured: Definition) => { definition = captured; };
  try { await import(`${path}?page=${++imports}`); } finally { (globalThis as any).Page = previous; }
  assert.ok(definition, `${path} registers a page`);
  const page = { ...definition, data: structuredClone(definition.data ?? {}) } as Instance;
  page.setData = (update) => Object.assign(page.data, update);
  return page;
}

const call = (page: Instance, method: string, ...args: unknown[]) =>
  (page[method] as (...values: unknown[]) => unknown).apply(page, args);

test("a brand-new WeChat account opens Memory Home without a load error", async (context) => {
  const env = freshAccount();
  context.after(env.restore);
  const room = await capturePage("../miniprogram/pages/room/room");
  call(room, "onLoad", {});
  await call(room, "refresh");
  assert.equal(room.data.loadError, "");
  assert.equal(room.data.hasAnyMemory, false);
  assert.deepEqual((room.data.people as Array<{ id: string }>).map(person => person.id), ["me"]);
});

test("a brand-new WeChat account opens every memory, the people list and home", async (context) => {
  const env = freshAccount();
  context.after(env.restore);

  const recall = await capturePage("../miniprogram/pages/recall/recall");
  await call(recall, "refresh");
  assert.equal(recall.data.hasItems, false);

  const profiles = await capturePage("../miniprogram/pages/profiles/profiles");
  call(profiles, "onLoad", {});
  await call(profiles, "refresh");
  assert.equal(profiles.data.loadError, "");

  const index = await capturePage("../miniprogram/pages/index/index");
  await call(index, "refresh");
});

test("a brand-new WeChat account can open the story switcher's recent memories", async (context) => {
  const env = freshAccount();
  context.after(env.restore);
  let definition: Definition | undefined;
  const previous = (globalThis as any).Component;
  (globalThis as any).Component = (captured: Definition) => { definition = captured; };
  try { await import("../miniprogram/components/story-switcher/story-switcher"); } finally { (globalThis as any).Component = previous; }
  assert.ok(definition?.methods);
  const switcher = { data: { ...definition.data }, setData(update: Record<string, unknown>) { Object.assign(this.data, update); }, ...definition.methods } as Instance;
  await call(switcher, "openMemoir");
  assert.equal(switcher.data.recentError, "");
  assert.equal(switcher.data.recentLoaded, true);
});

test("when loading fails, the page stays friendly but the real error code reaches the log", async (context) => {
  const env = freshAccount();
  context.after(env.restore);
  const denied = Object.assign(new Error("document.get:fail"), {
    errCode: -502003,
    errMsg: "document.get:fail database permission denied",
  });
  const cloud = (globalThis as any).wx.cloud;
  const database = cloud.database;
  cloud.database = () => {
    const db = database();
    return { ...db, collection: (name: string) => ({ ...db.collection(name), doc: () => ({ get: async () => { throw denied; } }) }) };
  };
  const room = await capturePage("../miniprogram/pages/room/room");
  call(room, "onLoad", {});
  call(room, "onShow");
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(room.data.loadError, "记忆暂时没加载出来，请重试。");
  const logged = env.errors.find(args => String(args[0]).includes("room"));
  assert.ok(logged, "the swallowed error is written to console.error");
  assert.equal((logged[1] as { errCode?: unknown }).errCode, -502003);
});
