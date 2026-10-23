# 交接：小程序章节带排版、导入导出章节包（文档04）

日期：2026-10-23。分支 `codex/chapter-modules-20261023`，工作树 `.claude/worktrees/ecstatic-kilby-b2f35f`。起点 cc9cf3d，已合并 aaaba5f（合并提交 1edfdcd，无冲突）。未 push，未合并 main，未部署。

## 当前结论（Codex 接手复核，2026-10-23 15:26 北京时间）

**旧稿兼容及本轮发现的数据层缺陷已修复，04 整体验收尚未通过。代码仍未提交。** 本文件持续更新，不另起交接。工作树和 HEAD 未变；原有未提交工作均保留。

- 用户在本对话明确选择兼容方案 1：接受从同一章节正文严格派生的旧空行或新逐行 `paragraphs`；新保存及恢复产生的新版本统一使用逐行缓存。不改历史版本、不迁移线上数据。
- 本次实际运行 `npm run check` **一次**：类型检查通过，**1397/1397，0 失败、0 跳过**。此前 Claude 所记 1381/1381 是接手时的历史证据，不冒称本次运行。
- 只在原工作树本地读写与测试，未访问生产私人内容、未用开发者工具、未部署、未开开关、未调用真实审核/付费模型、未合并、未 push、未 stage/commit。未启动子 agent，未向其他对话发消息。
- 本次在原 17 个业务/测试文件范围之外，仅增加修改 `miniprogram/domain/storyBookCore.d.ts` 与 `cloudfunctions/storyBooks/provenance.js`；当前共 **19 个业务/测试文件 + 本交接**。`node_modules` 软链不提交。
- **纠正原交接**：阅读与分享图按 layout 显示明确属于 04；08 负责当前行定位和聊天意见，不承担 04 的排版渲染。06 负责账号投递和图片传输，依赖 04 的本地导入导出，不能把 04 全部图片工作推给 06。
- **纠正原交接**：关闭 `CHAPTER_PACKAGE_ENABLED` 只关闭新入口/动作；共享 `flatten`、保存校验、来源编辑和回信逻辑不全受它隔离，不能声称默认关就无行为变化。

## 原实现与接手状态

- 最终提交号：**还没有**。当前 HEAD 仍是合并提交 `1edfdcd`，等协调会话审过后再提交。
- 接手时 git status 的未提交改动（6 个新文件已有 `git add -N` 意向添加，其余为已修改；本轮未改变暂存状态）：
  - 新增：`cloudfunctions/storyBooks/chapterPackage.js`、`miniprogram/services/chapterPackageService.ts`、`chapterPackageFlow.ts`、`chapterPackageGate.ts`、`tests/chapter-package-cloud.test.js`、`tests/chapter-package-modules.test.ts`
  - 修改：`cloudfunctions/storyBooks/{core,errors,index,returns,service}.js`、`miniprogram/config/runtime.ts`、`miniprogram/domain/{biography.ts,storyBookCore.js}`、`miniprogram/pages/book/{book.ts,book.wxml}`、`miniprogram/services/chapters.ts`
- 另有一个 `node_modules` 软链，不提交。
- 原交接记载 `npm run check`：1381/1381；其中章节包云端 10 个、小程序端 11 个，另有 1 个仅记录失败也能通过的测试。该记录性测试本轮已替换为真正的兼容回归。

## 做成了什么

