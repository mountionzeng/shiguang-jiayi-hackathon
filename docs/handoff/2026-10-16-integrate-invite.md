# 2026-10-16 邀请共创与完整主线整合

## 做了什么（附提交号）

2026-10-17 完成续办：无损资源压缩提交 **`fbdc4a24ad4ee3421769621172f819f3e2f51f44`**；压缩后 `npm run check` 再次类型通过、1291/1291 测试通过。二维码于 **2026-10-17 14:00:14（北京时间）** 从干净 `fbdc4a2` 生成，约 14:30 失效。微信上传确认主包 2,077,205 字节（约 2029 KB），低于 2048 KB。原输出 `/private/tmp/shiguang-preview-qr.jpg`，留存 `/private/tmp/shiguang-integrate-invite-20261017-evidence/preview-fbdc4a2.jpg`，记录在 preview-manifest.json / preview-3.log。源码下载与二维码完成后已恢复 Wi-Fi DNS 为原值 `198.18.0.2`，前后文件 cmp 一致，代理未改。

- 在统一仓库的独立工作树 `.worktrees/codex/integrate-invite-20261016` 创建分支 `codex/integrate-invite-20261016`。从 A `bb7e73c` 出发，用 merge 合入 B `c574bc0`，合并提交 **`8ae1cb9413ad5b8922e5c2e60ef3cb845b6c3946`**，双亲分别为 A、B；没有 rebase。main 仍为 `235932e`，原 A/B 分支未改。
- 保留 A 的对话体验、记忆配图、章节拖拽和删除恢复、保存回执当前状态、分享预览布局；合入 B 的一键邀请、亲友阅读与权限、回信、改动历史和首次登录说明。旧邀请三步流程和新一键邀请继续并存。
- `storyBooks` 现有 29 个业务 JS/JSON 文件，同时有 `tencentModeration.js`、`changes.js`、`rollout.js`、`invitations.js`。所有相对 require 均可解析，所有 JS 语法检查通过；外部依赖仍由原 package.json 声明。`tencentModeration.js`、`moderation.js`、`bookExports.js`、`flow.js`、`index.js`、`package.json` 与 A 逐字节一致。
- 已在 A 工作树独立重跑 `npm run check`：类型检查及 **1217/1217** 测试通过。合并初检 **1288/1288**，补充三项回归后最终 **1291/1291**，0 失败、0 跳过。本轮解冲突未为过关删除或放宽断言；B 原先替换的一条过时页面测试单独说明如下。
- 修复两个衔接问题：缓存房间首屏不等待回信，回信等待后重查请求是否失效；切换章节时清空旧章历史并读取新章历史，拒绝书籍/版本不匹配的迟到响应。
- 微信开发者工具实际打开本工作树，检查了首次登录说明、点击“知道了”、首页进章节目录；实际看到 A 的新建章节、拖拽提示和发送入口。仅本机说明已读记录发生变化，没有写测试正文、发邀请、改权限、删除用户内容或调用付费 AI。出现过模拟器无响应提示，关闭提示后页面成功加载；随后网络请求超时，未完成整条体验。
- 审查按 `ce-code-review` 的正确性、测试、标准、权限、性能、异步生命周期及跨层验收维度进行；遵照用户 AGENTS 映射，由主线程顺序检查，未派子代理。证据目录：`/private/tmp/shiguang-integrate-invite-20261016-evidence/`，含 source-guards.json、review.json、stage-files.txt、下载与预览日志。临时目录可能被系统清理。

## 没做什么、为什么

