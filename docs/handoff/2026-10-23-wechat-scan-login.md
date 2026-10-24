# 网页用小程序确认登录（方案 B：网页显示 6 位码，小程序输入）

## 2026-10-23 05 → 06 固定依赖与最终代码点

- 网页 05 依赖提交：`d5a8e1deae61d9514b531b70a50d0b5460fe5dc7`，分支 `codex/wechat-scan-login-20261022`。它包含绑定确认的行锁与身份写入同事务修复、HTTP/服务测试和待隔离 MySQL 执行的集成测试。
- 小程序 05 依赖提交：`135f39188116426a73097b6481599bc99c0fe8d8`，同名分支。本提交固定关闭态优先于桥接配置检查、登录错误文案映射及相应行为测试。更早“未提交/无提交号”描述由本段更新。
- 06 可依赖的身份接口：可信云函数按 V1 契约从 `cloud.getWXContext()` 的 APPID/OPENID 计算 `shiguang:<sha256(AppID:OPENID)>`；请求经网页签名、时间戳和一次性 nonce 校验后，网页内部调用 `resolveWechatAccount(subject): Promise<number>`，取得唯一网页 `userId`。接口位置为 `server/services/accountIdentity.ts`，现由 `server/_core/shiguangDesktopBridgeRoutes.ts` 作为 `resolve` 注入。网页登录确认亦用同一 subject 解析账号并签发该 userId 的会话。小程序客户端不得提交 subject 或 userId；06 只能用经认证会话的 userId 作收件人，并在服务器端做联系人/成员关系授权。
- `resolveWechatAccount` 首次见到 subject 会创建微信身份与网页账号，并按既有规则发一次注册赠送；重复解析返回同一 userId。该接口不是无副作用的任意联系人搜索接口。06 应先依据允许的联系人关系得到目标主体，再由签名服务端解析；不要暴露可枚举 subject 的桥接入口。
- 已有邮箱/Google 用户不会因登录同一个微信而自动合并。若他们要求沿用原 userId、故事和余额，需明确绑定并检查 `merge_required`；绑定按钮 UI 可后置，不能把两个账号静默合并。
- 验证证据：小程序补丁合入前 `npm run check` 类型检查通过、1348 项通过；本轮只运行 `npm run workspace:check` 作为本地快照偏差检查，结果提示代码与 2026-09-26 记录云快照不同，这不表示或验证实时云端。网页 `pnpm check`、`pnpm feature:validate` 通过；定向测试 82 项通过、1 项 MySQL 集成测试跳过。隔离数据库未配置，不能宣称确认/拒绝数据库竞态已实测。
- 尚未完成：两端提交均未合主线；小程序修复未部署/上传，实际云函数 `WEB_LOGIN_CONFIRM_ENABLED` 未读取；网页/云函数登录开关均不得由本任务开启。无真机微信登录、故事列表同一 userId 对照或生产环境端到端验收。0035 已执行，严禁重跑；任何生产密钥、开关、部署和共享开发者工具操作都需要另行授权。

## 2026-10-23 接续：绑定事务与章节投递 06 的依赖边界

