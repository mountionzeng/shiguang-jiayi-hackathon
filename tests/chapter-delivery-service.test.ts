import { strict as assert } from "node:assert";
import { test } from "node:test";
import { deliveryResolutionAfterImport } from "../miniprogram/services/chapterDelivery";

test("an explicitly imported return resolves as adopted; ordinary deliveries follow the chosen target", () => {
  assert.equal(deliveryResolutionAfterImport("return", "new"), "adopted");
  assert.equal(deliveryResolutionAfterImport("return", "append"), "adopted");
  assert.equal(deliveryResolutionAfterImport("send", "new"), "kept");
  assert.equal(deliveryResolutionAfterImport("send", "append"), "appended");
});

test("claim links accept the public origin and reject foreign, malformed or decorated URLs", async () => {
  const { chapterClaimToken } = await import("../miniprogram/services/chapterDelivery");
  const token = "A".repeat(43);
  const url = `https://www.drinkingtime.top/chapter/claim/${token}`;
  assert.equal(chapterClaimToken(` ${url}\n`), token);
  for (const bad of [token, url.replace("https:", "http:"), url.replace("www.drinkingtime.top", "evil.example"), `${url}?token=x`, `${url}#x`, url.slice(0, -1)]) {
    assert.throws(() => chapterClaimToken(bad), /完整领取链接/);
  }
});

 test("pending image review retries, while rejection and timeout never import silently", async () => {
  const { waitForChapterModeration } = await import("../miniprogram/services/chapterPackageService");
  let calls = 0;
  const pending = () => Object.assign(new Error("审核中"), { code: "MODERATION_PENDING" });
  assert.equal(await waitForChapterModeration(async () => { if (++calls < 3) throw pending(); return "saved"; }, async () => {}), "saved");
  assert.equal(calls, 3);
  calls = 0;
  await assert.rejects(waitForChapterModeration(async () => { calls++; throw Object.assign(new Error("拒绝"), { code: "CONTENT_REJECTED" }); }, async () => {}), /拒绝/);
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(waitForChapterModeration(async () => { calls++; throw pending(); }, async () => {}), /审核中/);
  assert.equal(calls, 15);
});


test("return uses the original chapter id, including exact legacy receipt recovery", async () => {
  const { chapterWithReturnSource } = await import("../miniprogram/services/chapterDelivery");
  const { exportChapterReturnPackage } = await import("../miniprogram/services/chapterPackageService");
  const chapter = { id: "chapter-local-copy", title: "副本", memoryIds: [], content: [{ text: "修改后\n" }],
    packageLineage: { rootPackageId: "cp_root0001", receivedPackageId: "cp_parent01" } };
  const receipt = { packageId: "cp_parent01", lineage: { rootPackageId: "cp_root0001" },
    chapters: [{ chapterId: "chapter-original" }] } as any;
  assert.throws(() => chapterWithReturnSource(chapter, {}), /缺少原章节编号/);
  assert.throws(() => chapterWithReturnSource(chapter, { wrong: { package: { ...receipt, packageId: "cp_other001" } } }), /缺少原章节编号/);
  const recovered = chapterWithReturnSource(chapter, { exact: { package: receipt } });
  assert.equal(recovered.id, "chapter-local-copy");
  const saved = chapterWithReturnSource(recovered, {});
  const result = exportChapterReturnPackage({ chapter: saved, packageId: "cp_return01", displayName: "我", createdAt: "2026-10-25T00:00:00.000Z", storyTitle: "故事" });
  assert.equal(result.package.chapters[0].chapterId, "chapter-original");
  assert.equal(chapter.packageLineage.hasOwnProperty("sourceChapterId"), false);
});
