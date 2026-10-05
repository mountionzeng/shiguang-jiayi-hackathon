---
title: "perf: 上线前把日常流程的云端往返次数降下来"
type: perf
status: active
date: 2026-09-29
origin: 2026-09-29 与用户的对话；docs/qa/2026-09-24-performance-baseline.md；docs/qa/2026-09-24-transport-call-chain.md
---

# 上线前减少云端往返

## Summary

用户反馈：后端太繁琐、反应很慢。实测记录显示，慢的主要原因不是函数多，而是**一个日常操作要串行调好几次云端，而每次调用本身就要等 1 到 5 秒**。这段等待和函数内部做了什么基本无关：

- 读取整个房间：函数内部 174–477 ms，客户端等 2–6 s。
- `capabilities`：返回 204 字节、函数内部 1 ms，客户端仍等 1.1–4.6 s。

所以合并或删除云函数省不掉这段固定等待，**能省的只有调用次数**。本计划的目标：日常流程里用户必须等着的云端调用，减到最少。

以上数据全部来自微信开发者工具（2026-09-24），**没有真机数据**。开发者工具本身可能放大等待，所以本计划的主要验收指标是**调用次数**（确定、可重复），毫秒只作参考。

小程序目前还不能上线（企业主体与深度合成资质未办完）。本轮在上线前完成：客户端改动用预览包验证；**云函数改动部署前必须先问用户**。

> **执行环境**
> - 从最新 `main`（2026-09-29 为 `f2533e5`）新建工作树，不要在根目录 checkout 里改。根目录有别人未提交的 5 个 personal-memory 改动，不要碰。
> - 「就地小忆」正在 `.claude/worktrees/youthful-lederberg-1d1f6d` 并行开发，它改了 `book.ts`、`interview.ts`、`index.ts`、`cloudfunctions/storyBooks/flow.js` 等文件。本轮改动尽量放在 `services/` 层，这几个文件只做最小改动，见 D5。
> - 先读 `AGENTS.md`、`docs/WORKSPACE.md`，跑 `npm run workspace:check`；在新分支上跑一次 `npm test`，记下基线通过数。

## Problem Frame

### 每次调用的固定等待

| 调用 | 函数内部 | 客户端等待 | 来源 |
|---|---:|---:|---|
| `storyBooks.state`（整个房间，约 613 KiB） | 174–477 ms | 2–6 s | `docs/qa/2026-09-24-transport-call-chain.md` |
| `storyBooks.capabilities`（204 字节） | 1 ms | 1.1–4.6 s | 同上 |

两行的等待差不多，说明大头既不在函数里，也不只在响应大小。拆函数、合函数都去不掉这段等待。

### 日常流程现在要等几次

下表按 `main@f2533e5` 的代码逐条数出来。「串行」指用户要等上一次返回，下一次才会发出。

| 流程 | 现在的串行调用 | 实测（开发者工具，单次） | 目标 |
|---|---|---|---|
| F1 冷启动到首页 | `getOpenId` → `state` | 身份 4.9 s + 状态 4.6 s | 2（本轮不动） |
| F2 首页进书架 | `state`（经 `ensureStoryBooks`） | 5.2 s | 缓存命中时 0 |
| F3 书架点一本书 | `state`（`openStory` 先整页 `refresh` 再跳转） | 4.3 s | 0 |
| F4 打开书稿 | `state` → `getOpenId`（`chapterDraftScope`，每次新调） | 4.4–4.9 s + 1.2–3.0 s | 缓存命中时 ≤1 |
| F5 保存一章 | 写命令 → `state`（`storyCommand` 写完整房重读） | 未测 | 1 |
| F6 记一段回忆并归入故事 | 追加记忆时整房读取 + `link` 写命令 + `state` | 未测 | ≤2 |
| F7 书稿里的本机照片 | 每张一次 `photoAccess`（`photoIds:[id]`，4 路并发） | 并行两批 4.2 / 4.8 s | ⌈张数 / 9⌉ |

F2 → F3 → F4 连着走一遍，现在是 3 次整房读取加 1 次身份确认，全部串行。这三次读取之间用户没有改过任何东西。

