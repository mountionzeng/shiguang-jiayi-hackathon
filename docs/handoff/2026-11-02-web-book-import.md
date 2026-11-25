# 微信故事导入网页 · 本地交接

用户要求网页微信登录与邮箱同级，先登录再选择是否导入；微信章名映射为网页书稿的可折叠标题，保留原文及图片，不恢复独立章节工作台。

首轮在根仓 main 定向修改 `cloudfunctions/drinkingTimeBridge/{index,egress}.js`、`cloudfunctions/storyDesktopAccess/index.js`，新增 `cloudfunctions/storyDesktopAccess/webImport.js`、`tests/helpers/web-import-fixture.js`、`tests/web-book-import.test.js`。首轮未修改 core.js；后续扫码增量见下节。保留其他未提交代码，没有部署、上传、改配置或生成二维码。

独立 `WEB_STORY_IMPORT_ENABLED`：drinkingTimeBridge 在可信微信确认时建立 kind=web-import 的 principal/space 绑定（失败不破坏原登录），storyDesktopAccess 接收带 HMAC 和持久 nonce 的 POST /v1/web-import。list 仅返回本家庭故事 metadata；read/media 复核主体空间和当前修订。文本与复制资产自身的 view/copy/export/ai/publish/forward 权限全部允许才可导出，下载前后复核；不回写微信稿。

`npm run test:files -- tests/web-book-import.test.js tests/web-login-confirm.test.js tests/story-desktop-access.test.js` 33 项通过。网页侧 123 项和草稿安全 75 项、类型及构建通过；真实临时 MySQL 跨仓测试通过，原生数据为虚构 fixture，不等于云端验收。测试含重复身份、并发幂等、修改网页后重导入、新修订另存、签名/过期/来源权限/图片隔离/下载中撤权。

Web 侧详细 QA：`/Users/yuandai/Documents/New project/drinking-time-local/docs/qa/2026-11-02-wechat-book-import.md`。线上需独立部署两个函数并设置开关，配置签名 HTTPS 路由及网页 authority URL/secret。必须按现有发布规程验证真实新账号、真机和真实导入，不直接从当前混合工作区部署。

尚缺：原生 principal/storyBooks 未初始化账号的导入引导、真实手机切换返回、旧无 chapters 稿的迁移、真实云图传输/时间限额。已初始化空账号返回空列表；未知授权不能冒充无故事。

已按用户要求问“架构优化”：最新上传 0.1.1102（51f677e），未确认已设体验版，无新二维码本地文件；旧预览码未采用。微信后台被浏览器站点安全策略阻止，未绕过。请保留本次未提交文件，后续在干净版本整合后再按发布规程验收。

## 后续扫码登录与可选迁移（2026-11-02）

用户明确确认网页改为“微信扫码确认后自动登录”。Web登录后进入正常工作区，以微信账号身份使用；仅发现尚未迁移的故事修订时询问，允许跳过，不自动导入。首页用户提供的静态体验码独立保留，不能用于本次网页登录确认。

新增 `storyDesktopAccess/webLoginQr.js`：签名 `POST /v1/web-login/qr` 只接受112-bit确认令牌和到期时间，持久nonce防重放，固定 `packages/web-login/pages/confirm/index` 和 `wl_<28位大写hex>` scene。Web浏览器L/V不进入云端或二维码。`WEB_LOGIN_QR_ENABLED=true` 独立控制出码；`WEB_LOGIN_QR_ENV_VERSION=release|trial|develop` 默认release；config声明 `wxacode.getUnlimited` 权限。

`drinkingTimeBridge/core.js` 与Web确认端兼容28位令牌及旧六位码。小程序确认页自动解析scene并预览浏览器，仍须点击确认或拒绝，不自动授权；无scene保留旧手输入口。`storyDesktopAccess/core.js` 提取共用验签，并修复原函数把时钟函数直接用于时间差计算的问题，过期签名按真实时间拒绝。

原生五文件38项及TypeScript通过；Web九文件81项、改名后的19项复验、临时MySQL跨仓登录不自动建稿/错误浏览器/一次领取/同一微信身份验证、类型及清理后构建通过。迁移询问在主仓3000虚构交互页实点通过，非微信云端证据。详细记录：`/Users/yuandai/Documents/New project/drinking-time-local/docs/qa/2026-11-02-wechat-qr-login.md`。

未部署、上传、启用配置或实际调用微信出码。上线顺序：干净版本整合兼容Web后端与确认云函数 → 部署出码HTTPS路由/权限并配置签名密钥 → 上传支持scene的正确小程序版本 → 真实扫码、到期、拒绝、同账号重登及可选导入验收 → 切换网页前端。网页需 `WECHAT_SCAN_LOGIN_ENABLED`、`WECHAT_LOGIN_QR_ENABLED` 和authority URL/secret；确认仍需 `WEB_LOGIN_CONFIRM_ENABLED`。导入开关独立；仅更新前端会显示扫码暂不可用。新账号/真机/云图尚未验收，不能当作正式上线完成。
