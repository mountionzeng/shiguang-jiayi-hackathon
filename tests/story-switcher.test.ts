import assert from "node:assert/strict";
import test from "node:test";

interface SwitcherDefinition {
  data?: Record<string, unknown>;
  properties: Record<string, unknown>;
  methods: Record<string, (...args: unknown[]) => unknown>;
}

test("the persistent story switcher opens all three destinations", async () => {
  const previousComponent = Object.getOwnPropertyDescriptor(globalThis, "Component");
  const previousWx = Object.getOwnPropertyDescriptor(globalThis, "wx");
  let definition: SwitcherDefinition | undefined;
  const relaunches: string[] = [];
  const navigations: string[] = [];

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
    definition.methods.startInterview.call(instance);
    assert.equal(instance.data.chooserOpen, true);
    definition.methods.chooseCaptureMode.call(instance, {
      currentTarget: { dataset: { type: "memoir" } },
    });
    definition.methods.openFamily.call(instance);

    assert.deepEqual(relaunches, ["/pages/book/book", "/pages/room/room"]);
    assert.deepEqual(navigations, ["/pages/interview/interview?memoryType=memoir"]);
    assert.equal(instance.data.chooserOpen, false);
  } finally {
    if (previousComponent) Object.defineProperty(globalThis, "Component", previousComponent);
    else delete (globalThis as Record<string, unknown>).Component;
    if (previousWx) Object.defineProperty(globalThis, "wx", previousWx);
    else delete (globalThis as Record<string, unknown>).wx;
  }
});