- 网页05工作树在 `6503a5ae` 上有未提交的本地更改；小程序05工作树仍在 `e7dc948` 上有未提交的本地更改。本段覆盖下面早先“工作树干净”的历史记录。不得丢弃、暂存或搬运其他任务更改。
- 06 必需的主体映射不依赖网页“绑定微信”按钮：小程序云函数只从可信 APPID/OPENID 派生 `shiguang:<sha256(AppID:openid)>`；网页登录确认用该 subject 调 `resolveWechatAccount`，网页登录会话以返回的网页 `userId` 签发。旧“放到电脑”配对码也使用此 userId。06 收件/投递路由可从经过认证的网页会话取得收件人 userId，无需接受客户端 userId，也无需新账号表。先用微信码登录过的两端用户可直接收发。
- 既有邮箱/Google 网页账号尚未关联这个微信时，扫码登录会进入其微信主体对应的另一个网页账号。若 06 需要让这类旧账号也使用原账号收件箱，须先完成显式身份绑定并得到同一 userId；否则 06 应按当前认证 userId 建立/选择收件人，并明确该账号范围。不能自动合并账号或跨账号猜测同一人。
- 绑定微信 UI 可后置，不阻塞 06 的微信主体登录→同一 web userId→已认证收件人链路。绑定 UI 只服务于“保留现有邮箱账号并附加微信身份”的迁移需求，需单独验收。
- 网页侧绑定事务风险已在网页05工作树本地修复：`server/repositories/webLoginRequests.ts` 对仍开放的绑定请求行加 `FOR UPDATE`，并在同一事务内调用 `bindWechatAccount(..., tx)` 写身份、更新 confirmed/merge_required；拒绝/过期竞争不能覆盖行状态。无新增迁移。单元测试在替身事务边界通过。
- 网页类型检查通过；6个定向文件 82 项通过，新增 MySQL 并发集成测试 1 项因无隔离测试库跳过。数据库级绑定/拒绝竞态仍待运行 `pnpm exec vitest run server/integration/webLoginBinding.mysql.test.ts`。不要把替身测试写成真实 MySQL 证明。
- 网页根目录功能账本已登记 `wechat-web-code-login`，状态 observing；网页版关闭态、HTTP 边界和身份契约的详细证据见网页05交接。小程序本地关闭态/错误映射修复仍未部署。
- 两边开关仍须保持关闭，线上 `WEB_LOGIN_CONFIRM_ENABLED` 当前值未知；没有新增部署、迁移、生产配置、真机、二维码或开发者工具操作。
- 下一可供06依赖的代码是网页05分支当前工作树差异（尚无提交号）。提交前需逐一审阅并只 stage 网页05文件；不能让06引用未提交状态。事务修复同时审完且隔离MySQL通过后，才可作为“已验证”的身份绑定基础。

## 2026-10-23 接手续记（以本节为准：本地修复完成，真实登录未验收）

- 继续方案 B：网页显示六位字母数字码，小程序输入确认。下面初版“未部署、0035 待执行”仅为历史状态；**0035 已在正式库执行，不再运行，也不改编号。**
- 起点复核：网页工作树干净 `6503a5ae`；小程序工作树干净 `e7dc948`。网页根目录 main 为 `f6728b9b`，有其他人的未提交工作，未触碰；本地远端跟踪引用 origin/main 为 `dcfc902f`，本轮未联网刷新。
- 已通过 `git show dcfc902f:docs/qa/2026-10-23-wechat-scan-login-release.md` 实际读取发布记录；文件不在网页 05 工作树，但存在于已提交历史，发布工作树为网页 `.claude/worktrees/interesting-kare-090111`（只读）。记录显示网页 dist 发布、0035 执行、云函数 `ba29150` 下载 4/4 一致。本轮没有重新部署或下载。
- 历史记录“没有改环境变量”不能证明云函数运行开关为 false；`WEB_LOGIN_CONFIRM_ENABLED` 的当前实际值没有读过。本轮要求仍是保持两端开关关闭，禁止擅自修改生产配置。
- 父任务真实观察：网页带本站 Origin 的 create 返回 404 disabled；小程序“登录电脑”入口缺席，直接进入确认页输入 000000 返回“电脑连接服务还没有配置好”。这些不是完整登录验收。
- 本轮本地根因：云函数先校验 base URL/secret，再检查登录开关；缺配置遮蔽关闭提示。已有测试只覆盖完整配置。修复将关闭判断提前；开启且缺配置仍失败关闭。第二个问题是新登录动作复用了旧故事传输错误文案，现按 action 区分。
- 安全边界保持：HMAC/nonce、服务端 APPID/OPENID 派生 subject、带密钥摘要、原配对码、merge_required 不自动合并。未改 sourceFingerprint、assertSpaceOwner、reset 护栏、0036 或内容安全。
- 无 dev/preview 服务、无开发者工具/云配置操作、无真实 AI 调用；主仓库 env:status 显示没有 dev server。测试替身和隔离测试 HTTP listener 不算用户实际登录验收。

操作记录（北京时间；工具/模型 token 与费用未取得，不估算）：

