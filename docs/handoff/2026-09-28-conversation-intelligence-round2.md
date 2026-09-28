# 对话智能第二轮交接

更新：2026-09-28。

## 1. 做了什么（附提交号）

- 提交 `d3ac5ae`（`fix: clarify interview fallback labels`）完成 U1 代码修改：追问卡片的三种状态改成用户能听懂的标签。
- 提交 `adbaefe`（`fix: keep feeling follow-ups off activity planning`）收紧 U3 相关提示：当用户已经在解释“不用赶着去哪里”这类感受时，下一问继续问意义或在意之处，明确禁止绕成“如何安排时间”“把空下来的时间留给什么”“接下来做什么”这类活动安排式追问。
- 三种追问标签现在分别是：
  - 模型正常：`小忆认真想过了`
  - 模型不可用：`小忆暂时没连上，先陪你聊`
  - 内容检查日限制触发：`小忆今天有点迟钝，先按常问的陪你说`
- 这三句都避开了 `模板`、`本地`、`降级`、`AI`、`模型`、`云端`、`额度` 这些内部词，并在测试里固定互不相同。
- 新增门禁记录表：`docs/acceptance/2026-09-28-conversation-intelligence-round2-gates.md`。表里准备了 U1 长辈判据、U2 二十条人工评审、U3 十条固定复测、U4 三类风格账号、U5 双账号两设备记录栏，结论均留给用户判断；并补入评审入口索引。
- 已跑局部检查：`npm run test:files -- tests/interview-service.test.ts tests/page-handlers.test.ts`，98 项通过。
- 已跑 U3 提示约束局部检查：`npm run test:files -- tests/cloud-function.test.js`，36 项通过。
- 已跑完整检查：`npm run check`，1009 项通过。该结果只说明工程检查健康，不替代下面的门禁。
- 2026-09-28 已按用户授权执行 U3 十条真实复测：先增量部署 `chatInterview/index.js`，部署确认任务 `confirmation_cloud_fn_inc_deploy_538e9240-8f81-4f9f-b657-c490f05ebae8` 成功，随后通过微信开发者工具逐条调用真实云函数。复测原始结果写入 `docs/acceptance/2026-09-28-conversation-intelligence-u3-retest.json`。
- U3 十条均已取得真实云端回复。`meaning-continuation` 前三次同步调用返回 `timeout waiting for automator response`，随后改用后台触发 `wx.cloud.callFunction` 并从模拟器 console 读取标记结果，补齐真实回复。
- 已整理 U3 人工评审表：`docs/acceptance/2026-09-28-conversation-intelligence-u3-review.md`。表内列出固定输入、判据和真实回复，用户结论全部保留为待判断。
- 已整理 U2 二十条人工语义评审表：`docs/acceptance/2026-09-28-conversation-intelligence-u2-review.md`。表内列出原话、评审锚点和真实回复，用户结论全部保留为待判断。
- 提交 `dc487bf`（`docs: record round2 U3 retest`）记录首轮 U3 真实复测证据。
- 提交 `663cfdd`（`docs: complete round2 U3 retest evidence`）补齐 U3 第 10 条真实回复。
- 提交 `2c6bdec`（`docs: add U3 review sheet`）整理 U3 人工评审表：`docs/acceptance/2026-09-28-conversation-intelligence-u3-review.md`。
- 提交 `5262b2a`（`docs: add U2 semantic review sheet`）整理 U2 二十条人工语义评审表：`docs/acceptance/2026-09-28-conversation-intelligence-u2-review.md`。
- 提交 `309e147`（`docs: add remaining round2 review sheets`）整理 U1、U4、U5 的现场验收表：`docs/acceptance/2026-09-28-conversation-intelligence-u1-label-review.md`、`docs/acceptance/2026-09-28-conversation-intelligence-u4-style-accounts.md`、`docs/acceptance/2026-09-28-conversation-intelligence-u5-isolation-devices.md`。

## 2. 没做什么，为什么

- 没有把 U3 写成通过：十条真实回复已取得，但是否符合“第 17 条”的语义判据仍需用户评审，不能用 Agent 自判替代。
- 没有替用户评 U1、U2、U3、U4、U5：计划明确这些门禁需要用户判断，Agent 只准备记录表。U1、U2、U3、U4、U5 的人工评审入口已补齐；U4、U5 仍需现场账号和设备验证。
- 没有开启 `CLOUD_AI_RELEASE_READY`，也没有改 `PERSONAL_MEMORY_ENABLED`。
- 没有绕过内容检查，没有合入 main，没有生成新二维码。
- 没有重新部署客户端隔离预览：本轮明确不要生成新二维码；如需在真实小程序页面看 U1 标签，后续可以只更新隔离预览，再由用户做门禁 1 判断。

## 3. 和需求不一样的地方：包括你认为需求写错了、或者你做得比需求更严的地方

- 我把“模型正常”的追问标签也一起改掉了。需求说可一并改，但不是硬要求；这么做是为了避免一侧仍显示 `文字 AI 生成` 这种内部词。
- U3 记录表严格使用优化记录里的十条固定输入，其中原问题保留三次重复输入，用来观察模型输出波动；没有加入新的样例。
- 搜索时仍能在旧验收记录、书稿整理、图片说明等位置看到 `文字 AI 生成` 或旧标签。这些不是本轮追问卡片 U1 的显示面，且部分是历史证据，所以没有为了清词而改旧记录。
- 计划里写“U1 改完需重新部署客户端隔离预览”。这一步本次没有执行，因为用户同时明确不要新二维码；我把它记为后续验收动作，不把它写成已完成。

## 4. 门禁表：每一行写「通过／未通过／需要用户做」

| # | 门禁 | 状态 | 说明 |
|---|---|---|---|
| 1 | R1 标签 | 需要用户做 | 代码已改为三种用户语言标签；长辈判据仍需用户判断 |
| 2 | 语义相关率 | 需要用户做 | 二十条人工评审表已准备；不能用 Codex 自判代替 |
| 3 | 箴言类不问事实 | 需要用户做 | 前五条记录表已准备；需用户按需求判据确认 |
| 4 | 第 17 条 | 需要用户做 | 已进一步收紧提示约束；用户已授权并完成 U3 真实复测，10/10 取得真实云端回复；是否通过仍需用户评审 |
| 5 | 倾向准确性 | 需要用户做 | 三类风格账号与证据不足对照表已准备；未开启个人记忆全量验证 |
| 6 | 隔离 | 需要用户做 | 双账号两设备记录表已准备；未进行真机隔离判断 |
| 7 | 真机 | 需要用户做 | 真实手机基线原句复测未做；没有生成新二维码 |
