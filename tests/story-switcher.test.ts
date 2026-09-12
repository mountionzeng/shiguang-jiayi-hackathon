import assert from "node:assert/strict";
import test from "node:test";

import { createDemoRoomStateForTests } from "./fixtures";

interface SwitcherDefinition {
  data?: Record<string, unknown>;
  properties: Record<string, unknown>;
  methods: Record<string, (...args: unknown[]) => unknown>;
}

test("the persistent story switcher opens all three destinations, and 随手记 starts a fresh chat", async () => {
  const previousComponent = Object.getOwnPropertyDescriptor(globalThis, "Component");
  const previousWx = Object.getOwnPropertyDescriptor(globalThis, "wx");
  let definition: SwitcherDefinition | undefined;
  const relaunches: string[] = [];
  const navigations: string[] = [];
  const stored = new Map<string, unknown>([["shiguang-family-room-v5", createDemoRoomStateForTests()]]);

  Object.defineProperty(globalThis, "Component", {
    configurable: true,
    writable: true,
    value: (value: SwitcherDefinition) => {
      definition = value;
    },
  });
  Object.defineProperty(globalThis, "wx", {
    configurable: true,
    writable: true,
    value: {
      reLaunch: ({ url }: { url: string }) => relaunches.push(url),
      navigateTo: ({ url }: { url: string }) => navigations.push(url),
      getStorageSync: (key: string) => stored.get(key),
      setStorageSync: (key: string, value: unknown) => stored.set(key, value),
    },
  });

  try {
    const switcherModule = "../miniprogram/components/story-switcher/story-switcher";
    await import(switcherModule);
    assert.ok(definition);
    const data: Record<string, unknown> = {
      ...definition.data,
      current: "home",
    };
    const instance = {
      data,
      setData(update: Record<string, unknown>) {
        Object.assign(this.data, update);
      },
      ...definition.methods,
    };

    definition.methods.openPersonal.call(instance);

    // 随手记：不用先挑，直接开一段新的。
    definition.methods.startInterview.call(instance);
    assert.equal(instance.data.chooserOpen, true);
    assert.equal(instance.data.memoirOpen, false);
    definition.methods.startQuickNote.call(instance);
    assert.equal(instance.data.chooserOpen, false);

    // 回忆录：先看到最近三段，挑一段接着聊。
    definition.methods.startInterview.call(instance);
    await definition.methods.openMemoir.call(instance);
    assert.equal(instance.data.memoirOpen, true);
    const recent = instance.data.recent as Array<{ id: string; title: string; storyTitle: string; storyLabel: string }>;
    assert.deepEqual(recent.map((memory) => memory.id), ["demo-personal-rain"]);
    assert.equal(recent[0].storyLabel, "外公接我放学");
    assert.ok((instance.data.recent as unknown[]).length <= 3, "只列最近三段");

    definition.methods.continueMemory.call(instance, {
      currentTarget: { dataset: { id: recent[0].id, title: recent[0].storyTitle } },
    });
    assert.equal(instance.data.chooserOpen, false);

    // 点空白处（遮罩或弹层的空白）就关掉，回到什么都没选的状态。
    definition.methods.startInterview.call(instance);
    await definition.methods.openMemoir.call(instance);
    definition.methods.closeChooser.call(instance);
    assert.equal(instance.data.chooserOpen, false);
    assert.equal(instance.data.memoirOpen, false, "下次打开还是先问「这次怎么记」");

    definition.methods.startInterview.call(instance);
    definition.methods.openAllMemories.call(instance);
    definition.methods.openFamily.call(instance);

    assert.deepEqual(relaunches, ["/pages/stories/stories", "/pages/room/room"]);
    assert.deepEqual(navigations, [
      "/pages/interview/interview?memoryType=note",
      `/pages/interview/interview?memoryType=memoir&sourceId=demo-personal-rain&storyTitle=${encodeURIComponent("外公接我放学")}`,
      "/pages/recall/recall",
    ]);
  } finally {
    if (previousComponent) Object.defineProperty(globalThis, "Component", previousComponent);
    else delete (globalThis as Record<string, unknown>).Component;
    if (previousWx) Object.defineProperty(globalThis, "wx", previousWx);
    else delete (globalThis as Record<string, unknown>).wx;
  }
});