1. **排版字段**：`ManuscriptChapter.layout?`，`copyChapter` 深拷贝。每章排版上限 60000 字节（方案 B），超出报 `LAYOUT_TOO_LARGE`。规则写在两端共用的 `storyBookCore.js`，并已用 `scripts/sync-story-core.mjs` 同步到云函数。整份书稿的 240 KB 校验未改。
2. **指纹**：`sourceFingerprint` 的输入只有 storyId、writingMode 和记忆内容，不含章节字段，算法未改。测试验证加不加 layout 指纹相同。
3. **云端导入**（新动作 `chapterPackageImport`）：照 `copies.js` 的做法，`requestId` 防重复，`expectedVersion` 防覆盖，两种目标（新故事、加为一章）。导入的块带来源凭据，所以发回只会带用户新写的部分。块编号与已有内容冲突时重新派生并改写排版引用。
4. **内容检查**：现将章节标题、新故事标题、发送者称呼、页名及完整相邻正文交给 `createTextModerator`，由现有审核器分块，避免每行一次远程检查。违规与故障均拒绝且不写入。图片同时核对 familyId、photoId、可信 openid、未删除、无受限来源、审核明确 pass 及本人照片路径。
5. **发回与采用**：仍复用 returns，仅发回自己追加的文字；排版附带限同账号。排版匹配元数据改为 blockId + 文字摘要，删除原实现额外复制整章 `senderTexts` 的做法。优先稳定 ID，其次两侧文字摘要均唯一时匹配，重复或无法匹配的引用丢弃，不修改原作者的原文；采用另存 version，旧版保留。新增块按已验证顺序映射。**这不是完整的“修改原文后整章发回”实现**，见缺口。
6. **开关**：客户端 `CHAPTER_PACKAGE_ENABLED = false`（`runtime.ts`），云函数环境变量 `CHAPTER_PACKAGE_ENABLED`，默认关。`capabilities` 多一个 `chapterPackage` 字段。四个 `STORY_*` 开关未动。
7. **入口**：书稿页"章节管理"里加"打包这一章"，开发版另有"导入最近的章节包"。开关关闭时两个入口都不显示。
8. **分段**：`flattenChapters` 与云端 `flatten` 的派生 paragraphs 改为逐行。正文 content 的所有编辑/保存入口尚未统一为逐行稳定块，不能据此宣称一行一模块已完成。

## 已解决：旧书稿段落缓存兼容

原问题：旧 paragraphs 按空行生成，正文含单换行时被新校验拒绝。最小回归在修复前复现 3 个失败：客户端验证、来源保护初始化/编辑、保存/历史恢复。此前记录测试允许报错仍通过，不能作为兼容证据。

- 用户已选方案 1。`matchesChapterText` 是客户端和云端共用的唯一兼容边界：先严格对照整个 content（含照片与来源元数据），然后只接受从章节严格推导的两种 paragraphs。没有按 trim 后全文相同就放行的宽松比较。
- 验证不改变输入；保存和恢复只在新 revision 中重新生成缓存，旧 revision 保持字节结构。正文丢字、照片替换、来源缓存不一致仍拒绝；受限来源不能降级成自有内容。
- `storyBookCore.js` 修改均通过既有 `scripts/sync-story-core.mjs` 同步；`sourceFingerprint` 算法和既有 `assertSpaceOwner` 调用位置/次数、重置护栏未改。
- 未查询线上数据规模；该修复不依赖线上迁移。

## 本轮其他修复及验证范围

| 问题 | 修改和数据影响 | 定向证据 |
| --- | --- | --- |
| 普通旧故事不能加章 | 导入复用既有 materializeOwnedDraft，只对服务端加载的未标记自有稿补来源元数据；受限但缺凭据的稿仍拒绝。保留旧版本、文字和照片 | 旧稿带多行/照片可追加；受限来源缺失时整笔不写 |
| 同包导入不同目标覆盖回执 | copyId 加入目标 storyId，fingerprint 包含 packageId/署名；校验回执账号和目标 | 第二个故事导入后重试第一请求仍返回第一故事/版本；同 requestId 换包拒绝 |
| 新故事名绕过已有索引 | 复用 story_names 的重名检查与登记，事务内写入 | 重名拒绝，不留下部分内容 |
| 审核漏字段、照片归属过松 | 标题、署名、页名一起检查；照片核对完整可信元数据 | 违规/故障/他人/已删除/非 pass/受限照片拒绝且数据库快照不变 |
| 排版可塞第二份文字或任意 URL | 共用 validateChapterLayout 验结构、尺寸、页数、模块字段及文字引用；导入额外核对图片引用可落到本章已审照片；尚未支持的封面明确拒绝 | 畸形排版在审核调用前拒绝；不在模块另存正文 |
| 合并块留下失效排版引用 | applyBlockEdits 仅移除已退休块的排版引用，合并后的正文与来源并集保留 | 行内改字 ID/排版不变；合并后旧引用移除，输入旧稿不变 |
| 文字相同导致回信对错块 | 同账号排版以稳定 ID/唯一摘要匹配，不猜重复文字；不再存整章副本 | 两个同文旧块均保留，只映射唯一段；不重复储存原文 |
| 只测单章上限 | 导入和采用同时守 240000 字节整稿上限；保留 60000 字节单章上限 | 四章各小于 60 KB 可入，第五章使整稿超限后完整回滚；9×300 理论最大排版不属于本实现可接受范围 |
| 多章输入静默取首章/导出丢媒体或来源 | 当前单章入口明确拒绝多章；含图、底图或受限来源的章节拒绝导出 | 共用三章样例不会静默丢掉后两章；受限文字/底图不会当纯文字发出 |

