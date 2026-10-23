# 网页用小程序确认登录（方案 B：网页显示 6 位码，小程序输入）

日期：2026-10-23。分支 `codex/wechat-scan-login-20261022`，两个仓库同名。契约升到 1.6.0，两份文件逐字节相同。

## 做成了什么

- 网页「微信登录」：显示 6 位码和倒计时，用户在小程序「我的 → 登录电脑」输入并确认，网页随即登录到该微信对应的账号，和「放到电脑」登进去的是同一个账号。
- 登录请求 120 秒有效，只能用一次。6 位码、请求标识、浏览器验证值都只存带密钥的摘要，复用现有 `OTP_DIGEST_SECRET`，没有新密钥。
- 桥接新动作 `confirmWebLogin`（路径 `/web-login/confirm`）。身份由云函数从微信上下文计算，客户端传入的身份一律忽略。
- 已登录网页用户的「绑定微信」只做了服务端和接口。遇到该微信已有账号时返回 `merge_required`，不合并。
- 两个开关都默认关闭：网页 `WECHAT_SCAN_LOGIN_ENABLED`，云函数 `WEB_LOGIN_CONFIRM_ENABLED`。

## 部署顺序

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
