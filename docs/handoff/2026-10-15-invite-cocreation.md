# 2026-10-15 邀请朋友共创：邀请链路代码整理

分支 `codex/invite-cocreation-20261015`，工作树 `.worktrees/codex/invite-cocreation-20261015`，起点 main `235932e`。

## 1. 做了什么

提交 `7b59cd9`：删除邀请链路里确认没有人调用的代码，不改任何行为。

- `cloudfunctions/familyInvite/index.js`：删除 `ensureCollections`、`COLLECTIONS`、`isExisting`。全仓库没有调用，`tests/family-invite.test.js` 还专门断言不能调用它。
- `miniprogram/pages/invite/invite.ts`：删除只写不读的 `codeReady` 状态，以及模板里没有绑定的 `goBack` 方法。

验证：`npm run typecheck` 无报错。`npm test` 为 1171 项通过、0 失败，与改动前我自己跑出的基线一致。

## 2. 没做什么、为什么

- 没有减少或合并邀请的三步（写给谁、邀请语、选插图）。你说过改哪里先问你，不要猜；这一步会改变用户可见流程，也会改动锁定三步行为的现有测试。
- 没有改投稿确认（C）和受邀人落地页（B）。两处现有逻辑读下来是通的：受邀人以 contributor 加入，投稿写入时 `reviewStatus` 为 `pending`，并有内容安全检查。读代码不等于真机走通。
- 样式表里 `accept-card-book`、`accept-card-nest`、`style-art-book`、`style-art-nest` 看似未使用，实际由模板按邀请样式拼接类名，所以保留。
- 没有部署云函数，没有合并 main，没有生成预览二维码，没有操作开发者工具和云环境。
- 没有碰 `DK—小程序` 目录，没有改 AI 开关、`sourceFingerprint`、`assertSpaceOwner`、内容安全检查和两个重置护栏。

## 3. 和本交接不一样的地方

- 交接说根目录 checkout 有别人的 5 个 personal-memory 未提交改动。我开工时 `git status` 为空，`workspace:check` 显示 `clean: true`、`changedFiles: 0`。我没有动过根目录。
- `workspace:check` 列出 `familyInvite` 等多个云函数文件与 2026-09-26 的云端快照不同。这只是对照旧快照，不代表线上现状。本次删除的函数没有被调用，所以不需要因此重新部署；但线上源码与仓库源码是否一致，我没有核对。
- 体验版继续用后台已提交的 `2026.10.14.1`（main `235932e`）。`7b59cd9` 没有行为变化，不必为它新提交一版；如果你想让体验版包含这次整理，才需要上传 `7b59cd9`，且应先走完下面清单。

## 4. 验收清单

| 项目 | 状态 |
|---|---|
| 类型检查 | 通过 |
| 全量测试与基线持平（1171 通过、0 失败） | 通过 |
| 开发者工具里跑完邀请页三步并生成邀请图 | 需要用户做 |
| 两个微信账号真机：邀请、扫码、接受 | 需要用户做 |
| 受邀人写故事，主人收到并确认，正式书稿不被直接改动 | 需要用户做 |
| 受邀人看不到主人的其他记忆，只看到自己写的和被明确分享的 | 需要用户做 |
| 线上 familyInvite 源码与仓库一致 | 需要用户做 |
| 预览二维码（约 30 分钟失效，须在上面流程跑通后再生成） | 需要用户做 |
| 后台把开发版本选为体验版并添加体验成员 | 需要用户做 |