仅保留必要兼容边界：旧 paragraphs 的两种精确派生格式；新增回信摘要不是正文存储源。07 未执行删除，现存 flattened content/paragraphs 仍作为既有派生缓存保留。

## 未完成事项

- **04 自身缺口**：含图片/底图章节还不能打包；云照片读取、资产清单/hash/尺寸、封面与 AI 资源关联、复制及审核落地未完成。06 负责跨端传输，不能代替 04 的导入导出能力。当前只接受本人已登记审核通过照片，未对真实图片流程做验证。
- 发回只做了同账号闭环，跨账号投递留给文档06。
- **04 自身缺口**：阅读页和分享图未按章节 layout 显示；04 原文明确要求，08 没有接手这部分。不能把 CSS/普通自动分页当成模块渲染验收。
- 手机端没有真机、没有开发者工具验证，未出二维码。按约定这些现在由 Codex 独占，我没有碰。
- **04 自身缺口**：`prepareImport` 丢弃 lineage，未持久化 rootPackageId/parentPackageId；发回仍是旧“仅新增个人经历”语义，不能发回原文字修改或单独的排版修改。导入后 `sourcePolicyRequired=true`，页面仍只允许补充，不能用普通编辑器改原文；必须复用来源保护编辑，不能移除标记绕过。
- **04 自身缺口**：开发入口只导入新故事，没有“加到已有故事”选择器；导出记录未保存 storyId，所以页面真实入口没有把同账号 origin 接到导入。现有同账号闭环是内存仓库测试中显式提供 origin，并非页面流程跑通。
- **04 自身缺口**：开发入口每次 importLastExport 新建 storyId/requestId，未知结果后的重试还不能保持同一次操作；云端幂等已修但客户端闭环未完成。成功回执的 storyId 等字段仍需客户端严格校验。
- **04 自身缺口**：旧自有正文正常保存没有依 02 补稳定逐行 blockId；现有来源初始化 ID 规则与 02 的导出 ID 规则不同。需要在来源元数据保护边界内统一，不能把 blockId 随内容改写，也不能让旧接口误把块当无来源自有稿。
- 云存储导出使用随机包路径，不包含账号目录；原注释“目录自动隔离”没有规则证据。受限章节导出已有客户端拒绝，但可信云端导出授权和账号隔离仍需接入已有权限检查，不能当上线完成。
- 当前共享校验严格检查文字引用；图片资源映射、所有写入入口的整稿体积约束、删行/粘贴后的行 ID 和阅读自动补排仍需随着以上链路补齐。已有自动化绿灯不覆盖这些未实现能力。

## 需要部署什么（部署前必须用户批准）

- 代码变更涉及云函数 `storyBooks`，但**当前不建议部署或启用**。新入口要求章节包开关和既有访问/灰度条件均满足；本轮没有打开任何开关，不能暗示仅设一个环境变量即可完整可用。共享规则变更不受新开关完全隔离。
- 部署前先完成上述 04 功能缺口，形成干净提交，由整合任务按 AGENTS/STABILITY 验收和部署；本对话没有部署授权。
- 我没有部署，没有改任何环境变量，没有打开微信开发者工具。

