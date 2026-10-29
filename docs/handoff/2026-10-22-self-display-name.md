# 微信改名：别人看到的是本人起的称呼

日期：2026-10-22。分支：`codex/self-display-name-20261022`，基于 `93fc0b9`。文档来源：`docs/plans/2026-10-22-chapter-package/01-wechat-display-name.md`（总纲在同目录 `00-overview.md`，两者在根目录 checkout 里是未跟踪文件）。

状态：只提交代码，**未部署、未合并 main、未 push、未真机验证**。

## 做成了什么

1. 改名不再覆盖别人起的备注。`getOpenId/account.js` 的 `syncMembershipProfiles` 只更新自己主家的 `${primaryFamilyId}_owner`，不再按 `accountId` 扫描别人家的 `family_members`（原来最多查 20 条，超出的静默漏掉，这个上限随之消失）。
2. 别人看到的署名改成显示时现查本人称呼，顺序：本人称呼（`user_accounts.displayName`）→ 记录里原来的备注名 → 「一位亲友」。
   - 章节回信：`storyBooks/returns.js` 的 `listReturns`，按 `senderPrincipalId` 查。
   - 改动历史：`storyBooks/changes.js`，按 `editedByPrincipalId` 查。
   - 房间里的投稿：`storyBooks/flow.js` 的 `state()`，以及旧版 `familyInvite/index.js` 的 `loadRoom`，按作者成员的 `accountId` 查；主人自己跳过。
   - 新增 `storyBooks/displayNames.js`（每批最多 20 个 id，批与批内全部并行，任何读失败都静默退回备注名）；`familyInvite/core.js` 里有一份同规则的 `loadOwnNames`（独立云函数不能互相 require）。
3. 改名要过内容安全检查。`getOpenId/account.js` 的 `updateCurrentProfile` 在写库前调用 `msgSecCheck`（version 2，scene 1，当前用户 openid）。拒绝返回「这个称呼暂时不能使用」，服务不可用返回「暂时无法检查这个称呼，请稍后再试」，两种都不保存、不放行。新增 `getOpenId/config.json` 声明 `security.msgSecCheck`。
4. 客户端：`miniprogram/services/accountService.ts` 的 `parseAccount` 会把服务端的拒绝原因抛出来，「我的」页面原有的 toast 会显示它。

## 行为边界

- `getOpenId` 只在「改名被拒绝」和「检查不可用」两种情况结构化返回 `{accountLinked:false, profileError:{code,message}}`。登录关联（`linkCurrentAccount`）失败仍然吞掉错误并返回 `accountLinked=false`，行为不变。
- 读 `user_accounts` 只取 `displayName` 一个字段，`accountId` 不会进入任何返回值（`flow.js` 里通过不可枚举属性 `memberAccountIds` 传递）。
- `listReturns` 里两次 `assertSpaceOwner` 的次数和位置没动；改动历史的名字解析在事务外。
- 不回填历史数据。没有 `principalId` / `accountId` 的旧记录保持原样，继续显示备注名。
- 投稿**写入**时仍然记备注名（`familyInvite/index.js` 的 `authorName` / `contributorName`）；**读取**时才换成本人称呼。
- 没改：主人编辑备注的方式、`copies.js` 的 `senderName`、`invitations.js` 的 `applicants[].displayName`（它们现在是兜底用的备注名）、`familyInvite/index.js:204-213`。「TA 自称 X」小字本轮不做。

## 改动文件

- 修改：`cloudfunctions/familyInvite/core.js`、`cloudfunctions/familyInvite/index.js`、`cloudfunctions/getOpenId/account.js`、`cloudfunctions/getOpenId/index.js`、`cloudfunctions/storyBooks/changes.js`、`cloudfunctions/storyBooks/flow.js`、`cloudfunctions/storyBooks/returns.js`、`miniprogram/services/accountService.ts`、`tests/account-service.test.ts`
- 新增：`cloudfunctions/getOpenId/config.json`、`cloudfunctions/storyBooks/displayNames.js`、`tests/self-display-name.test.js`、本文档

## 测试结果

