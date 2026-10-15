# 第一次登录说明交接

日期：2026-10-15。分支：`claude/adoring-booth-e44261`，基于 main `235932e`。未合并、未推送、未部署。

## 做了什么

代码提交：`86597ab`（组件、服务、首页两处挂接、测试）。本文档单独一次提交，提交号在交付消息中给出。

三个由用户确认的决定：纯说明不收集称呼；组件可复用、首页先挂；每台手机各看一次。

- `miniprogram/components/first-login-intro/`：独立弹层组件。内容：这是什么、有只属于自己的记忆之家（登录时已准备好）、别人看不到、称呼可随时在「我的」改。只有一个按钮「知道了」，点击才关闭。可选属性 `inviter-name`、`inviter-message`，供邀请页日后直接带入邀请人原话。
- `miniprogram/services/firstLoginIntro.ts`：文案生成、本机已读记录、被邀请判断。
  - 已读只存本机 `firstLoginIntroSeen`（带版本号，改文案想让所有人重看就把版本加一）。
  - 被邀请判断：只读调用 `getOpenId:get` 和 `familyInvite:listRooms`，如果加入了不是自己主空间的记忆之家，就在说明顶部显示「已加入「房间名」，大家叫你「称呼」」。查询失败或超过 3 秒就退回通用说明。
- 首页挂接只有两处：`pages/index/index.json` 注册组件一行，`pages/index/index.wxml` 末尾放一个标签。
- `tests/first-login-intro.test.ts`：9 项新测试。
- 基线：`npm test` 1171 项通过；完成后 `npm run check`（类型检查 + 全部测试）1180 项通过。

## 没做什么为什么

- 没让他在说明里填称呼：用户选了纯说明（方案 A）。被邀请的朋友沿用邀请人起的名字，这件事在邀请那边（接受邀请时写入），这里只展示。
- 没记云端「已看过」：那要改 `getOpenId` 账号规则，属于红线。代价：换手机、重装、清缓存会再看一次；已有老用户更新后也会看到一次。
- 没碰邀请相关文件（`storyBooks`、`familyInvite`、`pages/invite`、`story-sharing`、`pages/book`、`pages/room`、`storyReturnsInbox`），也没改 `getOpenId`、没部署、没连云环境、没合并 main。
- 没在邀请接受页挂说明：邀请页是另一个会话的范围。见下节的挂接建议。
- 没有邀请语原文的读取接口：`listRooms` 只返回房间名和称呼，不含邀请人的话，所以首页版本显示不出「邀请人的话」原文。要显示需要 `familyInvite` 多返回一个字段，或由邀请页传入。
- 没用真机或开发者工具验证（开发者工具连的就是共用真实云环境，红线不让连）。

## 和本交接不一样的地方

- 任务背景写「邀请人的话」放在说明里。当前实现只在两种情况下能显示原文：邀请页通过 `inviter-name`、`inviter-message` 传入，或 `listRooms` 日后返回。首页自动版目前只显示「加入了谁的记忆之家、大家怎么叫你」，没有原文。这是在第二个问题里用户选「组件可复用，首页先挂」的结果。
- 「被邀请」的判断是「加入了不是自己主空间的房间」。如果邀请那边改成别的存法（例如不再出现在 `listRooms`），这里要跟着改。依据是我读到的当前 main 上的 `familyInvite/index.js` 的 `listRooms` 实现，以及邀请改动工作树里的同一函数，两者一致。
- 邀请接受后跳转 `/pages/room/room`，不回首页。被邀请的朋友第一次落地是房间页，不是首页，所以他们要等回到首页才会看到说明。要让朋友接受邀请后马上看到，需要在 `pages/room` 或接受后的跳转里也挂这个组件，这在别人的文件里，没有做。

## 验收清单

| 项目 | 状态 |
|---|---|
| 类型检查 `npm run typecheck` | 通过 |
| `npm run check`，1180 项（基线 1171，新增 9） | 通过 |
| 说明文案覆盖：是什么、独立空间、别人看不到、称呼可改 | 通过（单元测试） |
| 被邀请时顶部显示邀请信息，空值不显示占位 | 通过（单元测试） |
| 已读只存本机、读写失败不阻塞、不写账号 | 通过（单元测试） |
| 说明组件源码不含账号写入、邀请接受、云函数直调 | 通过（源码检查测试） |
| 微信开发者工具里看版式、滚动、按钮可点 | 需要用户做（开发者工具连共用真实云环境，红线禁止我连） |
| 真机：全新微信账号首次打开首页，看到通用说明，点「知道了」后重开不再出现 | 需要用户做 |
| 真机：被邀请的朋友在首页看到「已加入…大家叫你…」 | 需要用户做 |
| 邀请页或房间页挂接 `inviter-name` / `inviter-message` | 需要用户做（与邀请改动一起提交时接上，挂接代码见下） |
| 按 AGENTS.md 出二维码前的完整流程验收 | 需要用户做（本改动未出二维码） |
| 云函数部署 | 不涉及，没有改云函数 |

### 邀请改动合并后的挂接（3 行，由邀请改动的提交者接）

`pages/invite/invite.json` 的 `usingComponents` 加 `"first-login-intro": "/components/first-login-intro/first-login-intro"`，`invite.wxml` 末尾加：

```xml
<first-login-intro inviter-name="{{invitation.inviterName}}" inviter-message="{{invitation.message}}"></first-login-intro>
```

房间页（`pages/room`）同理，用接受后拿到的邀请人信息。

## 提交

分支 `claude/adoring-booth-e44261`：代码 `86597ab`；文档提交号在交付消息中给出。