## 和其他任务重叠的文件

- 文档08：`miniprogram/pages/book/book.ts`、`book.wxml`。我只追加了一个 import、两个入口方法、两个 data 字段、一个 switch 分支和两个按钮；没有动当前行和"给点意见"。
- 开放发送 / 整合版：`cloudfunctions/storyBooks/index.js`、`service.js`。只追加了开关读取、一个动作分支和 `capabilities` 字段。
- 整合版还可能碰 `returns.js`、`provenance.js`、`miniprogram/services/chapters.ts`、`storyBookCore.js`/`.d.ts`。章节一致性校验现共用 matchesChapterText；core 改动须用既有同步脚本生成云端副本。`book.ts/wxml` 与 08/目录补丁重叠由整合任务处理，不在这里重复提交目录补丁。
- 没有碰 `codex/integrate-20261023` 分支及其工作树，也没有碰 `.worktrees/codex/integrate-invite-20261016` 里的目录返回补丁。

## 需要用户决定

1. 兼容方案已决定并实现，不再重复询问。阅读与分享排版按 04 原范围继续，除非用户明确改分工，不默认推给 08。
2. 提交尚未授权，本轮不 stage、不 commit。提交前必须再次列明 19 个业务/测试文件与本交接，确认无旁人变化；不得把原 Claude 署名要求当作 Codex 新增贡献的作者证明。

## 行为与代价记录（本次接手）

| 北京时间/阶段 | 动作与范围 | 实测结果及代价 |
| --- | --- | --- |
| 15:08:45 首个可用工具时钟 | 恢复原树和计划；读取父记录但不修改；确认 HEAD/现有改动 | 不是从零重建。workspace:check 因批量输出截断被重复跑了 3 次，均是本地快照比对，退出 1 反映脏树/与旧云快照不同；这部分是重复开销，后续不再跑 |
| 兼容复现→修复 | 用本地虚构多行/照片/来源稿替换“失败也通过”的记录测试 | 修复前 25 项中 3 失败；修复后加来源回归 32/32；无线上数据读取 |
| 导入核对→修复 | 普通旧稿、跨目标回执、重名、审核与图片权限 | 新测试先复现 4 失败，再 16/16 通过 |
| 回信对位→修复 | 重复文字不猜位置，取消 senderTexts 重复正文 | 先 18 项中 1 失败，再 18/18；曾在命令中多写不存在的 story-returns.test.js，输出只有实际 18 项，未计作该文件已测，随后改为真实的 story-copies.test.js |
| 排版校验/体积/来源编辑 | 严格引用、几何/字段校验、合并清理、总量上限、单章入口拒绝多章 | 51 项时 1 个原测试样例引用不存在的 ID，纠正为真实有效引用后 68/68；最终定向 72/72。整个阶段均为虚构内存数据 |
| 15:21:26 发起最终全量 | npm run check，仅一次 | 类型通过，1397/1397；测试运行器 duration 5982.8765 ms（约 5.98 秒，只是测试阶段，不含此前阅读及类型检查）；git diff --check 通过 |
| 15:26:29 记录与收束 | 修正旧交接的不实完成范围，列清剩余 04 工作及整合冲突点；最后确认 HEAD 未变、暂存差异为空 | 可测记录区间 15:08:45–15:26:29 为 17 分 44 秒；首次时钟前准备耗时未单独量测。未统计总 token/工具调用费用，不估算 |

- 本轮定向测试命令共 9 次，全部对应新用例、新修改或新失败证据；最终全量 1 次。后续无新修改/失败不重复全量。
- 真实 AI/审核/云调用：0；部署/迁移/出码：0。云数据库写入均仅发生在本地 fixture 的 Map 中。
- 测试日志移到本聊天 `work/`，不进入源码提交；持续记录以本交接为准。


