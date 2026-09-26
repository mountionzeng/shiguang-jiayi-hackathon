# 图片侧发送接入事实与最小契约

日期：2026-09-25  
来源：`main` / `f39abb4`，对照 `send-image-integration-plan/docs/plans/2026-09-25-001-feat-send-image-integration-plan.md`。

## 现有图片能力

### 章节插图

- `storyImages.submit` 支持 `purpose: "illustration"`，输入是 `storyId + chapterId` 或旧 `memberId + chapterId`，不接 `memoryId`。
- 单次请求生成一张图，`requestId` 是幂等键；同一 `requestId` 且输入一致会返回旧任务，不重复下单；输入变化返回 `REQUEST_CONFLICT`。
- 当前已支持：直接生成、参考旧章节插图、参考本章正文里的真实照片、用户填写的美术想法。
- 参考本章照片要求客户端传 `referencePhotoIds` 和 `photoReferenceConsent: true`；服务端校验照片必须属于本章正文，并通过 `photoAccess` 读取临时链接给视觉分析和 TokenHub。
- 生成完成后落在 `story_images`，`purpose: "illustration"`，并通过 `storyImageApi.listStoryImages(storyId)` 暴露给页面。

### 书封面

- `storyCoverService.submit()` 调 `storyImages.submit`，固定 `purpose: "cover"`，单次生成一张封面。
- 封面输入只支持 `storyId`；云端读取当前 active story draft 的整本书正文作为上下文。现有代码不支持 `memoryId`、单段记忆修订、历史修订或调用方提供正文。
- 封面可混选最多 3 张参考图，来源包括本书照片和已通过审核的本书 AI 图片；不接任意 URL。
- 封面支持 `artDirection`，需要云端 capability `guidedGeneration`。
- `story-cover` 页面展示候选图库和 pending jobs，但按钮语义是“生成一张封面”；点击“设为封面”会调用 `selectCover`，更新 `stories.coverImageId` 并递增 story version，首页/书本封面随之变化。
- `selectCover` 只接受通过审核且属于当前书的 `purpose: "cover"` 图片；它是永久书封面选择，不是临时分享选择。

### 发送页当前接入

- 当前社交发送页只读取 `snapshot.coverImageId`，再用 `storyCoverApi.resolveUrl(storyId, coverImageId)` 得到当前书封面 URL。
- 如果没有封面，发送页只跳 `/pages/story-cover/story-cover?storyId=...`；返回后刷新当前书稿版本，因为选封面会改变 `story.version`。
- `bookExport` / `storyBooks.bookExports` 的 descriptor 只包含单个 `coverImageId`。服务端只签当前 `story.coverImageId` 对应的封面文件，且要求 story/version/coverFileID 未变化。
- 发送侧没有多封面 descriptor，也没有“本次分享临时封面”的图片输入。正文分页数量、导出 descriptor 和渲染仍归发送模块维护。

## 缺口

1. 多封面候选未实现。现有能力可以连续多次提交单张封面，但没有批量 API、批次状态、数量选择、部分失败汇总或取消未提交任务。
2. 临时分享封面未实现。现有 `selectCover` 会写回书封面；发送需求里的“只用于本次分享”的候选不能复用 `selectCover`。
3. 单记忆封面未实现。封面云端只读整本书 active draft；如果 U1 提供的是单记忆修订，图片侧需要新的 source contract 才能把提示词绑定到同一记忆修订。不能把未入书记忆伪装成 `storyId`，也不能暗中改为整书上下文。
4. 现有封面 Job 记录 `sourceRevisionId`、`source.textHash` 和参考图计数，但没有分享批次 ID、目标数量或“用于分享”的用途标记。若要接多封面分享，需要补充最小元数据，便于发送侧恢复和校验。
5. `StoryImagePurpose` 客户端类型目前只声明章节用途；封面依赖 `StoryImageJob.purpose: string` 绕过类型，若新增发送专用封面接口，需要一并收紧类型。

## 建议的最小衔接

图片侧只补“封面候选供发送选择”，不要复制发送页、正文分页或导出校验。

建议在 `miniprogram/services/storyCoverService.ts` 增加面向发送侧的轻包装能力：

- `listShareCoverCandidates(storyId)`：复用 `storyImageApi.listStoryImages(storyId)`，只返回 `purpose === "cover" && moderation === "pass"` 的候选 `{ imageId, url, createdAtMs }`，并带 pending cover jobs。这个接口不写回书封面。
- `submitShareCoverCandidate(input)`：复用现有 `submit()` 单张生成，仍使用 `requestId` 幂等；调用方要几张就顺序调用几次。首版不做批量付费 API，数量循环留在发送/协调层，但每次新增生成前必须由用户确认。
- `checkShareCoverJob(storyId, jobId)`：复用 `storyImageApi.checkImageJob(jobId, storyId)`，只返回封面 job/image，供发送页恢复部分完成状态。
- `resolveCoverCandidates(storyId, imageIds[])` 或等价服务端校验接口：若发送侧需要在导出 descriptor 中带临时封面，应由 `storyBooks.bookExports` 服务端校验这些 imageId 的归属、purpose、moderation、fileID 路径和版本一致性；图片侧可提供客户端 URL 预览，但最终导出校验归发送侧。

如果产品确认“封面数量选择”要有真正批量体验，再考虑在图片侧新增 `submitCoverBatch`。但它仍应只是多个单张 job 的编排：逐张提交稳定 `requestId`、达到额度立即停、返回已提交/失败/未提交列表；不应绕过现有单张 `submit/status/list` 状态机。

## 文件归属

图片侧负责：

- `miniprogram/services/storyCoverService.ts`
- `miniprogram/pages/story-cover/story-cover.ts`
- `miniprogram/pages/story-cover/story-cover.wxml`
- `cloudfunctions/storyImages/index.js`
- `cloudfunctions/storyImages/core.js`
- `cloudfunctions/storyImages/cover.js`
- `cloudfunctions/storyImages/flow.js`
- `tests/story-cover.test.js`
- `tests/story-images.test.js`
- `tests/story-images-page.test.ts`

发送侧负责：

- 发送入口、来源锁定、正文目标张数、分页、导出 descriptor、服务端导出校验、相册保存和邀请范围。
- 若导出要接受临时多封面 imageIds，需要在 `bookExport` / `storyBooks.bookExports` 扩展 descriptor 和服务端校验；图片侧只提供候选与生成状态。

## 给 U2/U1 的结论

- 现有图片模块可被复用，但现在只保证 `storyId`、单次一张、候选存入图库、用户另行选择是否设为书封面。
- 发送流程若要“几张封面”，首版最小实现应把数量解释为“需要多少个可选候选”：复用单张任务顺序生成，完成后把通过审核的 cover imageIds 交给发送侧临时选择。
- 发送流程若要“本次分享封面不改书封面”，不要调用 `selectCover`；也不要依赖 `snapshot.coverImageId` 作为唯一封面来源。
- 未入书记忆或指定历史记忆修订不应直接调用当前封面接口；需要 U1 先给出可由云端复原的 source contract，图片侧再扩展 cover source 读取。
