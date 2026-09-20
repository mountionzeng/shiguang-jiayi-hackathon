# 故事、记忆与人物编辑修复交接

更新时间：2026-09-20（Asia/Shanghai）  
工作树：`/Users/yuandai/Documents/New project/shiguang-jiayi-hackathon/.worktrees/release/2026-09-16-ai-photos`  
分支：`release/2026-09-16-ai-photos`  
HEAD：`3181856`  
小程序 AppID：`wx6be512f0fe129b62`  
CloudBase 环境：`cloud1-d0g8c8yg0513a6068`

## 用户目标

用户在预览版中先后报告：

1. 人物无法编辑。
2. 人和故事都没有加载出来。
3. 完整的故事和记忆没有回来。

最终目标不是“页面不报错”，而是让当前唯一真实用户在原小程序账号中重新看到并可安全编辑原有的完整人物、记忆和故事；旧章节必须可恢复，不能因为迁移元数据丢失而被当作空账号。修好后需要电脑端与单账号验证通过，再生成新的微信小程序预览二维码。

## 当前判断与根因

这里同时存在两类问题，不能只修 UI：

### 1. 旧数据仍在，但故事迁移激活信息被旧客户端覆盖

- 云端能找到 6 本故事记录。
- 其中 1 本为当前有效故事，5 本在“最近删除”。
- 迁移暂存区仍有 50 条待处理记录：48 条旧章节、2 条旧图片；48 条旧章节中 38 条有正文。
- 旧迁移已经写入带 `migrationSourceDigest` / `migrationDocumentId` 的目标记录，但 `families.storyBooks` 元数据后来消失。
- 部分故事的 `currentRevisionId` 指向已经不存在的 `biography_drafts`，旧实现因此可能让书架或章节恢复链路失败。

### 2. 收紧数据库权限后，旧客户端直读集合的加载方式失效

`user_accounts` 和 20 个 `story_*` 服务端专用集合已经设置为“小程序所有用户不可读写”。这是有意的安全边界，不能为了让页面显示而重新开放客户端直读。

人物、记忆、草稿和故事应统一通过鉴权后的 `storyBooks` 云函数返回完整房间快照。人物新增和编辑也应通过云函数执行；只有旧云函数不存在时，客户端才允许兼容性回退。

## 已实施但尚未提交的修复

工作树是有意保持的脏工作树，所有改动都是用户当前任务的一部分。不要 reset、checkout、clean 或覆盖这些文件。

### 云端故事恢复

主要文件：

- `cloudfunctions/storyBooks/flow.js`
- `cloudfunctions/storyBooks/index.js`
- `cloudfunctions/storyBooks/service.js`
- `cloudfunctions/storyBooks/config.json`
- `cloudfunctions/inspectFamilyData/index.js`

已实现：

- 识别“单批迁移目标已完整写入、但激活元数据被旧客户端擦除”的状态，并恢复 `families.storyBooks.status = active`。
- 加载时发现缺失的当前修订记录，不再隐藏整本故事；对客户端清空失效的 `currentRevisionId`，同时保留 `orphanedRevisionId` 供诊断。
- 在处理待迁移章节时，可从暂存章节重新建立有效修订。
- `storyBooks.state` 返回版本化的完整房间快照：人物、记忆、故事、最近删除、家庭/个人草稿、修订和迁移状态；不泄露 `_id`、`familyId` 等数据库元数据。
- 记忆署名以当前人物资料为准，人物改名后旧记忆正文不变，但展示名和关系同步为新值。
- `inspectFamilyData` 增加只读诊断：身份链、迁移暂存、故事/章节数量、旧 `demo-room` 和环境总量。它只用于诊断，不能成为产品运行依赖。

### 人物编辑与安全写入

主要文件：

- `cloudfunctions/storyBooks/flow.js`
- `miniprogram/pages/profiles/profiles.ts`
- `miniprogram/pages/profiles/profiles.wxml`
- `miniprogram/pages/profiles/profiles.wxss`
- `miniprogram/services/cloudRoomStorage.ts`
- `miniprogram/services/memberLifecycle.ts`
- `miniprogram/services/roomRepository.ts`
- `miniprogram/services/roomStorage.ts`

已实现：

- 人物页新增编辑入口，可修改名字和关系，不更换人物 ID。
- 云函数增加 `memberAdd` 和 `memberUpdate`；在服务端校验 ID、长度、类型、删除状态和同名冲突。
- 人物名占用在事务内维护，避免并发新增两个同名人物。
- 兼容旧记录只有 `id`、没有 `memberId` 的情况，编辑后补齐 `memberId`。
- 人物改名不会改写记忆正文、身份、权限或故事归属。
- 页面刷新增加代次保护，迟到的旧请求不能覆盖较新的快照。
- 客户端收到 `roomStateVersion: 1` 时要求完整快照；不完整响应失败关闭，避免把半份数据当成完整房间覆盖本地状态。

### 相关防护与回归修复

本工作树还包含故事分享、授权、存储规则和家庭邀请相关修复。完整改动范围请先运行：

```sh
git status --short
git diff --stat
```

不要只挑本交接中列出的文件提交；先确认所有改动的归属和依赖。

## 已恢复的真实云端状态

在当前真实用户身份下，诊断与修复后已确认：

- 故事迁移状态：`active`
- 故事总数：6
- 当前有效故事：1
- 最近删除：5
- 待处理迁移项：50
- 旧章节：48
- 含正文旧章节：38
- 旧图片项：2

故事页最近一次电脑/模拟器检查结果：

