# 旧库数据迁移到企业小程序（同一个人的账号）交接

日期：2026-09-22
目标仓库：`/Users/yuandai/Documents/New project/shiguang-jiayi-hackathon`
本文基于 2026-09-22 的只读排查写成，所有代码位置均已核对。

## 任务

把用户在**旧个人小程序**里积累的真实数据，迁移到**企业小程序**中用户自己的微信账号下，使他用企业版登录后能看到自己原来的全部故事、记忆、书稿和照片。

这是同一个自然人、同一份数据的搬家，不是多用户迁移，也不是合并两个人的数据。

## 现场事实（已核对，不要重新假设）

### 两个 AppID 对应两套独立云库

| AppID | 云环境 | 状态 |
|---|---|---|
| `wx6be512f0fe129b62`（旧个人主体） | `cloud1-d0g8c8yg0513a6068` | 环境存在。用户真实历史数据在此 |
| `wx86ae3e9d507ce52d`（企业主体） | `cloud1-d5ghzk30ve609f544` | 环境存在，已部署 14 个云函数 |

映射表在 `miniprogram/config/wechat-accounts.json`，以及供真机加载的生成副本
`miniprogram/config/wechat-accounts.js`。两个文件都由 `npm run configure:wechat` 同步生成，
不要手改。`runtime.ts` 里 `cloudEnvForAppId()` 按运行时 AppID 查表，查不到就停止云初始化，
**故意不回退旧环境**，防止新账号写进旧账号的数据。

**这两个云环境是两个独立数据库。** 身份层怎么绑都不改变这一点：数据必须物理搬迁。

### 身份模型（决定了迁移的工作量）

`cloudfunctions/storyBooks/identity.js`：

```
aliasId = sha256(JSON.stringify([appId, openid]))
story_identity_aliases[aliasId] → { principalId, appId, status }
story_principals[principalId]   → { accountId, familyId, status }
story_principal_spaces[familyId] → { principalId, accountId, status }   // 一个 familyId 只能绑一个 principal
```

关键结论：**`storyBooks` 路径下 `familyId` 不是从 openid 现算的，而是从 principal 读出来的。**
所以跨 App 认领同一份数据，理论上只需要新增一条 alias 记录指向同一个 principalId，
而不是重写几千条记录的 `familyId`。

但 `cloudfunctions/getOpenId/account.js` 是另一条路径，它**直接从 openid 推导**：

```js
accountIdFor(openid) = `account_${sha256(openid).slice(0,24)}`
familyIdFor(openid)  = `family_${openid}`
```

**两条路径对 `familyId` 的来源不一致，这是本次迁移最需要小心的地方。**

## 三个技术暗礁（动手前必须先解决）

### 暗礁一：`_openid` 是系统字段，导入后不等于用户本人

客户端 `cloudRoomStorage.ts:212` 用 `collection("families").doc(familyId).set()` 创建家庭文档，
`_openid` 由云数据库按**调用者**自动落盘，也就是用户本人的 openid。

而 `identity.js` 的引导路径要求：

```js
if (!family || family.ownerAccountId !== account.accountId || family._openid !== openid)
  throw identityError('IDENTITY_UNLINKED');
```

**云函数以管理员身份导入旧数据时，写出来的 `_openid` 是云函数的身份，不是用户的新 openid。**
于是引导校验必然失败，用户认领不了自己刚搬过来的数据。

可选对策（需要决策，见文末「待决策」）：
- 让用户在企业版**自己触发**一次写入来生成 `families` 外壳，再把旧数据挂到那个 familyId 下；
- 或在 `identity.js` 增加一条受控的迁移引导分支，明确以 `user_accounts` 为权威、不再校验 `_openid`；
- 或者不做身份重绑，改为「按新身份重建 familyId 并重写全部引用」。

三条路的代价差别很大，必须先定，不要边写边改。

### 暗礁二：企业库里很可能已经有一套新身份

用户已经用企业版登录过（能看到 2 本书），`getOpenId/account.js::linkCurrentAccount()` 在首次登录时就会
写入 `user_accounts`，`primaryFamilyId = family_<新openid>`，并给 10 算力一次性赠送。

`identity.js` 里有明确护栏：

```js
// A missing alias is not permission to claim a previously bound space, even
// if an operator changes the configured bootstrap app after a migration.
if (await tx.get('story_principal_spaces', familyId)) throw identityError('IDENTITY_UNLINKED');
```