F6 的次数要在 U0 里实测确认：`appendCloudContributions` 等几个写函数的函数体里各有一到两次 `loadCloudRoomState`，静态统计可能数多了。

---

## Requirements

- **R1** 日常流程 F2–F7 的串行云调用次数达到上表「目标」列。**验收看调用次数，不看毫秒。**
- **R2** 行为不变：测试通过数不下降；页面显示的数据与改前一致。缓存命中时，后台校验发现变化，必须更新到最新。
- **R3** 鉴权不减：服务端 `assertSpaceOwner` 的次数和位置一概不动。`service.js` 注释写明这是故意的：读取途中身份被撤销时，不能放出数据。
- **R4** 缓存按账号隔离：缓存键包含 openid 和 familyId；账号或家庭一变，整份丢弃。不得把一个账号的数据显示给另一个账号。
- **R5** 写入后用写入结果更新缓存，不再整房重读。服务端的版本冲突检查（`expectedVersion` / `expectedRevisionId`）照旧生效，基于陈旧缓存的写入仍会被拒绝。
- **R6** 兼容旧部署：客户端先上线、云函数后部署时，行为退回到现在的「写完重读」，不报错。
- **R7** 可观测：每条流程能数出实际发出的云调用次数。日志只记操作名、次数、耗时，不记账号和正文。

## Scope Boundaries

### 本轮不做

- **删除或合并云函数。** 清单里 19 个函数只部署了 6 个，没部署的不影响速度。清理它们是维护工作，另议。
- 减少服务端身份校验次数，或缓存鉴权结果。
- 改指纹算法（会让已存书稿被判过期、正文被隐藏）。
- 精简 `state` 返回体。23 个版本的正文约占 613 KiB 里的 528 KiB，精简可能有用，但要先核查历史版本、恢复、迁移三处契约，而且改的是服务端。本轮先降次数，再看体积是不是还是瓶颈。
- F1 冷启动的两次调用。身份初始化涉及账号绑定，本轮不动。
- 部署云函数（需要时先问用户）、合并 main、生成对外二维码。

### 留给后续

- `state` 轻量读取与按需加载历史版本。
- 清理未部署的云函数。
- 云函数冷启动与内存规格（清单里都是空的，用的是平台默认值）。

---

## Key Technical Decisions

### D1. 会话内房间缓存放在 services 层

在 `roomRepository.loadRoomStateRemoteFirst` 前加一层模块级缓存（内存变量，不是 `wx.setStorageSync`）。键为 `[openid, familyId]`，取自 `cloudRoomStorage.ts:105-106` 已有的 `cachedOpenId` / `cachedFamilyId`。缓存放在 `shouldUseCloudDatabase()` 之后，不吞掉「云端未就绪」的错误。同一时刻的并发读取合并成一次（共享同一个 Promise），避免首页和 `story-switcher` 组件各读一遍。

### D2. 页面 onShow 先渲染缓存，后台校验

有缓存时立即用缓存渲染，同时在后台读一次最新状态，有变化就再 setData。沿用 `book.ts` 已有的 `refreshId` 防竞态写法。没有缓存时行为和现在一样。`stories.openStory` 用页面上已有的 state 算出选中的故事，不再整页 `refresh`。

### D3. 书稿页的草稿身份改成并行，不删除

`book.refreshBook` 现在先等 `state`，再调 `chapterDraftScope()`（每次新调一次 `getOpenId`）。性能基线文档写明这是故意的：「草稿继续使用新鲜身份验证，避免跨账号恢复」。本轮**保留这次新鲜确认，只改成和 `state` 同时发出**，省掉 1.2–3.0 s 的串行等待。要不要改用缓存身份是产品取舍，**需要用户决定**，本轮不做。

### D4. 写命令直接返回新状态

`storyCommand` 现在写完还要再调一次 `loadRoomStateRemoteFirst()`。改成服务端在写命令的返回里直接带上新 `state`。这次读取仍须经过 `service.js` 返回前的那次 `assertSpaceOwner`。客户端收到 `state` 就写入缓存；没收到（旧部署）就退回重读，满足 R6。这是云函数改动，**部署前先问用户**；客户端部分可以先做、先验。