- 局部：`npm run test:files -- tests/self-display-name.test.js tests/account-service.test.ts`，19 项全部通过。
- 完整：`npm run check`（类型检查 + 全量测试）退出码 0，1350 项通过，0 失败，0 取消，0 跳过，约 240 秒。
- 新增测试覆盖：回信 / 改动历史 / 房间投稿三类署名各自的三态（本人称呼、备注名、「一位亲友」）；A 改名后 B 家里 A 的成员备注不变、只改自己的 `_owner`、不再扫描别人家成员；内容安全拒绝和不可用（抛错、无返回、未知值、未配置检查函数）都不保存；名字解析失败时回信列表、改动历史、读房间照常返回；`assertSpaceOwner` 调用次数不变；45 个 id 一次并行发出、没有串行轮次；`getOpenId` 入口的结构化返回与登录失败行为；`config.json` 权限。

## 需要部署

三个云函数都有改动，**部署前必须先问用户**，并与其他任务错开微信开发者工具与云环境 `cloud1-d5ghzk30ve609f544` 的使用时间：

- `getOpenId`：必须连新的 `config.json` 一起部署，`msgSecCheck` 权限才会生效。
- `storyBooks`
- `familyInvite`

另一个对话「开放微信发送给家人」可能也在改 `storyBooks` 的开关，部署顺序要先和用户、协调会话确认，避免互相覆盖。部署走 `scripts/wechat-cloud-deploy.mjs`，要求工作树干净且包含最新主线；部署后按 `AGENTS.md` 记录函数名、环境、提交与验证结果。

## 风险

1. **`familyInvite/index.js:204-213` 本轮未改。** 还没设过称呼的被邀请人，接受邀请时会把邀请人起的备注写成他的本人称呼，并标记资料已完成（`profileCompletedAt`）。此后他发给其他家庭的内容都会显示这个备注。改不改由用户决定。
2. **读房间多一轮并行读取。** 必须在成员读完之后才知道要查哪些账号，所以多了一轮对 `user_accounts` 的并行读取（没有非主人作者时不发）。测试断言了只有一轮并行，但真实云端延迟没有测过。
3. **`msgSecCheck` 对违规内容的返回形态没有在真机验证过。** 代码把 `suggest` 为 `risky` / `review`、以及抛出错误码 87014 都当作拒绝；其余异常和无结果当作「检查不可用」。没有调用过真实微信接口。
4. 房间里的投稿署名是读取时才替换；导出、摘要等不经过 `state()` 的路径看到的仍是写入时记下的名字。
5. 本人称呼读不到时（账号不存在、读失败）静默退回备注名，用户不会收到任何提示。

## 需要用户决定

- 是否修复风险 1（`familyInvite/index.js:204-213`）。
- 何时、按什么顺序部署这三个云函数。
- 真机验证安排：改名通过 / 被拒、B 在回信与房间里看到 A 的新称呼、B 家里 A 的备注不变。验证前需先按 `AGENTS.md` 在电脑端走完整流程再出二维码。

## 部署记录（2026-10-23）

- 用户 10-23 明确要求「现在部署 aaaba5f」。从本分支干净工作树用标准脚本部署：`node scripts/wechat-cloud-deploy.mjs --execute --env cloud1-d5ghzk30ve609f544 --only getOpenId --only storyBooks --only familyInvite`，10:08:16 开始。
- 脚本返回「WeChat DevTools CLI reported a failure」（脚本隐藏原始输出）。随后逐个 `cloud functions info`：三个函数均 Active。
- 用 CLI 重新下载三个函数，与 `aaaba5f` 源码逐文件比对（排除 node_modules、package-lock.json）：getOpenId 0 差异，familyInvite 0 差异；storyBooks 首次下载 ECONNRESET（TLS 断开），重试成功后 0 差异，`displayNames.js`、`returns.js`、`changes.js`、`flow.js` 逐一相同。结论：三个函数线上源码等于 `aaaba5f`；脚本报的失败最可能是同类网络中断，原文未保留。
- 证据目录 `/private/tmp/shiguang-deploy-aaaba5f-101059/`（临时目录，可能被系统清理）。
- 未改任何环境变量或开关，未合 main，未 push，未出二维码。
- getOpenId 新增 `config.json` 的 `security.msgSecCheck` 权限是否已在线上生效，未单独核验；改名后若一直提示「暂时无法检查」，先查这个。
- storyBooks 环境变量是否在部署后保持不变，由「开放微信发送给家人」会话只读核对。
- 待真机验证：改名、被拒绝的称呼、回信/改动历史/投稿显示本人称呼。