也就是说：**如果企业库里已经存在 `story_principal_spaces[family_<新openid>]`，
再想把新身份绑到旧 familyId 上会被拒。** 迁移前必须先盘清企业库现有身份记录，
并决定这套「新生成的空房间」如何处置（保留、合并还是清理）。清理动作属于破坏性操作，需用户逐项确认。

### 暗礁三：照片 fileID 跨环境失效

`docs/wechat-account-migration-runbook.md` 已写明：云存储文件复制到新环境后必须重写 fileID，
不能假定旧 fileID 在新环境可读。硬拷数据库记录会得到一批指向不存在文件的引用。

照片相关集合至少涉及 `photos`、`story_images`、`story_image_links`、`story_image_job_links`、
`image_jobs`、`photo_caption_logs`，以及书稿章节里的 `backdropImageId` 和 `content[].photoId`。

## 分阶段方案

每一阶段都要先预演、把结果给用户看，确认后才真写。任何阶段失败都必须能停在可恢复状态。

### 阶段 0：只读盘点（不写任何数据）

目标是拿到两边的真实底账，替换掉本文所有「未知」。

- 旧库 `cloud1-d0g8c8yg0513a6068`：逐集合统计记录数，至少覆盖 `families`、`family_members`、
  `memories`、`source_records`、`biography_drafts`、`photos`、`user_accounts`。
- 企业库 `cloud1-d5ghzk30ve609f544`：同样统计，并特别确认
  `user_accounts`、`families`、`story_principals`、`story_principal_spaces`、`story_identity_aliases`
  是否已有该用户的记录（暗礁二）。
- 记录用户在两边的 `openid`、`accountId`、`primaryFamilyId` 实际值。
- 云存储对象数与总字节数。

`inspectFamilyData` 云函数是现成的只读诊断工具，已在企业库部署。旧库需要确认它是否还在。

**注意：不要用 main 分支的包去连旧库做盘点。** 打开书架会触发
`miniprogram/domain/storyBookCore.js::migrate()`，它会向 `stories` 和 `storyMigration` 写入投影结果。
只读盘点必须走云函数或云控制台，不要走小程序界面。

### 阶段 1：企业库补齐集合与索引

`deploy/wechat-cloud.manifest.json` 是权威清单：43 个集合，含索引定义。
`ensureCloudCollections` 会幂等创建集合，需临时设置至少 24 位的 `COLLECTION_BOOTSTRAP_TOKEN`，
**用完立刻移除 token 和该函数**。索引、数据库规则、存储规则仍需在控制台逐项配置。

迁移优先级分三层：

- **P0（不搬就没有故事）**：`user_accounts`、`families`、`family_members`、`memories`、
  `source_records`、`biography_drafts`、`stories`、`story_names`、`story_operations`
- **P1（照片与图片）**：`photos`、`story_images`、`story_image_links`、`story_image_job_links`、
  `image_jobs`、`photo_caption_logs`、`generated_artifacts`
- **P2（协作与分享，可后补）**：`family_access`、`family_invitations`、`story_grants`、
  `story_invitations`、`story_copies` 系列、`story_desktop_*`、`audio_*`、`voice_profiles`

### 阶段 2：导出

写一个**只读**导出云函数部署到旧环境，按 familyId 过滤导出 P0 + P1 集合为 JSON。

- 保留业务 ID、`createdAt`、作者关系、审核状态原值，不要重新生成。
- 导出包加密、限制访问，不进仓库。
- 记录每集合条数与抽样哈希，作为阶段 5 对账基线。

### 阶段 3：导入

写一个导入云函数部署到企业环境。参照 `cloudfunctions/drinkingTimeBridge` 已有范式：
身份只从 `cloud.getWXContext()` 取、不接受客户端提交，用稳定 ID 保证重复执行不堆积。

- 稳定 ID 规则要写死并记录，例如 `migrated:<旧familyId>:<旧_id>`，重跑幂等。
- 先跑 `--dry-run` 输出将写入的条数与样例，给用户看过再真写。
- 照片：先复制云存储文件到企业环境，拿到新 fileID，再重写所有引用（暗礁三）。
- 分批提交，每批记录进度，中断可续跑。

### 阶段 4：身份重绑

按「待决策」里选定的方案执行。涉及的闸门：

- `STORY_IDENTITY_BOOTSTRAP_APP_ID`：`storyBooks` 与 `drinkingTimeBridge` 都从它读 `bootstrapAppId`，
  只有配置的这个 App 才允许自举创建 alias。