- **没有合 main、推送、部署任何云函数、创建集合或修改线上环境变量。** 云函数部署必须待用户批准；只允许 storyBooks。`ensureCloudCollections/bootstrap.js` 的集合登记与 `familyInvite/index.js` 的未调用代码删除来自 B，保留源码，但不部署这两个函数，更不调用建集合脚本。
- **没有完整真机或双账号验收，没有验收性能达标。** 云函数尚未部署，新功能开关按要求保持关闭；邀请接受、权限变更、回信采用/拒绝和改动历史的真实云链路仍需后续测试。内存数据库的真实 dispatcher 测试不能代替真机、云规则和视觉验收。
- `CLOUD_AI_RELEASE_READY` 仍为 false。`sourceFingerprint` 算法、两个重置函数护栏、内容安全模块未更改；原 service.js 的所有 assertSpaceOwner 调用语句与 A 一致，位置的语义边界不变。B 新模块中的既有权限检查原样保留。
- 四开关 `STORY_ACCESS_ENABLED`、`STORY_INVITATIONS_ENABLED`、`STORY_COPY_RECEIVE_ENABLED`、`STORY_SHARED_EDIT_ENABLED` 没有执行任何写入；不得把“未修改”说成已独立查询并确认线上值。本次也没有展开包含密钥的环境配置。部署后仍不得开启这些开关。
- 本次二维码按用户明确指定的 `~/.claude/skills/wechat-preview-qr/preview.sh` 生成，用于看整合客户端界面。它不是 AGENTS/STABILITY 所要求的全流程验收通过证明，不能宣称全部功能已在线可用。
- 首次登录说明仍仅挂首页；未按旧交接的建议额外挂邀请页/房间页，也没有合并两种邀请流程。B 的邀请生成成功提示还沿用“申请、主人确认”的旧文案，属既有低优先级文案问题，本次保留并记录，后续应随邀请体验验收修正。


2026-10-17 续办：用户明确批准临时将 Wi-Fi DNS 从 `198.18.0.2` 改为 `223.5.5.5`，下载与出码完成后恢复。代理未变。临时切换后官方 CLI 成功下载当前线上 storyBooks 到 `/private/tmp/shiguang-integrate-invite-20261017-evidence/storyBooks-live-1`。线上 27 个业务文件全部与 `efa4759` 逐字节一致；与整合代码比对为 **新增 2、修改 4、不变 23、线上独有 0**。本次实际下载结果确认历史记录与当前源码一致，不能倒推为之前已验证。

| storyBooks 文件 | 本次下载的线上源码 → 合并结果 |
| --- | --- |
| access.js | 不变 |
| bookExports.js | 不变 |
| changes.js | 新增 |
| collaboration.js | 不变 |
| config.json | 不变 |
| copies.js | 修改 |
| copyAssets.js | 不变 |
| copyMedia.js | 不变 |
| copyStorage.js | 不变 |
| core.js | 不变 |
| errors.js | 不变 |
| excerpts.js | 不变 |
| exports.js | 不变 |
| flow.js | 不变 |
| identity.js | 不变 |
| index.js | 不变 |
| invitations.js | 修改 |
| media.js | 不变 |
| memoryExports.js | 不变 |
| moderation.js | 不变 |
| package.json | 不变 |
| performance.js | 不变 |
| provenance.js | 不变 |
| repository.js | 不变 |
| returns.js | 修改 |
| rollout.js | 新增 |
| service.js | 修改 |
| stateTransport.js | 不变 |
| tencentModeration.js | 不变 |

新增：changes.js（章节改动历史）、rollout.js（邀请接纳的灰度检查）。修改：copies.js（复制来源署名/成员关联）、invitations.js（一键接受与权限管理）、returns.js（回信署名/成员信息）、service.js（新功能分派与灰度检查）。内容审核 tencentModeration.js/moderation.js、保存实现 flow.js、书籍导出 bookExports.js 均与线上相同。

线上文件 SHA256 与本地 SHA256 的完整清单保存在上述证据目录 `live-comparison.json`。这只是部署前差异清单，没有执行部署。

部署方案（待批准，不能在本次交接完成前执行）：

