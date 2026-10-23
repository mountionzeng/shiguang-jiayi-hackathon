# 2026-10-23 小程序新版整合交接

状态：**已合并并通过全量检查；尚未在微信开发者工具里验收，没有生成预览码。** 后续由 Codex 接手检查点 2 和出码。

## 位置

- 工作树：`.worktrees/codex/integrate-20261023`，分支 `codex/integrate-20261023`。
- 基线 `93fc0b9`（`codex/integrate-invite-20261016`），依次合并四个分支，全部无冲突。
- `node_modules` 软链到仓库根，不提交。
- 未 push、未合 main、未部署云函数、未开任何开关、未用开发者工具、未调用真实模型。

## 合并结果

| 顺序 | 分支 | 来源提交 | 结果 |
| --- | --- | --- | --- |
| 1 | `codex/self-display-name-20261022` | `2c0305a`（含已部署的 `aaaba5f`） | fast-forward，无冲突 |
| 2 | `codex/wechat-scan-login-20261022` | `e7dc948`（含已部署的 `ba29150`） | 合并提交 `3cae94b`，无冲突 |
| 3 | `codex/chapter-package-format-20261022` | `cc9cf3d` | 合并提交 `b7d9888`，无冲突 |
| 4 | `codex/line-modules-20261023` | `c869adf` | 合并提交 `76131a2`，无冲突 |

没有合入 `codex/chapter-modules-20261023`（文档 04 仍在开发）。

## 检查结果

- `npm run check`：typecheck 加全部测试，**1385 项通过，0 失败**，退出码 0（合并后 HEAD `76131a2`，工作树干净）。
- `npm run workspace:check`：退出码 1。它对照的是 2026-09-26 的云端历史快照（`deploy/observed-cloud-baseline.json`），storyBooks、storyImages、chatInterview、organizeMemory、familyInvite 等都显示有差异。这是已知的旧快照差异，不是实时云端查询，也不是本次合并引入。不要拿它判断这一版是否可出码。

## 与线上已部署云函数的核对

对比方式：`git diff` 比较提交里的源码，没有重新下载线上包。

- `storyBooks`、`getOpenId`、`familyInvite` 对比 `aaaba5f`：**零差异**。
- `drinkingTimeBridge` 对比 `ba29150`：**零差异**。协调会话已回读线上源码，确认与 `ba29150` 一致；`e7dc948` 比 `ba29150` 多的两个提交只改文档。
- 相对 `93fc0b9`，云函数目录只有 `chatInterview`、`drinkingTimeBridge`、`familyInvite`、`getOpenId`、`storyBooks` 有变化。

## chatInterview 这次不用部署

- 变化只有 `cloudfunctions/chatInterview/index.js` 一处约 6 行：仅当 `sourceText` 以「【用户停在第」开头时，才给提示词追加一句「先问他想往哪个方向写，或给两三条思路，他回应之后再给改写」。
- 这个前缀只有客户端在 `LINE_CONTEXT_CHAT_ENABLED=true` 时才会发送，而该开关现在是 `false`（`miniprogram/config/runtime.ts:32`）。所以本版出码不会触发新提示词，线上旧版 `chatInterview` 行为一致。
- 将来打开 `LINE_CONTEXT_CHAT_ENABLED` 之前，才需要部署 `chatInterview`，并用真实模型试几轮。是否部署、何时开，由用户批准。模型是否真的会「先问方向」未用真实模型验证。

## 开关现状（均未开）

- `WEB_LOGIN_CONFIRM_ENABLED`：只读云端环境变量（`drinkingTimeBridge/index.js:67,72`），仓库里没有设成 true。电脑上只能验到「未开放」提示。
- `LINE_CONTEXT_CHAT_ENABLED`：`miniprogram/config/runtime.ts:32`，`false`。
- `CHAPTER_PACKAGE_ENABLED`：代码里没有这个标识。章节包（`miniprogram/domain/chapterPackage.ts`）目前只是纯函数加测试，没有接入页面。
- 不要把 `CLOUD_AI_RELEASE_READY=true` 提交进仓库。

## 目录返回修复：需要用户决定

位置：`.worktrees/codex/integrate-invite-20261016` 里有另一个任务留下的**未提交**改动（10-22 14:19 后无人动）：

- `miniprogram/pages/book/book.ts`（约 59 行变动）
- `tests/chapter-autosave.test.ts`（约 100 行变动）
- 未跟踪文档 `docs/handoff/2026-10-22-chapter-directory-conflict.md`

我只读了它的 `git status` 和 `git diff`，没碰这个工作树，没 commit、没 stash。

它修的问题：旧版本草稿恢复后点目录，`finishEditing` 强制远端保存被版本校验拒绝，`backToContents` 提前返回，重进又恢复同一章，形成循环（用户手机截图「岱 · 第十章 · 阳」）。修复后，保存失败时目录、切章、回书架这几条导航路径在本机备份成功后允许返回，不改成「已保存」，也不覆盖线上新版。其他路径（发送、整理、改书结构）仍要求保存。

适用性：我用 `git apply --check`（以及 `--3way`）试过，这份改动能**干净套到整合版**上，与 line-modules 对 `book.ts` 的改动（35 增 5 删）没有重叠。**没有真正应用。**

它自己的门禁表写着：最终全量检查、预览回执、微信开发者工具点击都还没做，手机旧草稿场景需要用户验。

两种做法：

- **(a)** 由原任务先在 `codex/integrate-invite-20261016` 上提交，再把那个提交合并进整合分支。来源清楚，不会重复提交。
- **(b)** 在整合工作树里把这份 diff 应用成一个单独提交，署明来源；之后原任务不要再提交同样改动，避免重复。