- `STORY_BOOKS_MIGRATION_READY`：`'true'` 才允许 `migrate()` 运行。
- `STORY_BOOKS_MIGRATION_FAMILY_IDS`：逗号分隔白名单，可只对该用户的 familyId 放开迁移，
  避免一次影响所有人。**先只填用户自己的 familyId。**

### 阶段 5：对账与验收

- 逐集合比对导入前后条数、抽样哈希、引用完整性。
- 企业版真机登录，确认能看到全部历史故事、书稿章节、照片。
- 确认新账号**只**能看到这一位用户的数据，没有越权读到别人的房间。

### 回滚

不是把新 openid 写回旧账号，而是：停止企业环境写入、恢复旧账号服务。
旧环境在保留期结束前不要删除。

## 安全约束（这个项目有过真实事故）

2026 年 9 月发生过一次真实房间被清空：`resetCurrentUserRoom` 当时没有任何护栏，
任何登录用户调一次自己的全部内容立刻消失。现在它有三道闸，**不要绕过**：

- `PROTECTED_FAMILY_IDS` 名单内一律拒绝，开关打开也不行
- 需要 `confirm === "RESET_MY_ROOM"` 且 `confirmFamilyId` 等于目标 familyId
- 需要云函数环境变量 `ALLOW_ROOM_RESET=yes`
- 默认只做预演，不删任何东西

`deleteDemoFamilyOnce` 的授权模块（`authorization.js`，在
`.worktrees/chore/migrate-enterprise-miniprogram-main` 的未提交改动里，已备份到
`salvage/2026-09-21-enterprise-worktree-uncommitted`）要求固定确认语 `DELETE_DEMO_FAMILY`
加至少 24 位 operator token，并用 `crypto.timingSafeEqual` 比对。
manifest 把它归为 `dangerousMaintenance`，`npm run deploy:wechat` 一律拒绝部署它。

本次迁移属于**向生产库批量写入**。要求：

- 每个写入阶段先 dry-run，把将要写入的条数和样例交用户确认
- 不复用任何破坏性函数做「清理」，需要清理时单独提方案给用户点头
- 迁移期间不要动其他用户的数据，用 `STORY_BOOKS_MIGRATION_FAMILY_IDS` 白名单限定范围

## 工具限制（省得下一个人重新踩）

微信开发者工具 CLI **不能读写云数据库**。`cli cloud` 只有 `env` 和 `functions` 两个子命令，
能列环境、列函数、查函数状态、部署函数，就这些。导数据只能走云控制台界面或自己写云函数。

CLI 即使远端报错也可能返回退出码 0。判断成功不能只看 `$?`，必须拒绝输出里的
`ResourceNotFound`、`[error]`、`Error`、`✖`，并要求函数名与 `Active` 同时出现。

## 分支现状

- `main` = `ec42ffd`，含完整独立故事书、`wechat-accounts.js` 映射机制、43 集合 manifest。**以它为基准。**
- `chore/migrate-enterprise-miniprogram` = `d83f1ed`，落后 main **108 个提交**，
  没有独立故事书，`CLOUD_ENV_ID` 为空串。不要在这个分支上做迁移。
- `salvage/2026-09-21-enterprise-worktree-uncommitted` 未并入 main，
  但已逐文件哈希核对，`.worktrees/chore/migrate-enterprise-miniprogram-main` 的 34 处未提交改动
  全部安全备份在里面。**不要 reset 或清理那个工作树。**
- `.claude/worktrees/goofy-bell-dd947d` 有活进程占用（另一个会话正在写 AI 原话/撤回/修改历史那套），
  **完全不要碰**。
- main 上 `CLOUD_AI_RELEASE_READY = false`，`app.ts:51` 把
  `aiReady = CLOUD_AI_ENABLED && CLOUD_AI_RELEASE_READY`，所以默认构建里文字 AI 是关的。

## 待决策（阻塞项，需用户先定）

**暗礁一怎么破。** 这是动手前必须定的唯一阻塞项，三条路代价差一个数量级：

1. **用户自己触发生成 `families` 外壳**，再把旧数据挂到那个 familyId 下。改动最小，
   但要求用户在企业版做一次真实操作，且要确认外壳的 familyId 与导入数据一致。
2. **在 `identity.js` 加一条受控迁移引导分支**，以 `user_accounts` 为权威、不再校验 `_openid`。
   最干净，但动的是身份校验代码，必须配白名单和负向测试。