1. 当前线上源码已真实下载并逐文件比较，清单见上表。实际部署若发生在其他时间，先重新下载复核，防止其他任务在期间更新线上代码。
2. 用户先在控制台创建 `story_rollout_admissions`，应用 `deploy/story-sharing/database.rules.json` 中该集合 `{ "read": false, "write": false }` 规则。此文件是分集合模板，不应整体上传。用户确认集合和客户端拒绝规则完成后，才继续部署审批。
3. 只部署 `storyBooks`，预案命令为 `node scripts/wechat-cloud-deploy.mjs --execute --env cloud1-d5ghzk30ve609f544 --only storyBooks`，执行前再次核对干净提交、main 祖先、AppID `wx86ae3e9d507ce52d`、当前线上源码未被别的任务更新。只读 dry-run 已返回 count=1 / names=[storyBooks]，未运行 --execute。
4. 不覆盖 10-09 部署的 chatInterview 等任何其他函数；不改数据库规则、密钥和线上开关。
5. 部署后只读下载 storyBooks 到全新外部目录，对本次固定提交的 29 个业务 JS/JSON 文件逐字节及 SHA256 比较，要求零缺失、零差异、零额外业务文件。排除 node_modules 和安装生成的 package-lock.json，package.json 参与比较，符号链接直接拒绝。Active 仅是状态，不能替代回读。比较脚本已放在证据目录 `compare-storybooks.py`。
6. 部署后观察 `[service-failure]` 的 write/refresh 与审核错误，核对普通读写及保存回执；若回读不一致或权限/内容安全回归，停止开关与交付，保留线上下载和部署日志，先请用户决定恢复方案。不开危险重置函数，不清理真实数据。正式开功能与双账号验收另行确认。

## 和本交接不一样的地方（包括每一处冲突怎么取舍）

- 2026-10-17 网络恢复后，微信上传报主包 2060 KB，超过 2048 KB。本轮额外无损重压缩 `memory-branch.png`、`story-tab-chat.png`、`memory-bird.png`，合计减少 32,771 字节；解压后的全部 PNG 扫描行和所有非 IDAT 块均逐字节相同，CRC 校验通过，没有删功能、改像素、尺寸、颜色或透明信息。证据 `png-lossless-verification.json`。

- 实际是 **7 个冲突文件、8 个冲突块**，与用户预估文件一致。逐块合并，没有整文件选 ours/theirs。

| 文件/冲突 | 取舍与理由 |
| --- | --- |
| cloudfunctions/storyBooks/service.js | 保留 A 的 dispatch phases/measure 计时；在其上增加 B 的 rolledOut。保存回执 savedState、分段回退、写入幂等参数隔离、前后主人校验全部保留；B 的邀请、共享、回信、chapterChanges 分派全部保留。 |
| miniprogram/pages/book/book.ts | chapterRows 类型采用含 hasReturn 的字段集合，同时保留 A 的 swipeOpenChapterId/draggingChapterId；其余自动合并的编辑、回信与历史方法均保留。额外修复 B 切章未加载历史的漏接。 |
| miniprogram/pages/book/book.wxml | 保留 A 的新建章节、左滑删除、拖拽和行容器结构；将 B 的“有回信”嵌入章节标题。回信卡片与改动记录区保留，不改分享预览页。 |
| miniprogram/pages/book/book.wxss | 并存 A 的章节加载文字和关联记忆样式，以及 B 的回信标记/卡片/改前文字样式。 |
| miniprogram/pages/index/index.wxml | 保留 A 的 story-switcher 两个事件绑定，之后增加 B 的 first-login-intro 标签；首页回信提示和组件注册保留。 |
| miniprogram/pages/room/room.ts，块 1 | 保留 A 的 loadSequence/onUnload，加入 B 的 lettersById；预览跳过回信请求，真实回信等待后再次检查 sequence，防止延迟响应覆盖。 |
| miniprogram/pages/room/room.ts，块 2 | setData 同时保留 loading=false、loadingDetails=preview 和 letters，原分阶段加载与回信汇总并存。 |
| tests/page-handlers.test.ts | 保留 A 全部尾部测试，并补齐闭合后接 B 全部回信/历史/记忆之家测试；没有删测试或放宽断言。另外增加缓存首屏、卸载迟到回信、切章历史三项回归。 |