## 继续接手追加记录（2026-10-23 15:37，北京时间）

- 当前对话位于生成的 Codex 项目目录，原工作树不在默认可写根内；已在原树继续，保留现有未提交内容。整合对话已收到分支、HEAD、兼容选择、全量测试历史和本轮待办进度。
- 检查上一轮遗留的 miniprogram/services/chapterLayoutView.ts，发现 flatMap 推导过窄、布局绑定联合类型未缩小，导致首次 npm run check 在类型检查阶段失败。修复后 npm run typecheck 通过。
- 为布局视图转换新增回归测试，覆盖 900×1200 到半宽视口的缩放、正文模块和未放置文字保留；npm run test:files -- tests/chapter-package-modules.test.ts 为 17/17 通过。
- 修复后最终 npm run check：类型检查通过，1398/1398 测试通过。首次失败是修复前证据，最终结果是修复后的结果。
- 本次尚未把视图接入阅读页或分享图，也未补完 lineage/客户端导入重试/图片资产闭环及来源保护编辑。以上仍是 04 未完成范围；不能将当前测试描述为 04 验收通过。
- 未提交、未部署、未打开开关、未用微信开发者工具或云环境。


## 继续接手追加记录（2026-10-23 15:43，北京时间）

- 客户端章节包导入 now stores a pending target and requestId before the cloud mutation; subsequent retries prefer that same pair. The response is checked for ok, target storyId, revisionId, chapterId and alreadyReceived. A pure regression verifies the original target/id win over new values on retry.
- The development import entry now offers a new story or the currently open manuscript. It finishes an active edit first; append carries expectedVersion and expectedRevisionId, then refreshes the manuscript. New-story success navigates to the imported story.
- prepareImport now retains package story title and lineage. The client stores same-device lineage plus the exported source story/chapter for an import attempt; cloud import already persists the same-account return route. The package file itself carries lineage, but this local cache is not cross-device cloud persistence.
- Review corrected a previous attempted handoff append that failed due to quoting; that failed command did not modify files. This section records the successful append.
- Focused chapter-package suite is now 18/18 and typecheck passes. Full check after these latest changes is still pending; do not rely on the earlier 1398/1398 result as final.
- Still incomplete: layout is not yet rendered in the reading page or share images; image bytes/assets and review linkage are not integrated; ordinary editing of source-protected imported text and revised-text return semantics remain unsupported; append currently selects only the open manuscript.
- No commit, deploy, switch change, WeChat developer-tool session, or real cloud operation.


## 继续接手追加记录（2026-10-23 15:47，北京时间）

- 历史版本只读预览现在在所有章节都带有效 layout、且所有布局图片均能在本机或已签名映射中找到时，按 900×1200 模块坐标缩放显示；正文块仍以 blockId 绑定。缺少任一排版或图片时回退到原有完整文字/图片预览，避免漏内容。补充覆盖 AI 图片引用映射的回归测试。
- 全量最终检查在这些最新代码之后通过：typecheck 通过，1400/1400 测试通过，git diff --check 通过。章节包定向测试 19/19 通过。
- 这仍不是完整 04 验收：本次只把 layout 接入历史版本预览，分享图 renderer 尚未读取 layout；含照片/底图的章节包仍明确拒绝导出；来源受限章节文字编辑和修改原文后的发回仍未实现；lineage 跨设备云端持久化没有实现；追加入口只提供当前打开书稿。微信开发者工具/真机验证尚未进行。
- 未提交、未部署、未开关、未访问真实云环境。


## 继续接手追加记录（2026-10-23 15:50，北京时间）

- 为历史版本排版预览补上异步过期护栏：只有当前请求序号、历史列表序号、故事身份和 history 面板都仍匹配，才写入预览结果。
- 该护栏之后再次运行 npm run check：类型检查通过，1400/1400 测试通过；git diff --check 通过。章节包定向测试 19/19。
- 当前进展和未完事项已再次同步整合对话。工作树仍未提交、未部署、开关关闭。