| 时间 | 目的/动作 | 结果/实测代价 |
|---|---|---|
| 15:15–15:18 | 规则、账本、任务、交接和代码定向核对；workspace:check | 05 两树干净；workspace:check 是历史云快照比较，不是线上验收；起始前段未计时 |
| 15:18 | 云函数关闭态测试先失败再修复 | 缺配置复现 bridge_not_configured；修复后 13/13；两次命令 wall time 0.476s / 0.312s |
| 15:18 后 | 登录错误文案测试先失败再修复 | invalid_input 复现故事提示；修复后 9/9；两次命令 wall time 0.540s / 0.498s |
| 15:22 | 新增网页 HTTP 测试 | 首次因新测试漏括号未运行，修正后10/10；命令wall time 0.617s / 1.452s |
| 15:25–15:27 | 两端检查、契约比对、账本验证 | 网页类型与91项通过（3.18s测试）；小程序首次类型失败，修正测试兼容性后类型与1348项通过（5.556s测试）；类型检查未独立计时 |
| 至15:30:42 | 自审差异、修订失败来源说明、写运行配置/验收/绑定方案 | 从首次可靠时间记录15:15:07到此为15分35秒；更早准备耗时未计。真实AI调用0、部署0、生产接口调用0、开发者工具操作0；助手token/费用和工具调用总数未取得或未单独统计 |


### 本轮结果与验证边界

- 小程序本地修复文件：`cloudfunctions/drinkingTimeBridge/index.js`（关闭判断先于配置/身份），`miniprogram/services/drinkingTimeAccount.ts`（仅 confirmWebLogin 的格式、频率、重放错误使用登录文案）。生产云函数仍是历史部署版本，**本轮修复尚未上线**。
- 小程序测试：`tests/web-login-confirm.test.js` 覆盖未设置/false/非严格true、配置完整/缺失、preview/confirm/deny、非法码、关闭时零身份读取和零网络请求；`tests/drinking-time-account.test.ts` 覆盖失败隐藏、错误文案、响应校验、客户端只传码与决定及旧传输提示保留。
- 网页仅增加测试与证据，不改生产认证实现：`server/_core/oauth.wechat-login.test.ts` 10 项通过；使用替身提供 create/poll 状态，Cookie、账号读取和原配对码使用真实本地实现。新旧方式向相同 userId 发出相同身份的会话，绑定不切换会话，失败不发 Cookie；**不证明真实微信 subject 已映射或 MySQL 原子性通过**。
- 网页 `pnpm check` 通过；8 个文件定向测试 **91/91**（Vitest 3.18s）：webLogin、oauth.wechat-login、shiguangDesktopBridge、shiguangBridgeSignature、accountSecurity、auth.logout、WechatCodeLogin、AuthEntryPanel。创建、预览/确认/拒绝、120 秒到期、重复消费、错误浏览器验证值、限流、merge_required、签名向量和登出清 Cookie 均有局部证据；真实浏览器登出重登仍待验收。
- 小程序 `npm run check`：类型检查通过，**1348/1348**（测试进程 5.556s）。首次在类型阶段发现新测试使用当前 lib 不支持的 Array.at，改为普通下标后执行一次完整测试；未重复已通过的全量。网页原全量 9 项基线失败复用旧证据，本轮不再全量重跑。
- `pnpm feature:validate` 通过（68 张卡），新增已有能力卡 `wechat-web-code-login`，状态 observing。没有替代、删除或削弱既有功能卡；根目录账本中的他人改动没有纳入。
- 两份 1.6.0 契约 `cmp` 通过，签名 V1/V2 不变。两树 `git diff --check` 通过。未运行任何迁移（包括 0035/0036），未接入正式库。
- 网页渲染测试的旧名称“404 时不渲染”已改为“初始静态渲染显示入口”：原断言没有发请求。实际代码初始显示按钮，create 404 后才隐藏；poll 404 仍继续等待到期。没有合规的运行中本地页面（根目录是他人旧代码，3000 未启动），也没有安装新依赖，故浏览器交互未验证。
- 还需注意时间窗：确认需在 120 秒内；仓库允许确认后 60 秒内领取 Cookie，而组件大约在原 expiresAt + 2 秒后结束轮询。临近到期/网络中断的实际体验尚未验证，不能把服务层到期测试当作浏览器完成证据。

### 最小运行配置核对方案（未执行，不含密钥值）