3. **按新身份重建 familyId、重写全部引用**。不碰身份代码，但要改写每一条记录的 `familyId`，
   写入量最大、出错面最大。

**另需用户确认**：企业库里那套「新生成的空房间」（暗礁二）如何处置——保留、合并还是清理。
清理是破坏性操作。

## 未知项（本次排查查不到，必须实测确认）

- 企业库 43 个集合是否已全部创建。runbook 写「`ensureCloudCollections` 尚未在新环境执行」，
  但用户截图显示企业版能读出数据，两者矛盾，需以云控制台实际情况为准。
- 企业库里现在到底有什么。用户看到「2 个故事 + 43 项待确认」，来源未确认。
- 企业环境的 AI 密钥是否已配置。CLI 查不到，只能真机点一次 AI 整理才知道。
- 旧环境 `cloud1-d0g8c8yg0513a6068` 的云函数是否还部署着。本次只确认了环境存在，未列函数。
- 用户在两边的实际 `openid` / `accountId` / `primaryFamilyId` 值。

## 补充：43 项「待确认」是什么

`storyBookCore.js::migrate()` 把旧数据投影成独立故事书时，
只有**书稿章节**和**配图资源**找不到唯一归属才挂进 `storyMigration.pending`。
记忆本体不会进 pending：没有故事名或非 personal 的记忆会被 `continue` 跳过，
留在 `contributions` 里，在「整理记忆」页（`pages/archive`）仍然可见——
`memoryPool()` 只过滤「已删除」和「非个人」，**不按故事名过滤**。

`pages/story-migration` 页面可以逐条预览、选择放进哪本书或新建故事，
页面原话：「在你确认前，它们不会被删除或隐藏。」

## 验收标准

- 用户用企业版微信账号登录，能看到迁移前的全部故事、书稿章节、记忆和照片
- 照片可正常打开（fileID 已重写为企业环境地址）
- 修改客户端请求参数无法读到或覆盖别人的家庭、记忆、书稿、图片
- 导入重复执行不产生重复记录（稳定 ID 幂等）
- 迁移前后逐集合条数、抽样哈希、引用完整性对账一致
- 旧环境数据未被修改或删除
- `npm run check` 全绿，并附真机验收截图

## 2026-09-23：完整只读预演完成（未导入）

工作树：`.worktrees/codex/old-data-enterprise-migration`。包内79条业务记录，计划新增78条、保留企业已有owner成员1条、冲突0；另需3条身份关联及families缺失字段合并。2个照片文件共48,029字节，已本地核验长度、SHA-256及目标家庭路径。迁移测试7/7通过。详细无正文报告：`/tmp/shiguang-user-data-migration-20260922/迁移预演结果.md`，机器报告同目录 `direct-dry-run.json`。未调用apply、未开启写入开关。

### 工具经验与排除项

- 上文“CLI不能查询数据库”仅适用于旧的 `MacOS/cli` 入口。已安装版本另有官方 `/Applications/wechatwebdevtools.app/Contents/MacOS/wechatide`，支持 `cloud_db_read_doc`，无需安装新依赖。
- 状态检查：`wechatide -c codex check_wechatide_status --skill-version 0.3.9`；此次登录有效、版本equal、无需CLI token。
- 只读命令参数：`-c codex cloud_db_read_doc --appid wx86ae3e9d507ce52d --env cloud1-d5ghzk30ve609f544 --collection-name <集合> --query <JSON> --limit <数量>`。本次用 `_id: {$in: [...]}` 精确查询迁移相关ID，返回结果须核对ok、result.success、total、data及ID范围。12次查询合计约17秒。不要将故事正文输出到终端。
- projection须使用数字1；布尔true会返回 `InvalidParameterValue.QueryProjection`。本次账号字段投影使用1后成功。
- `cli auto` 的 `--port` 是IDE HTTP服务端口，本机已使用14220；换9420会要求重启。自动化模式曾导致模拟器启动失败。暂不依赖UI调用迁移。
- 将云函数身份检查拆成单文档仍出现45秒轮询超时，因此“仅因扫描条数多而超时”不足以解释症状。直接数据库接口成功；云函数轮询失败的根因尚未确认，不要宣称已确认冷启动导致。
- 正式预演使用企业只读快照 + 原迁移core.createImportPlan完整校验。最终身份校验没有跳过。快照非事务，apply前必须重新核查；云端apply调用链尚未验证。
- 工具session ID不是OS PID：不能以 `ps -p <sessionId>` 判定接收器退出。19000接收器此次实际PID为41106。