- `loadError: null`
- `storiesCount: 1`
- `pendingMigrationCount: 50`
- `deletedCount: 5`

这说明“书架能回来”，但不等于 38 个旧章节已经逐条恢复并验证。下一位 Agent 的重点应是从 UI 走完恢复、编辑、保存、重载链路，并逐项核对正文数量和内容，而不是再次运行迁移或创建新空数据。

## 已部署内容

以下云函数已部署到 `cloud1-d0g8c8yg0513a6068`：

- `storyBooks`
- `familyInvite`
- `inspectFamilyData`

当前预览包可成功生成，主包约 1.7 MB，AppID 为 `wx6be512f0fe129b62`。二维码会过期，接手后应使用下文命令重新生成，不要复用交接文档中的临时图片路径。

## 已完成验证

最近一次完整本地验证：

- TypeScript 类型检查通过。
- 全量测试 674/674 通过。
- `git diff --check` 通过。

建议接手后先复跑：

```sh
cd '/Users/yuandai/Documents/New project/shiguang-jiayi-hackathon/.worktrees/release/2026-09-16-ai-photos'
npm run typecheck
npm test
git diff --check
```

与本次问题直接相关的测试包括：

- `tests/story-books-cloud.test.js`
- `tests/cloud-save-regression.test.ts`
- `tests/member-lifecycle.test.ts`
- `tests/profiles-page.test.ts`
- `tests/fresh-account.test.ts`

## 下一位 Agent 的建议执行顺序

1. 先阅读本文件以及：
   - `docs/brainstorms/2026-09-17-independent-story-books-requirements.md`
   - `docs/plans/2026-09-17-001-feat-independent-story-books-plan.md`
   - `docs/qa/2026-09-19-story-sharing-completion-check.md`
2. 用 `git status --short` 和 `git diff` 接收当前脏工作树，不要恢复文件。
3. 复跑类型检查、全量测试与 `git diff --check`。
4. 在微信开发者工具中以当前唯一真实账号验证：
   - 人物页能列出全部人物。
   - 编辑人物名字和关系后，退出再进入仍保留。
   - 人物 ID、已有记忆正文和归属没有改变。
   - 故事页显示 1 本有效故事及 5 本最近删除。
   - 迁移恢复入口显示 50 条暂存项。
   - 对 38 条有正文的旧章节逐步恢复时，正文没有丢失或串到错误故事。
   - 保存后强制重载，故事、章节、记忆和人物仍完整。
5. 检查控制台和云函数日志，不允许出现静默回退到空状态、权限错误后覆盖云端、或半份快照写回。
6. 如发现问题，先新增最小失败测试，再修改实现；不要直接操作真实正文来试错。
7. 验证完成后重新部署实际修改过的云函数，并再次跑单账号回归。
8. 最后生成新的预览二维码交给用户；二维码只表示预览构建成功，不代表双账号授权链路已验收。

## 预览二维码生成命令

```sh
'/Applications/wechatwebdevtools.app/Contents/MacOS/cli' preview \
  --project '/Users/yuandai/Documents/New project/shiguang-jiayi-hackathon/.worktrees/release/2026-09-16-ai-photos' \
  --qr-format image \
  --qr-output '/private/tmp/shiguang-preview-latest.png' \
  --info-output '/private/tmp/shiguang-preview-latest.json'
```

微信服务偶尔会报 `socket hang up` 或 TLS 连接在建立前断开；这是已观察到的临时网络故障。等待数秒后重试即可，不要因此切换 AppID、环境或工作树。

## 明确禁止

- 不要运行 `resetCurrentUserRoom`。
- 不要清空、重建或覆盖当前用户的家庭房间。
- 不要删除 50 条迁移暂存项，除非对应内容已逐条恢复且有可验证的持久化结果。
- 不要重新开放 `user_accounts` 或 `story_*` 集合给小程序客户端直读写。
- 不要使用 `git reset --hard`、`git checkout --`、`git clean` 或删除当前脏工作树。
- 不要迁移到新 AppID `wx86ae3e9d507ce52d`。
- 不要提审、正式发布、推送社交内容或调用付费 AI。
- 不要把单账号结果描述为双账号权限验收通过。

## 尚未完成与验收边界

- 用户暂时无法提供第二个微信身份。因此“亲友只能看获准章节、撤权后立即失效、亲友转发和副本再分享”尚未真机验收。
- 38 条含正文的旧章节尚需从产品 UI 逐条核对恢复结果；仅看到 `pendingMigrationCount: 50` 不算恢复完成。
- 最近删除中的 5 本故事要确认是用户真实删除意图，未经用户确认不要批量恢复或永久删除。
- 网页端权威故事接续仍缺公网 HTTPS 路由和共享密钥配置，相关开关必须保持关闭。
- 免费套餐无法配置理想的存储前缀规则，目前依赖云函数副本、随机路径、私有资产记录、短时签名 URL 等补偿控制。

## 完成标准

只有同时满足以下条件，才能向用户表示本轮修复完成：

1. 当前真实账号的人物、记忆、故事和旧章节在重载后完整可见。
2. 人物资料可编辑，改名后身份、权限、正文和关联不变。
3. 恢复的章节正文数量与暂存诊断相符，并能保存、退出、重新加载。
4. 不依赖开放客户端数据库权限，也不依赖本地演示数据。
5. 全量测试、类型检查、`git diff --check` 和微信开发者工具单账号验证通过。
6. 生成新的可扫码预览二维码，并清楚标注尚未完成的双账号验收项目。