| 位置 | 必须核对 | 当前可确定的状态 |
|---|---|---|
| 小程序 drinkingTimeBridge | DRINKING_TIME_BRIDGE_BASE_URL 应为网页桥接前缀，例如 https://www.drinkingtime.top/api/shiguang；HTTPS 可达 | 未读取实际配置；bridge_not_configured 既可能由云函数本地配置检查抛出，也可能来自下游网页关闭态，单凭界面提示不能定位缺哪项 |
| 两端服务端 | DRINKING_TIME_BRIDGE_SECRET 与 SHIGUANG_BRIDGE_SECRET 使用同一既有密钥且长度至少32；只记录存在/一致，不展示值、不新建或轮换 | 未核实，不自行写入 |
| 微信身份 | 使用可信 context.APPID/OPENID；只有 context 缺 APPID 时用 WECHAT_APP_ID，且必须匹配当前小程序，不能回退旧 AppID | 核对配置和运行上下文仍待共享工具交接 |
| 网页 | 既有 OTP_DIGEST_SECRET/版本、JWT_SECRET、APP_ORIGIN、MySQL账号/限流/nonce表和0035登录请求表 | 0035有已执行发布记录；不重跑、不重排、不改认证凭据 |
| 开关 | WEB_LOGIN_CONFIRM_ENABLED 与 WECHAT_SCAN_LOGIN_ENABLED 按当前要求保持关闭 | 网页有带Origin create→404证据；云函数实际值未知，只能先读布尔值 |
| 原配对码比较路径 | SHIGUANG_BRIDGE_ENABLED 及原“放到电脑”所依赖配置 | 新 confirm 路由实际单独读取 WECHAT_SCAN_LOGIN_ENABLED；不能凭桥接总开关推定新路由状态。旧路径是否可用须另行只读核对 |

失败含义按真实代码区分：

1. 本次补丁下云函数关闭：webLoginEnabled 返回 false，confirmWebLogin 返回 web_login_disabled，即便尚未配桥接也一样。
2. 云函数开启但本地 URL/secret 不足：bridge_not_configured；入口查询失败后客户端隐藏入口。
3. 云函数开启且本地配置完整、网页新登录关闭：网页桥确认仍按契约返回 503 bridge_not_configured。这不是云函数侧开关值的证明，本轮不改变桥接错误契约。
4. 开启后 000000 为非法字符集，invalid_input 显示“码无效或已过期”；测试正常格式请用测试生成的真实六位字母数字码。不存在/过期/已消费都返回 invalid_code，不暴露账号。
5. 错误浏览器验证值只返回 expired，不能领取也不能消耗另一个浏览器的有效确认；签名错误、nonce重放继续拒绝。

### 获准后的真实验收范围（待批准，未占用共享工具）

前置：先由用户交接开发者工具和云环境使用权；核对实际布尔开关和配置存在性。配置值不符时列出具体缺项再请求变更，不输出密钥。先在干净、包含整合主线的指定发布版本纳入本补丁；只部署 drinkingTimeBridge，并按原规范回读。客户端仅在批准的开发版载入新提示；不出二维码、不提审、不真实调用AI。

- 在两个开关仍关闭时复测：“我的”无新入口；直接进入确认页用 000000 和正常格式码，都提示暂未开放；网页带本站 Origin 的 create/poll 为 404，登录按钮点击后的隐藏情况实测留证。
- 单独批准一次受控开启：先云函数 WEB_LOGIN_CONFIRM_ENABLED，再网页 WECHAT_SCAN_LOGIN_ENABLED；仅用用户指定现有测试微信，不开任何 STORY_* 或 AI 开关。开启不是自动继续本轮的授权。
- 用同一微信和同一 APPID：先完成原配对码登录，记录服务端 userId 和本人故事列表标识；退出；网页新建六位码，小程序预览电脑提示、确认，网页轮询拿 Cookie，比较 userId 与列表；再次退出并重新登录。不要把“同一账号”说成两端正文已经共用。
- 第二个独立浏览器只持 L/错误 V 时不能领取；拒绝后不能登录；等待120秒再确认失败；已用码/已消费请求不能复用；网络中断、临近到期确认和刷新码分别实测。限流与签名重放优先用隔离环境，不在正式站大量试码。
- 不做账号绑定/合并、不发送章节、不改故事正文；原配对码若必须选择故事会产生真实传输，应先核实其是否为授权绑定或快照复制，并把目标和清理范围单独纳入批准，不能当成纯读操作。
- 完成或失败后按批准范围关回网页与云函数开关，验证关闭；保留0035表与审计。只记录必要账号标识，不把 Cookie、L/V、码、OPENID或密钥写进报告。

