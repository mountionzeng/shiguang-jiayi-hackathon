# 交接：一行一个模块与当前行对话上下文（小程序侧）

日期：2026-10-23。分支 `codex/line-modules-20261023`，基于文档 02 的 `cc9cf3d`，已合并 `aaaba5f`（无冲突）。未 push，未部署。

## 做了什么

- `miniprogram/domain/lineModules.ts`：与网页 `shared/lineModules.ts` 同一份纯函数（拆行、id 对账、光标定位、上下文裁剪），两端用 `tests/fixtures/line-modules/cases.json` 同一组样例，附 `SHA256SUMS`。
- `miniprogram/services/lineContext.ts`：当前行判断与显示拆行。
  - 有选中文字：在全文行里找，只有唯一匹配才认。
  - 没选中：用 `getSelection` 返回的光标下标定位。
  - 正文含照片时，光标下标与纯文本对不上，不使用。
  - 拿不到可靠位置就不带当前行，聊天照常。
- `pages/book/book.ts`：打开小忆时调用一次 `captureLineContext`，把当前行说明放在小忆原有上下文文字前面。不监听输入，不发请求，没有新按钮。
- `cloudfunctions/chatInterview/index.js`：只有 `sourceText` 以「【用户停在第」开头时，系统提示追加一句：先问他想往哪个方向写，或给两三条思路，他回应之后再给改写，不要直接替他改字。其余提示词不变。
- 显示：阅读页（`packages/story-sharing/pages/read`）和书稿历史版本预览，每个文字块里的每个非空行单独成段。

## 开关与基础库

- `miniprogram/config/runtime.ts` 的 `LINE_CONTEXT_CHAT_ENABLED = false`，默认关闭。关闭时不判断当前行，小忆行为与改动前一致。
- `getSelection` 需要基础库 3.7.11。`project.private.config.json` 里开发者工具的 libVersion 是 3.17.3，只代表开发调试环境，不代表用户手机的最低版本。代码用特性检测，没有该接口就降级为「选中文字匹配」，再不行就不带当前行。
- 全仓库没有用 `bindstatuschange`，类型包里也查不到，所以没有使用。

## 必须知道

- 小忆提示词那句规则要**部署 `chatInterview` 云函数**才会生效，这次没部署。
- `sourceText` 在云函数里截到 500 字，是现有行为，没改。当前行说明放在最前面，不会被截掉，但原文正文可能被截。
- 小忆是否真的先问方向，取决于模型，未用真实模型验证。

## 没做的事

- 数据层的分段没动：`services/chapters.ts:56` 和 `cloudfunctions/storyBooks/core.js:52` 仍按空行拆段，由文档 04 处理。
- 以下依赖那个分段，等文档 04 的数据层合入后再接：分享卡的 `descriptor.paragraphs`、书架摘要 `storyShelf`、`manuscript` 里保存用的 `paragraphs`。
- 行 id 对账只有纯函数和测试，没有接进存储。
- 没有真机验证，没有在开发者工具里看过实际显示，没有真实模型调用。

## 测试

- `npx tsc --noEmit`：无错误。
- `npm test`：1380 项全部通过，0 失败。
- 新增：`tests/line-modules.test.ts`（样例、哈希、定位、显示拆行、开关默认关），`tests/cloud-function.test.js` 里一项用模拟 fetch 走完整请求，确认规则有标记才出现。

## 与其他文档的重叠

`miniprogram/pages/book/book.ts` 与文档 04 重叠。我改了两处：历史预览 `previewBlocks`，和小忆取行（`captureLineContext`、`xiaoyiContextText`）。合并时需要人工对位。

## 需要用户决定

- 何时打开 `LINE_CONTEXT_CHAT_ENABLED`，以及是否先部署 `chatInterview` 并用真实模型试几轮。
- 文档 04 合入后，是否把分享卡和书架摘要也改成一行一段。