### D5. 与「就地小忆」并行开发的边界

就地小忆在 `.claude/worktrees/youthful-lederberg-1d1f6d` 改了 `book.ts`（178 行）、`index.ts`、`interview.ts`，以及 `flow.js` 的 1 行（`contributionForClient` 加了 `aiRevisions`）。

- 本轮主要改 `services/` 下的 `roomRepository.ts`、`cloudRoomStorage.ts`、`storyBooks.ts`、`bookImages.ts`、`chapterDraft.ts`，这些就地小忆都没动。
- `book.ts` 只改 `refreshBook`（main 第 204–270 行附近），就地小忆的改动不在这一段。
- `flow.js` 只在写命令的返回处加字段，不碰 `contributionForClient`。
- 谁先合入，另一方 rebase。**不要把就地小忆的提交挑进本分支。**

### D6. 照片按批取

`readLocalPhoto` 的云端兜底现在每张照片发一次 `photoAccess`（`photoIds:[id]`）。云函数本来就接受数组：`purpose === "view"` 时一次最多 9 张，其他用途 3 张。书稿页用的是 `purpose: "view"`（`bookImages.ts` 第 135–141 行，2026-09-29 已核对），所以一次最多 9 张。改成客户端按 9 张一批发，纯客户端改动，不需要部署。

---

## Implementation Units

建议顺序：U0 → U1 → U2 → U3 → U6 → U5 → U4 → U7。U4 涉及云函数，放在客户端改动全部验完之后。

### U0. 先数清楚，再改

**Goal:** 每条流程都能数出实际发出的云调用。
**Files:** `miniprogram/services/performanceLog.ts`（加调用计数，只记函数名和 action），不进生产日志。
**Approach:** 在开发者工具里按 F1–F7 各走一遍，记下每条流程的串行调用序列，和 Problem Frame 的表核对。**表里数错了，就改表。** 同时在新分支上跑 `npm test`，记下基线通过数。
**Verification:** 写出 `docs/qa/2026-09-29-round-trip-baseline.md`，列明每条流程的调用序列和次数。

### U1. 会话内房间缓存

**Requirements:** R1、R2、R4、D1。
**Files:** `roomRepository.ts`、`cloudRoomStorage.ts`；新增测试。
**Test scenarios:** 命中与未命中；并发读取只发一次；familyId 变化后丢弃；`cloudReady` 为假时仍然抛错；写入失败不污染缓存。
**Verification:** 已有缓存时，F2 为 0 次调用。

### U2. 页面先渲染缓存

**Requirements:** R1、R2、D2。
**Files:** `index.ts`、`stories.ts`、`archive.ts`、`room.ts` 的 `onShow` / `refresh`，改动尽量小。
**Test scenarios:** 后台校验发现变化时页面会更新；页面卸载后，迟到的校验结果被丢弃；连续快速返回时，旧数据不会盖住新数据。
**Verification:** F3 为 0 次调用。家人在另一台设备改了内容，返回页面后最终显示最新内容。

### U3. 书稿页并行读取

**Requirements:** R1、D3。
**Files:** `book.ts` 的 `refreshBook`。
**Approach:** `state` 和 `chapterDraftScope()` 用 `Promise.all` 同时发出；state 命中缓存时，只剩草稿身份这一次调用。
**Test scenarios:** 任一方失败时整体报错，草稿不会在身份不确定时读写。
**Verification:** 缓存命中时，F4 为 1 次调用。

### U4. 写命令返回新状态（云函数）

**Requirements:** R5、R6、D4。
**Files:** `cloudfunctions/storyBooks/flow.js`、`service.js`；`miniprogram/services/storyBooks.ts`。
**Approach:** 写命令成功后，在同一次调用里返回 `state`，位置放在 `service.js` 返回前那次 `assertSpaceOwner` 之后。客户端有 `state` 就用，没有就重读。
**Test scenarios:** 返回的 state 与写后重读的结果一致；读取途中身份被撤销时不返回数据（沿用现有测试）；幂等重放返回相同结果；旧部署不带 `state` 时，客户端退回重读。
**Verification:** F5 为 1 次调用。**部署需要用户批准。**