### 绑定按钮的最小方案（待决定，不实现）

本版本没有独立 SettingsPage；桌面头像菜单复用 `client/src/features/mobileWorkspace/MobileMePage.tsx`。最小建议是在已有“手机登录”配对控件邻近位置放一个“绑定微信”操作，复用同一六位码视图、create(mode=bind) 和小程序确认页；无需新设置页，也不加第二条身份链路。只对已登录网页用户开放，手机端提示确认后文案应为“已绑定”，不能继续写“电脑会自动登录”。

merge_required 原样说明“该微信已有账号，本次未绑定”，只提供“保持分开”或显式退出后改用微信登录；不迁移故事、余额或身份。**先确认按钮位置再实施。**

此外，绑定开启前需处理现有事务边界：`confirmWebLoginBySubject` 先调用 `bindWechatAccount` 再条件更新请求；后者失败时接口可返回 invalid，但绑定可能已发生。需让请求行的有效性/排他决定与身份绑定处于同一事务，并用拒绝与确认并发、到期竞争测试验证“不成功就没有身份副作用”。本轮没有扩改身份事务，绑定不能仅凭已有 merge_required 单测视为可开放。

### 变更保留与交付状态

- 本轮修改均留在两个既有05工作树；没有 commit/stage、push、合 main、迁移、部署、开开关、出码或真实模型调用。
- 网页待审阅文件仅4个：`client/src/features/auth/views/WechatCodeLogin.test.tsx`、`server/_core/oauth.wechat-login.test.ts`、`docs/features/feature-ledger.json`、本交接。
- 小程序待审阅文件仅5个：`cloudfunctions/drinkingTimeBridge/index.js`、`miniprogram/services/drinkingTimeAccount.ts`、`tests/web-login-confirm.test.js`、`tests/drinking-time-account.test.ts`、本交接。
- 若以后提交，先重新列上述精确stage清单并核对他人增量，禁止 git add .。不纳入 node_modules、不搬取03/04/父任务工作树的内容。


## 以下为初版开发记录（历史状态，不作为待执行指令）

日期：2026-10-23。分支 `codex/wechat-scan-login-20261022`，两个仓库同名。契约升到 1.6.0，两份文件逐字节相同。

## 做成了什么

- 网页「微信登录」：显示 6 位码和倒计时，用户在小程序「我的 → 登录电脑」输入并确认，网页随即登录到该微信对应的账号，和「放到电脑」登进去的是同一个账号。
- 登录请求 120 秒有效，只能用一次。6 位码、请求标识、浏览器验证值都只存带密钥的摘要，复用现有 `OTP_DIGEST_SECRET`，没有新密钥。
- 桥接新动作 `confirmWebLogin`（路径 `/web-login/confirm`）。身份由云函数从微信上下文计算，客户端传入的身份一律忽略。
- 已登录网页用户的「绑定微信」只做了服务端和接口。遇到该微信已有账号时返回 `merge_required`，不合并。
- 两个开关都默认关闭：网页 `WECHAT_SCAN_LOGIN_ENABLED`，云函数 `WEB_LOGIN_CONFIRM_ENABLED`。

## 原部署顺序（仅追溯，0035已执行，禁止重跑）

1. 在网页数据库执行迁移 0035（新表 `web_login_requests`），再部署网页。此时开关仍关闭，功能不可见。
2. 部署云函数 `drinkingTimeBridge`。此时 `WEB_LOGIN_CONFIRM_ENABLED` 仍不设置。
3. 最后上传小程序。入口由云函数开关决定，开关关闭时「我的」页没有「登录电脑」。

## 开关打开顺序

