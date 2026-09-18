# 独立故事书发布清单

## 发布前

- 确认 `npm run typecheck`、`npm test` 和 `git diff --check` 全部通过。
- 按 `deploy/wechat-cloud.manifest.json` 创建故事集合、配图的 `storyId` 索引和书稿索引。
- 先部署 `storyBooks`、故事感知的 `storyImages` 和文本 AI 函数，再上传小程序。
- `STORY_BOOKS_MIGRATION_READY` 保持关闭，用合成账号检查空书、两书隔离、并发保存、待确认章节和图片隔离。
- 对真实账号只做读取清点：记录旧记忆、旧版本、自动归属数、待确认数和异常数，不记录正文或密钥。

## 启用迁移

1. 保留旧集合和旧版本，不做物理删除。
2. 先把合成测试账号的 familyId 写入 `STORY_BOOKS_MIGRATION_FAMILY_IDS`（逗号分隔），再设置 `STORY_BOOKS_MIGRATION_READY=true` 并重新部署 `storyBooks`。空白白名单不会迁移任何账号。
3. 先用小范围账号触发迁移，核对源数、新故事数、版本数和待确认数。
4. 真机验证建书、切模式、写章节、恢复版本、配图、删除/恢复和电脑端快照。
5. 扩大范围后观察故事版本冲突、迁移失败、待确认积压和配图异常。

## 回退

- 立即暂停新写入和迁移触发，不删除 `stories`、故事版本、迁移项或图片。
- 保留新版只读查看能力；不恢复旧客户端对按人混合书稿的可写权限。
- 依赖修复后用原请求 ID 重试，迁移游标和书稿操作都是幂等的。

## 安全边界

- 所有新书写操作由 `storyBooks` 按微信身份解析账号空间，不信任客户端传入的 familyId。
- AI 共创在调用文本模型前从 `storyBooks/context` 取当前书的服务端上下文；客观记录不调用文本模型。
- 图片的查询、限额、参考图和历史引用保护均按 `storyId` 执行。