### U5. 客户端写函数不再整房重读

**Requirements:** R1、R5。
**Files:** `cloudRoomStorage.ts` 的 `appendCloudContributions`、`addCloudFamilyMember`、`replaceCloudContribution`、`deleteCloudContribution`；`roomRepository.ts` 的 `purgeAllDeletedMemoriesRemoteFirst`。
**Approach:** 先看 U0 的实测序列，确认哪些重读真的在串行等待。用缓存或写入结果代替重读；清空「最近删除」改成一次读取、批量删除、一次更新。
**Test scenarios:** 内容安全检查（`enforceContentSecurity`）仍在写入前执行；批量删除中途失败时，缓存与云端保持一致。
**Verification:** F6 ≤ 2 次调用。

### U6. 照片按批取

**Requirements:** R1、D6。
**Files:** `bookImages.ts`；`tests/book-images.test.ts`。
**Test scenarios:** 超过上限时正确分批；某张没有权限时，其余照片照常显示；显示顺序与正文一致。
**Verification:** F7 为 ⌈张数 / 上限⌉ 次调用。

### U7. 真实流程与真机

**Approach:** 按 `AGENTS.md` 在开发者工具里走完 F1–F7，改前、改后各记一次调用次数和耗时。真机测速由用户用 `scripts/diagnostics/story-transport-probe.js`，在 Wi-Fi 和移动网络下各跑一次。
**Verification:** 见下方门禁表。

---

## Verification & Operational Notes

| # | 门禁 | 通过条件 | 谁做 |
|---|---|---|---|
| 1 | 调用次数 | F2–F7 全部达到目标列 | Agent |
| 2 | 测试 | 通过数 ≥ 新分支基线、0 失败；没有为了通过而删除或放宽断言 | Agent |
| 3 | 鉴权 | 读取途中撤销身份、跨账号访问等既有测试全部通过 | Agent |
| 4 | 账号隔离 | 开发者工具里切换两个账号，缓存不串号 | Agent |
| 5 | 开发者工具整体流程 | 按 `AGENTS.md` 走完 F1–F7，截图留在本机 | Agent |
| 6 | 改前改后耗时 | 同一账号、同一本书各测一次，注明是单次样本 | Agent |
| 7 | 真机 Wi-Fi / 移动网络 | 各跑一次测速页，复制结果 | 用户 |
| 8 | 云函数部署 | U4 部署前得到批准 | 用户 |

测试通过数不能代替门禁 1、5、7。

### 交接

做完写 `docs/handoff/2026-09-29-perf-round-trips.md`，固定四节：

1. 做了什么（附提交号）
2. 没做什么，为什么
3. 和本计划不一样的地方（包括计划里数错的调用次数）
4. 门禁表，每行标「通过」「未通过」或「需要用户做」

---

## Risks & Dependencies

| 风险 | 缓解 |
|---|---|
| 家人在别处改了内容，本机先显示旧数据 | 后台校验后更新（R2）；写入仍有版本检查 |
| 缓存串号 | 键包含 openid 和 familyId，变化即丢弃（R4）；门禁 4 |
| `tests/cloud-save-regression.test.ts` 断言「写完重读」 | 改成断言「使用返回的 state」，不删断言 |
| 与就地小忆冲突 | 见 D5 |
| 开发者工具的毫秒不代表手机 | 以调用次数验收，毫秒只作参考 |

---

## Sources & References

- `docs/qa/2026-09-24-performance-baseline.md`、`docs/qa/2026-09-24-transport-call-chain.md` —— 耗时实测数据
- `docs/handoff/2026-09-24-miniprogram-performance.md` —— 上一份性能交接；其中「房间缓存」一条当时没做，由本计划取代
- `cloudfunctions/storyBooks/service.js` —— 鉴权重复是故意的，见注释
- `AGENTS.md`、`docs/WORKSPACE.md` —— 验收约定与工作区说明