## 继续接手追加记录（2026-10-23 16:14，北京时间）

- 分享图 renderer 已接入纯文字章节 layout。云端仅从授权的当前 revision 解析完整绑定的文字模块；选区摘录、图片模块、纹理、未绑定正文仍走旧自动排版。layout 随 descriptor 内容参与 hash，导出前后仍重建并核对版本、来源权限、封面和底图。
- 客户端仅在分页模式、未指定目标张数且所有章节都有可用 layout 时绘制模块坐标；文本超出模块矩形时整本回退自动排版。layout 等比缩入既有页面头尾空间，保留封面、章节底图、页脚和目标张数/长图语义。
- 新增云端测试覆盖纯文本 layout、摘录隔离、图片和未绑定文字回退；renderer 测试验证模块坐标。`npm run check` 通过，类型检查通过，1402/1402 测试通过，`git diff --check` 通过。
- 已发现并精确撤回一次路径误写到主工作树的本轮改动；随后确认主工作树这些文件没有本轮残留，所有实际代码更改位于 04 原工作树。
- 阅读页 layout、图片/底图章节包资产导入导出、来源保护原文编辑和修订回信及完整真机验收仍未完成。未提交、未部署、未启开关、未触碰真实云环境或微信开发者工具。


## 继续接手追加记录（lineage 跨设备持久化）

- 章节包导入请求现在把经过 v1 包解析的 lineage 发给云函数；云端再次校验 `rootPackageId` 与 `parentPackageId`，并把 `{rootPackageId, receivedPackageId}` 作为轻量元数据保存在接收章节中，不复制正文。
- 导出从服务器同步下来的章节元数据恢复父 lineage，因此设备 storage 清空或换设备不影响 root/parent 链；公开章节包仍只按契约输出标准 `lineage` 字段，不输出内部 `packageLineage` 字段。首次导出的 root 由纯转换器设为自身 packageId。
- 定向测试 42/42 通过；随后 `npm run check` 全量通过：类型检查通过，1403/1403 测试通过，`git diff --check` 通过。首次测试运行被沙箱拒绝本地 IPC socket；在获批的本地测试执行环境重跑后通过。
- 这一项仍待与 06 的跨账号收包接口连测；没有提交、部署或打开开关。


## 继续接手追加记录（图片资产、来源修订与回信闭环复核）

- 用户确认旧书稿兼容方案 1：保存校验仅接受由同一正文严格推导的旧空行或新逐行 paragraphs；新保存统一生成逐行缓存，不改旧 revision、不迁移线上数据。
- 章节包图片资产接口已完成：导出校验 JPEG/PNG/WebP 实际字节、SHA-256 和尺寸，限制单张 2 MB、全包 8 MB；导入映射 opaque assetId 到经所有权/删除/来源凭据/审核 pass 核验的本地照片。重导保留资产 ID、AI 标记、layout 图片和封面关联。v1 不打包 backdropImageId。
- 来源保护章节可编辑原文和 layout 并保存为新 revision；拒绝接收方自写块；请求指纹/requestId 支持未知结果后安全重试。发回可含来源原文修订建议及新增个人经历，原作者采用时按唯一摘要定位原文、保留旧版本/layout，并正确同时应用新增块；拒绝不改原稿。
- 最新定向测试 `npm run test:files -- tests/chapter-package-cloud.test.js tests/chapter-package-modules.test.ts`：47/47 通过。`npm run typecheck` 通过，`git diff --check` 通过。随后最新 `npm run check`：类型检查通过，1408/1408 测试通过，0 失败、0 跳过。
- 本轮在单独项目目录触发的首次测试被沙箱阻止创建 tsx IPC 管道；在对原工作树测试命令的批准执行后重跑成功。已向整合对话同步本结果与接口限制。
- 自动化证据不代表微信开发者工具/真机端到端验收；没有访问真实云端、调用审核服务、部署、开关、stage 或 commit（待按用户此前要求创建固定提交）。