- B 的交接文档称首次登录另分支待合；实际 `c574bc0` 已含首次登录组件、服务和 9 项测试，因此本次直接随 B 合入，无需再合第三条分支。
- 合并初检 1288 项测试全部通过，本轮没有通过修改原断言来消除失败。逐项测试标题审计发现，B 在上游已替换 A 的一条 `wrong applicant verification code cannot send an approval request` 页面测试：它调用已删除的页面 `decide`，而 B 明确改为一键接受、不输核对码，所以这条旧页面测试已过时；合并保留 B 新的“一键加入并到阅读页”测试。旧服务端 `inviteDecide` 没有删除，`tests/story-invitations.test.js:30` 仍断言错误核对码被拒绝，其余旧协议权限测试也保留。其余 A 的测试标题均保留。这是已授权产品流程变化带来的上游替换，不是本次为凑通过数删除安全测试。新写的缓存首屏测试曾误把全部 contributions 数当作可见记忆数（实际应为 memoryPool 过滤后的集合），仅纠正新增测试的预期；未改产品过滤规则。新增切章历史测试先失败，证明是 B 的遗漏调用；补挂接后通过。
- `workspace:check` 在 main 返回旧 2026-09-26 云快照差异，退出码 1；这不代表实时云端异常。根目录和 A/B 本轮开始时均为指定提交，根目录干净；节点依赖仅软链统一主仓，忽略且未提交。
- 2026-10-16 首轮二维码执行时工作树干净，来源为 `8ae1cb9`；`preview-1.log` 记录 5 次上传全部 DNS ENOTFOUND，未生成新的 QR。该次没有成功时间，后续 10-17 成功出码记录见第 1 节。
- 用户处理网络前 3 次源码下载为 TLS ECONNRESET；处理后第 4–6 次为 servicewechat.com DNS ENOTFOUND。初始诊断路由 utun5、DNS 198.18.0.21。10-16 未自行断开代理、改系统网络或关闭 TLS 校验。10-17 用户明确授权临时修 DNS 后，实际下载及出码完成，DNS 已恢复；没有关闭 TLS 校验。

## 门禁表

| 门禁 | 状态 | 证据/下一步 |
| --- | --- | --- |
| 读取 AGENTS/WORKSPACE/两份分支交接，运行 workspace:check | 通过 | 已执行；旧快照差异见第 3 节，不等于实时线上验证 |
| 从 A 建独立分支工作树，merge B；A/B/main 不变 | 通过 | 8ae1cb9 双亲 bb7e73c / c574bc0 |
| A 基线 npm run check | 通过 | 1217/1217，类型通过 |
| 合并后 npm run check | 通过 | 1291/1291，类型通过，0 失败/跳过 |
| 所有冲突逐块解并保留双方功能 | 通过 | 上表 7 文件/8 块及 3 项新增回归 |
| storyBooks 完整模块、相对 require、JS 语法 | 通过 | 29 文件，source-guards.json |
| 腾讯审核、保存回执、指纹与重置护栏保留 | 通过 | 与 A 源码比较和全量回归 |
| 仅 storyBooks 部署计划与干净来源检查 | 通过 | dry-run 1 个函数，inspectDeploymentSource 通过 |
| 开发者工具首次登录说明和章节目录局部检查 | 通过 | 真实页面已显示，后续网络超时；不代表全流程 |
| 当前线上 storyBooks 下载与逐文件差异清单 | 通过 | 2026-10-17 实际下载：新增 2、修改 4、不变 23；线上与 efa4759 的 27 文件一致 |
| 控制台创建 story_rollout_admissions 并设置客户端拒绝 | 需要用户做 | read=false / write=false，用户亲自做 |
| 审批 storyBooks 部署 | 需要用户做 | 先交付真实线上差异和集合规则确认，才请求批准 |
| 执行部署并回读零缺失零差异 | 未通过 | 未批准，未执行 |
| 四开关保持关闭，不执行开启 | 通过 | 本任务未写任何线上开关；真实值未独立查询 |
| 邀请/接收/回信/权限/修改历史双账号真机流程 | 需要用户做 | 部署与开关须分别获批后验收 |
| 分享页及邀请页真机外观、完整流程 | 需要用户做 | 局部桌面检查/单测不能替代 |
| 性能验收 | 未通过 | 继承“保存仍偏慢”，本次不能宣称达标 |
| 二维码 | 通过 | 2026-10-17 14:00:14，干净 fbdc4a2；约 30 分钟有效，仅界面预览 |
| 临时 DNS 按用户批准范围变更并恢复 | 通过 | 198.18.0.2 → 223.5.5.5 → 198.18.0.2，前后 cmp 一致 |
| 主包大小及资源无损性 | 通过 | 微信确认主包 2,077,205 字节；解压数据及其他 PNG 块完全一致 |
| 合并 main | 需要用户做 | 本任务未请求或执行 |