### 两任务协调与云端状态

本轮未部署函数或变更云端资源；只读查询结束后已释放全部共享UI给“拾光家忆 AI 文字理解与编辑交接”任务（01a0c998-cd85-76e0-8983-7052cbd7cc36）。正式导入/再次部署前先协调操作顺序。

AI任务报告：企业环境storyBooks/chatInterview/organizeMemory/generateBiography/recordAiConsent/personalMemory已从codex/ai-text-understanding-editing commit 0a65825部署，原四函数备份在 `/private/tmp/shiguang-ai-deploy-20260922/backup`。本迁移任务未覆盖这六函数。上述为对方任务提供的状态，不等于此后始终不变；操作前重新确认。

用户应先审阅预演结果，确认后才可正式导入；不得把“继续”理解成跳过既定审阅。尚需恢复可靠写入调用、导入后对账、真机图片与新用户隔离验收。

## 2026-09-23 01:27：用户批准后已正式导入并生成二维码

用户在审阅预演后回复“是”，正式写入已执行。采用官方 wechatide 受控管理接口和原 core.createImportPlan 校验，未启用 userDataMigration 云函数写入开关，未调用旧的 apply，也未覆盖 AI 任务六个函数。

- 原签名包78条新增全部回读一致，企业owner成员保留；3条身份关联新增，家庭仅补齐缺失storyBooks和一条memberNameClaims。企业原有1条记忆、1条source_record及成员内容保留。登录时getOpenId会正常更新user_accounts.lastSeenAt/updatedAt和families.updatedAt，对账排除这几个已证实的登录时间字段。
- 故事总记录7条，其中2条正常、5条旧有软删除。二维码版本书架显示2条是正确行为，不要批量恢复删除故事。
- 原包书稿7个版本全迁移；额外从已签名story_operations的action=save原始revision恢复了1个缺失当前版本。匹配storyId/currentRevisionId和expectedVersion+1，保存原稿正文，savedAt取现存story.updatedAt。回读通过；目前8个书稿版本、两个正常故事的当前版本引用均存在。原始记忆集合在源family下为0，12个去重memoryIds引用缺少源记录，不能宣称全部原记忆恢复。
- 两个照片文件共48029字节。管理接口直接上传会成为管理身份文件，当前用户下载报empty download url且覆盖报STORAGE_EXCEED_AUTHORITY。最终通过已验证本人微信运行时wx.cloud.uploadFile上传到user-photos/<目标family>/PHOTO_ID-migration-6e931907/，并只更新photos的displayFileID和smallFileID；wx.cloud.downloadFile分别成功29008、19021 bytes，管理端下载SHA-256也一致。原管理上传的两个文件保留未删除，照片记录已不引用它们，未放宽存储权限。
- 真实企业客户端storyBooks/state返回7故事、8稿件、50迁移条目；页面refresh显示2故事且均有章节。传入假的familyId不改变实际返回归属。使用真实身份快照运行身份解析，目标用户通过、无关用户被拒；未冒用第二个真实微信账号验收。
- UI/二维码项目：AI任务工作树codex/ai-text-understanding-editing，HEAD 0a65825；未改该工作树代码。AI发布开关仍关闭，二维码不代表DeepSeek已启用。
- 二维码：`/tmp/shiguang-user-data-migration-20260922/enterprise-preview.jpg`，由官方create_preview_qrcode生成，470×470。二维码文件最初以.png命名，内容实际JPEG，已另存正确扩展名。

私有证据均在 `/tmp/shiguang-user-data-migration-20260922/`：enterprise-before-import.json、enterprise-after-import.json、import-verification.json、uploaded-file-mappings.json、recovered-revision-proof.json。不得提交含正文、照片base64或密钥的这些文件。二维码/预演报告可单独向用户展示。

后续脚本经验：官方CLI大输出使用文件FD接stdout，管道捕获曾截断JSON；写入批次128KB返回500，分到40KB以下成功。写操作返回pending/taskId不代表执行完成，应等待官方单次确认后轮询最终result。家庭更新使用固定身份+待补路径$exists:false条件，避免把Extended JSON日期当普通查询值导致0行匹配。不要重复导入已迁移数据。正式导入后的verify仍应使用user-owned-file-mappings（当前uploaded-file-mappings已更新），而非placeholder或最初管理上传地址。
