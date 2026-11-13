import test from "node:test";
import assert from "node:assert/strict";
let definition: any;
(globalThis as any).Page = (value: any) => {
  definition = value;
};
async function page() {
  await import("../miniprogram/packages/web-mailbox/pages/index/index");
  return {
    ...definition,
    data: structuredClone(definition.data),
    setData(value: any) {
      Object.assign(this.data, value);
    },
  };
}
test("scan previews without accepting, and failed content read retains the private receipt id for retry", async () => {
  const calls: string[] = [];
  (globalThis as any).wx = {
    hideShareMenu() {},
    cloud: {
      callFunction: async ({ data }: any) => {
        calls.push(data.action);
        if (data.action === "mailboxPreview")
          return { result: { title: "Chosen story" } };
        if (data.action === "mailboxConfirm")
          return { result: { id: "12345678-1234-1234-1234-123456789abc" } };
        throw new Error("offline");
      },
    },
  };
  const p = await page();
  p.onLoad({ scene: "wm_" + "A".repeat(28) });
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(calls, ["mailboxPreview"]);
  assert.equal(p.data.preview.title, "Chosen story");
  await p.confirm();
  assert.equal(p.data.code, "");
  assert.equal(p.data.document.id, "12345678-1234-1234-1234-123456789abc");
  await p.refresh();
  assert.equal(calls[calls.length - 1], "mailboxRead");
  assert.equal(calls.filter((c) => c === "mailboxConfirm").length, 1);
  assert.equal(p.onShareAppMessage().path, "/pages/index/index");
});
test("a friend cannot generate a new share link and an unmounted read cannot replace the page", async () => {
  let finish: any,
    calls = 0;
  (globalThis as any).wx = {
    hideShareMenu() {},
    showModal() {
      throw new Error("should not share");
    },
    cloud: {
      callFunction: () => {
        calls++;
        return new Promise((r) => (finish = r));
      },
    },
  };
  const p = await page();
  p.data.document = { id: "friend", mine: false };
  p.prepareShare();
  assert.equal(calls, 0);
  const pending = p.read("12345678-1234-1234-1234-123456789abc");
  p.onUnload();
  finish({ result: { document: { id: "late" } } });
  await pending;
  assert.equal(p.data.document.id, "friend");
});


test("cloud invocation failure ends loading and shows a retryable message without server internals", async () => {
  (globalThis as any).wx = {
    hideShareMenu() {},
    cloud: { callFunction: async () => { throw new Error("mailbox_disabled at /var/user/index.js with request-id private-trace"); } },
  };
  const p = await page();
  await p.refresh();
  assert.equal(p.data.busy, false);
  assert.equal(p.data.error, "网页故事暂时无法读取，请稍后重试。");
  (globalThis as any).wx.cloud.callFunction = async () => ({ result: { stories: [] } });
  await p.refresh();
  assert.equal(p.data.error, "");
  assert.deepEqual(p.data.stories, []);
});

test("opening the inbox after a QR visit ignores the stale launch scene, but a new scan still previews", async () => {
  let scene = "wm_" + "A".repeat(28);
  const calls: Array<{ action: string; code?: string }> = [];
  (globalThis as any).wx = {
    hideShareMenu() {},
    getEnterOptionsSync: () => ({ path: "packages/web-mailbox/pages/index/index", query: { scene } }),
    cloud: { callFunction: async ({ data }: any) => {
      calls.push(data);
      if (data.action === "mailboxList") return { result: { stories: [{ id: "receipt", title: "Paper stars" }] } };
      if (data.code === "A".repeat(28)) throw new Error("expired QR");
      return { result: { title: "New scan" } };
    } },
  };
  const p = await page();
  p.onLoad({});
  p.onShow();
  await new Promise(r => setTimeout(r, 5));
  assert.deepEqual(calls.map(c => c.action), ["mailboxList"]);
  assert.equal(p.data.error, "");
  assert.equal(p.data.stories[0].title, "Paper stars");
  scene = "wm_" + "B".repeat(28);
  p.onShow();
  await new Promise(r => setTimeout(r, 5));
  assert.deepEqual(calls.map(c => c.action), ["mailboxList", "mailboxPreview"]);
  assert.equal(p.data.preview.title, "New scan");
});
