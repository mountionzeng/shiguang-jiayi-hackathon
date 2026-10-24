# 06 章节投递（小程序）交接

## 当前实现

- 章节投递契约升级到 1.7.0，与 Drinking Time 网页仓库副本逐字节一致。
- `drinkingTimeBridge` 以 CloudBase `APPID`/`OPENID` 推导签名主体，校验回包形状；不采纳客户端传入的 `subject`、`userId` 或私有 `fileID`。
- 新增 `chapterDelivery` 服务，支持幂等发送、联系人投递、一次性领取、收件箱、图片登记和导入后决议。
- 图片先由可信云函数验证本人照片和审核状态，再进入私有 staging；上传/下载都会校验 MIME、长度与 SHA-256，并拒绝跨源和重定向。收件图片仅在用户选择导入后存入 CloudBase。
- `book` 页面增加投递、领取链接、收件、拒绝/导入及受保护章节发回入口。导入继续走 04 的审核与来源链校验；状态只在导入持久化成功后更新。
- `CHAPTER_DELIVERY_ENABLED=false` 默认关闭；本轮未修改部署环境、未上传小程序、未 push 或合 main。

## 验证

- `npm run typecheck -- --pretty false` 通过。
- `node --test tests/chapter-delivery-contract.test.js tests/chapter-package-cloud.test.js`：28 项通过。
- 网页迁移没有执行，未做浏览器、微信开发者工具或真机端到端测试。

## 待办

- 在两端开发环境完成账号投递、一次性领取、图片、拒绝、导入及受保护章节发回的跨端验收。
- 验证企业微信云函数部署及 `CHAPTER_PACKAGE_ENABLED`、`CHAPTER_DELIVERY_ENABLED`、桥接 URL/密钥配置；生产默认保持关闭。
- 数据库迁移 `0037`、隔离 MySQL 并发/回滚测试及媒体 HTTP 路由测试仍未完成；详见网页仓库 `docs/handoff/2026-10-23-chapter-delivery.md`。
