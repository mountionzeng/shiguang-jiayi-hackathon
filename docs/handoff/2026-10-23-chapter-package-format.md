# 交接：章节包格式 v1 与两端转换器（文档02）

日期：2026-10-23。分支：网页 `codex/chapter-package-format-20261022`（基于 main@f6728b9b），小程序 `codex/chapter-package-format-20261022`（基于 codex/integrate-invite-20261016@93fc0b9）。均未 push，未合并 main。

## 做成了什么

- 契约 1.0.0：`docs/integrations/chapter-package-contract.md`（网页为权威，小程序为同版本副本）。
- 网页 `shared/chapterPackage.ts`、小程序 `miniprogram/domain/chapterPackage.ts`：校验、打包、拆包，纯函数。
- 两仓 `tests/fixtures/chapter-package/` 共 9 个样例加 `SHA256SUMS`，逐字节一致，测试自动校验。
- 只新增文件；没改存储、页面、路由、`cloudfunctions/`、已有类型、`chapters.ts`、`docs/features/`。

## 规则要点

- **一行一块**：一行是一个文字模块的默认单位；排版可以把一个模块放在任意位置，但不能把两行合成一个模块。文字块不含换行、不为空。
- 警告 `MULTILINE_MODULE_SPLIT`：网页里某个模块被手改成多行，打包时拆成相邻的多个块（第一行保留 blockId，后面各行由原 blockId 和行号推出）。
- 警告 `EMPTY_TEXT_MODULE_DROPPED`：模块文字被清空，这一段不打包。
- 另有 `MODULE_TEXT_WINS`（模块里改过的文字优先于正文）、`UNREFERENCED_BLOCK_OMITTED`、`UNPLACED_BLOCKS` 等，见契约。
- 网页 `cover-title` 本身是单行，没有跨行；只有用户手改出换行的模块才会跨行。
- 不打包 `backdropImageId`。

## 03、04 必须知道

1. **blockId 要在留下副本时存下来。** 没有 blockId 的块，id 由内容推出，内容一改 id 就变，不能事后重算。`fromChapterPackage` 返回 `{chapter, layout, blockIds}`（网页是 `sidecar.blockIds`），不会把 blockId 写回章节；存哪里由 03/04 决定。发回时把存下的 blockIds 交给 `toChapterPackage`（网页的 sidecar 参数）才能对位。
2. **图片映射侧车。** 包里的 `assetId` 是不透明值（photoId 或网页图片键的哈希）。`toChapterPackage` 返回 `assetPhotos`（小程序）或 `assetKeys`（网页），`assetId` 到本端键的对应；传图片和收图片时都靠它。数据库里的数字 id 由调用方自己做映射。
3. **小程序按行分段由 04 负责。** 包 → 小程序时每个文字块变成 `{ text: 行 + "\n" }`，但 `chapters.ts` 现在按空行 `/\n\s*\n/` 分段，所以暂时显示为合并的一段。本轮没有改 `chapters.ts`。
4. **03 出现第一个用户入口时建功能卡**（相关已有卡：publishing-image-modules、story-context-sharing、shared-story-collaboration、wechat-desktop-story-entry）。本轮没动 `docs/features/`。

## 已知限制

- `STORY_IMAGE_REFERENCE`（`miniprogram/services/bookImages.ts`）没有导出，domain 层又不能 import services，所以 `AI_PHOTO_ID` 是复制的一份。测试用已导出的 `isStoryImageReference` 做行为对比，而不是比较正则源码。
- 小程序 `fromChapterPackage` 默认给图片生成 `photo-pkg-…` / `photo-ai-req-…`，真正的图片落地由 06 决定。
- 两端 SHA-256 各自手写，各自对照 node:crypto 的多组向量（含空串、中文）。

## 验证

- 网页：`pnpm vitest run shared/chapterPackage.test.ts` 34 个通过；`pnpm check` 无错误。
- 小程序：`npm run test:files -- tests/chapter-package.test.ts` 9 个通过；`npm run check` 1342 个通过。
- 两边 SHA256SUMS、样例目录、契约文档均相同。

## 需要用户决定

无。后续：03、04 各自从本分支接着做。
