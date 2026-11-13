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