**建议：这一版带上，走 (a)。** 理由：它修的是用户手机上真实遇到的循环，而检查点 2 本来就要验目录返回，不带它就验不出这个问题。带上之后必须：重跑 `npm run check`；在开发者工具里增加「旧草稿 + 版本冲突后点目录」的电脑端复现；手机旧草稿场景仍需用户真机确认（电脑本机数据代表不了用户手机的本机草稿）。若用户不想带，则这一版出码时要明确说明目录返回修复不在其中。

## 检查点 2：电脑验收清单

前置：

1. 同一时间只允许一个任务使用微信开发者工具和云环境 `cloud1-d5ghzk30ve609f544`；开工前先向协调会话/用户确认空闲。
2. 先决定目录修复是否进来（见上），进来后重跑 `npm run check`。
3. 先用 `npm run workspace:check` 与 `git status` 确认路径、分支、工作树干净。
4. 测试文字用可辨认的虚构文字，先记目标和原文基线，只改本次测试需要的部分；测完通过正常编辑/恢复流程清理，重新打开核对；不永久删除用户数据或历史版本。不做付费模型调用，除非用户明确授权。
5. 截图存 `/private/tmp/shiguang-integrate-20261023/`。

流程：

1. 首页加载，书架正常。
2. 书稿打开、进章节再返回目录；若带入目录修复，再测「旧草稿 + 版本冲突后点目录」，确认能回目录、本机内容和云端版本都保留。
3. 改名：改成可辨认的虚构名；再测被拒绝的情况（空名、违规名）的提示；最后改回原名并核对。
4. 阅读页「一行一段」显示（包括 `story-sharing` 阅读页）。
5. 邀请卡和回信里的署名显示本人称呼；若相关开关或入口未开放，记录「未开放」提示，不算通过也不算失败。
6. 小忆对话：连续追问、整理保存。`LINE_CONTEXT_CHAT_ENABLED` 关闭时，确认不出现「停在第几行」的上下文。需要真实模型的部分，先取得用户费用授权；否则明确记录「未做真实模型验证」。
7. 网页登录确认页：开关关闭，只记录「未开放」提示。
8. 清理本次新增的测试文字和临时内容，重新打开核对；若期间其他任务也改了同一篇文章，只撤回本次增量，不整篇回滚。

## 检查点 3：出预览码

- 验收和清理完成后，按 `docs/STABILITY.md` 用 `npm run preview:wechat` 出开发预览码（要求工作树干净、包含最新本地主线、AppID 与云环境匹配）。
- 不得用旧二维码、CLI 退出码 0 或云函数 Active 状态替代版本验证。
- 如果上传出现 TLS 失败，提示用户在 Shadowrocket 加直连规则；不要改代理或系统网络。
- 交付二维码时说明：实际跑过的流程、未覆盖的真机限制、哪些开关未开（扫码后不会看到网页登录确认、一行一段上下文对话、章节包）。
- 在本文件末尾补记验收结果和二维码对应的提交号。

## 红线（沿用任务约定）

不部署云函数（需要时由用户批准）；不开任何开关（`STORY_*`、`WEB_LOGIN_CONFIRM_ENABLED`、`LINE_CONTEXT_CHAT_ENABLED`、`CHAPTER_PACKAGE_ENABLED`）；不提交 `CLOUD_AI_RELEASE_READY=true`；不改 `sourceFingerprint`、`assertSpaceOwner`、重置护栏、内容安全；不碰 `/Users/yuandai/Documents/ChatGPT/DK—小程序`；不 reset/stash/clean；不合 main、不 push、不提交审核、不上传体验版。

## Codex 接手增量：目录返回修复纳入（2026-10-23）

- 用户明确确认开发者工具及云环境已空闲，并批准「目录返回」修复纳入本版。
- 原补丁来自 `codex/integrate-invite-20261016@93fc0b9` 工作树的未提交差异；仅将 `miniprogram/pages/book/book.ts` 和 `tests/chapter-autosave.test.ts` 应用到本整合分支。原工作树的三个未提交文件保持原样，不在那里提交或清理。此补丁以后若在原分支提交，整合时须按 patch 等价处理，避免重复应用。
- 新版保存失败时，只有目录、切章、回书架可以在完整读回编辑器且本机备份成功后继续；仍显示未同步，仍保留故事版本校验，发送与结构修改继续要求保存。
- `npm run check`：类型检查通过，1,389 项测试全部通过，0 失败。`git diff --check` 通过。定向草稿测试 15 项覆盖冲突、断网、双章编辑、迟到回执、读取/存储失败及账号隔离。按用户工具映射在主线程逐项审查，没有启动子智能体；未发现需要追加修改的阻断项。
- 本次重新下载了 9 个云函数。getOpenId（6 文件）、storyBooks（33）、familyInvite（4）与 aaaba5f 一致；drinkingTimeBridge（4）与 ba29150 一致。recordAiConsent（3）、organizeMemory（10）、generateBiography（7）、storyImages（19）也与当前本地一致。
- **修正上文的出码判断：** chatInterview 12 个文件中仅 index.js 有差异，线上缺少当前行提示规则。虽 LINE_CONTEXT_CHAT_ENABLED=false 不触发该规则，但标准 release-evidence/preview 脚本仍要求源码完全一致，因此不能直接按「本次不用部署」出码。真实云快照已留存于本会话 work/cloud-snapshot-20261023-132547；仅在用户批准后部署该函数并重新下载核对。不得绕过门禁。
- 电脑端实际验收、测试增量清理、真实模型验证及新二维码仍未完成；本次测试通过不能替代这些证据。