1. 先在云函数 `drinkingTimeBridge` 设 `WEB_LOGIN_CONFIRM_ENABLED=true`。
2. 再在网页服务端设 `WECHAT_SCAN_LOGIN_ENABLED=true` 并带环境变量重新加载。
3. 用一个测试微信完整走一遍：网页取码，小程序输码，确认，网页登录，再登出，再用「放到电脑」码登录，确认两次进入同一个网页 userId、故事列表相同。

## 回滚

- 关网页开关：`create` 和 `poll` 立即返回 404，登录面板的微信登录入口消失，其他登录方式不受影响。
- 关云函数开关：小程序入口消失，确认动作失败关闭。
- 迁移只新增一张表，不需要回滚；保留表不影响旧功能。
- 现有「放到电脑」配对码登录、`/desktop/pair/issue` 和签名向量 V1 都没有改动。

## 风险和待办

- 迁移编号 0035 在本分支未被占用。合并时如果别的分支也新增了 0035，需要重排编号，并同步 `drizzle/meta/_journal.json` 和快照。
- 网页全量测试有 9 项失败，分布在 4 个文件（`architecture-boundaries`、`mediaRouteAuth`、`sdk.session`、`routers.storyAgent`）。在干净的 `f6728b9b` 上单跑同样失败 9 项，与本次改动无关。
- 设置页的「绑定微信」按钮没做。接口已就绪（`create` 带 `mode=bind`），页面位置待定。
- 小程序码扫码（方案 A）没做，需要先在 CloudBase 为出码云函数配 HTTPS 路由，由用户决定。6 位码只是登录请求的展示形式，之后可替换展示方式而不改核心。
- 需要建「网页微信登录」功能卡到 `docs/features/feature-ledger.json`。本轮没改账本，因为根目录对它有别人的未提交改动。
- 没有做端到端验证：没有部署、没有真机、没有连云环境。组件只有静态渲染测试，没在浏览器里看过。
- 没有确认企业环境是否已部署 `drinkingTimeBridge`、环境变量是否配齐、正式站是否开启 `SHIGUANG_BRIDGE_ENABLED`。
- 测试环境没有 jsdom，所以登录面板的轮询逻辑没有交互测试。

## 部署记录（2026-10-23）

状态：**已部署，Active，脚本验证通过，线上源码已回读核实，与 `ba29150` 一致。**（初版记录曾写「源码未回读核实」，网络恢复后已补做比对，见下。）

- 函数：只部署 `drinkingTimeBridge`，环境 `cloud1-d5ghzk30ve609f544`，AppID `wx86ae3e9d507ce52d`。没有部署 getOpenId、storyBooks、familyInvite 等其他云函数，没有设置任何环境变量，两个开关仍关闭。
- 源码：`ba2915040ea93726c716ef5a0ea022bf1ff12a4c`，分支 `codex/wechat-scan-login-20261022`，包含 main `235932e`，工作树干净。
- 命令：`node scripts/wechat-cloud-deploy.mjs --execute --env cloud1-d5ghzk30ve609f544 --only drinkingTimeBridge`。部署前干跑确认计划只含 `drinkingTimeBridge`。
- 第一次执行报「CLI 报告失败」，输出被脚本隐藏，原因未知。第一次失败后下载到的云端代码只是 206 字节的 Hello World 示例，说明那次没有传上代码。
- 第二次执行成功，脚本内 `info` 验证为 Active，时间 2026-10-23T03:52:06Z。
- 部署后回读源码：共尝试 6 次下载，每次都下载到新空目录，全部 ECONNRESET，没有取得任何文件，所以没有做逐文件比对。没有重新部署。
- **线上源码比对已完成（网络恢复后第 1 次下载即成功）：** 云端 `drinkingTimeBridge` 下载到全新空目录，与 `ba29150` 的 `cloudfunctions/drinkingTimeBridge` 逐字节比对，排除 `node_modules` 和 `package-lock.json`。云端 4 个文件、仓库 4 个文件，`core.js`（4300）、`egress.js`（5623）、`index.js`（4140，不是示例）、`package.json`（151）全部相同，无多余、无缺失。没有重新部署。
- 未做：没有上传小程序开发版，没有出二维码，没有真机验证。网页端发布记录见 drinking-time-local 的 `docs/qa/2026-10-23-wechat-scan-login-release.md`。
