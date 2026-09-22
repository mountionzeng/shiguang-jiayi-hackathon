# AI 文字理解与编辑：实施与发布交接

实施分支：`codex/ai-text-understanding-editing`。
基于 `main@ec42ffd` 上已保存的 AI 修改历史提交 `421f1b9`，在隔离副本实施。原主目录、其他工作树与微信审核材料没有改动。

## 已完成的本地实现

- 采访五处输入处理不再向正在编辑的原生输入框回写 value。显式载入、选故事和发送清空仍使用 setData。保留用户有意重复的文字，不做字符串去重。
- interview → 保存 → archive 编辑 → 撤回的接线回归覆盖原话与版本历史；没有重写已有领域模型。
- 新建不带旧记忆的空故事不依赖迁移。服务层不再先跑迁移；领域、云端事务保持请求编号幂等、名称占用与所有权检查。迁移未完成时新书也可见。引用旧记忆、保存书稿和迁移归属等其他操作仍按原迁移闸门处理。
- 后续迁移保留独立新书，同名旧故事自动区分名称；迁移与新建并发时拒绝过期迁移快照。`Story` 一条记录代表一本故事书；人生之书是全部故事书的集合。
- 独立 personalMemory 云函数：抽取纯函数、仓储、选材、上下文接入、独立同意与忘记。参考 drinking-time-local 三段结构。
- “我的 → 小忆记住的事”：查看来源、开启、暂停、逐条忘记。默认关闭；仅同意在线 AI 和独立记忆授权后处理今后保存的本人原话，不自动扫描全部旧库。
- 成功保存之后异步调用，只传 memoryId；不阻塞保存。中间的“先存原话再整理”暂不触发学习，避免抢占当轮整理的额度。失败留存任务状态，后续保存可重试；本版没有自动后台补跑定时器。

## 个人理解的不变式

1. 身份只来自微信上下文与服务端账号映射，客户端 userId/familyId 无效。仅本人个人原话可提炼；家人投稿、导入的来源受限作品与 AI 正文不作为证据。
2. question / quotation / hypothesis 永远空输出；未知字段值不转换、不猜默认；project scope 强制排除；inferred 保留低确定性来源标记。
3. `allowProactiveMention !== true` 的条目在仓储装配层排除，纯选材候选没有该字段。无有效原文证据也排除。
4. 候选最多 20；每次最多 4、每类最多 2；按更新时间与置信度排序。最近 7 天使用过的不再次主动提及，版本 `u6-v1` 写入产物与使用记录。使用时间直接保存在 lineage 当前记录，无需扫描超过 30 天的历史。
5. 忘记 tombstone 绑定账号、lineage 和该 lineage 历代证据；重新开启也不清除。被忘记的证据不再提炼，相同规范化文本也被抑制。
6. 账号级 epoch 保护忘记/暂停与抽取、生成并发。模型返回前再次确认权限、epoch 与证据；失效结果丢弃。发送给模型后已经发生的请求无法撤销。
7. 新集合禁止客户端直接读写。tombstone 不带 familyId，避免被普通家庭清理误删。原记忆删除后，其理解不进入后续提示词。
8. 背景只帮助理解语境和避免重复；不得变成本次故事新增的事实，用户当轮纠正优先。家庭对话不接入个人背景。

## 部署内容

新增集合（每个按 `userId, _id` 建索引）：

- `personal_memory_controls`
- `personal_memory_insights`
- `personal_memory_evidence`
- `personal_memory_suppressions`
- `personal_memory_jobs`

集合已同步登记 bootstrap 与 `deploy/wechat-cloud.manifest.json`。逐集合应用 `deploy/personal-memory/database.rules.json`，客户端 read/write 均为 false。

新增云函数 `personalMemory` 是 configured，默认部署不包含它。还需发布 `chatInterview`、`organizeMemory`、`storyBooks` 的本次改动，以及已有 `recordAiConsent` 和配套权限护栏。三处文字生成与新抽取函数的清单上限设为 60 秒，提供访问检查、内容审核与保存的余量；实际模型中止仍分别为 20/28/20/15 秒。

独立云函数目录需要自带模块。修改个人理解实现后执行 `node scripts/sync-personal-memory.mjs`；修改故事领域规则后执行 `node scripts/sync-story-core.mjs`。回归测试校验副本一致。

## TokenHub DeepSeek V4 切换配置

本轮没有读取密钥、修改云环境或发出付费请求。模型具体 ID、账号可用档位和单价仍需控制台确认；不能把展示名“DeepSeek V4”猜成 API model。

| 云函数 | 地址 | 密钥 | 模型 |
|---|---|---|---|
| organizeMemory | ORGANIZE_AI_BASE_URL | ORGANIZE_AI_API_KEY | ORGANIZE_AI_MODEL |
| chatInterview | CHAT_AI_BASE_URL | CHAT_AI_API_KEY | CHAT_AI_MODEL |
| generateBiography | AI_BASE_URL | AI_API_KEY | AI_MODEL |
| personalMemory | PERSONAL_MEMORY_AI_BASE_URL | PERSONAL_MEMORY_AI_API_KEY | PERSONAL_MEMORY_AI_MODEL |

地址使用现有代码允许的 `https://tokenhub.tencentmaas.com/v1`；实际访问能力必须验证。新抽取配置未设置时可沿用 CHAT_AI_* / AI_*。没有放宽既有 TokenHub 服务商限制，也没有硬编码任何 DeepSeek 型号。

`PERSONAL_MEMORY_ENABLED=true` 要分别配置到 personalMemory、chatInterview、organizeMemory；同时保留 `AI_SERVER_RELEASE_READY`、`WECHAT_APP_ID`、服务端授权及额度护栏。用户仍需独立开启记忆。密钥只能放控制台或安全环境变量，不进入提交或日志。

`node scripts/verify-tokenhub-text.mjs --request-id <稳定编号>` 默认仅输出预演，不访问网络。确认型号、计费及用户明确授权后，才在安全环境设好 TOKENHUB_API_KEY、TOKENHUB_MODEL 并添加 `--execute` 验证一次无个人数据的请求。请求编号用于追踪，不承诺供应商按它计费幂等；未知结果不要盲目重复调用。

`CLOUD_AI_RELEASE_READY` 仍为 false。仅在本机临时开闸进行真机验证，不提交 true。

旧数据迁移环境配置仍需单独核对企业库数据及自己的 familyId，然后按原交接使用迁移白名单；本次没有开启全量迁移。

## 验证与剩余发布验收

自动测试包括输入事件不回写、长文本/删改/发送清空、原话历史闭环、新建幂等/冲突、迁移同名保护、纯抽取与选材、忘记竞态、失效证据、两个账号的云函数隔离、真实仓储到生成提示词接线、UI 操作与保存不阻塞。

还必须进行：

- 微信键盘真机语音连续三段、键盘收放、中途删改、长文字；确认原生输入框和发送气泡一致。
- 两个微信账号验证：启用授权、归属与拒绝越权，家人 pending 流程不变，关闭/忘记后不再引用；核对数据库拒绝客户端直连。
- 在迁移未启动及 preparing 状态创建空故事，再迁移同名旧故事；检查新旧记录和名称占用都保留。
- 确认 TokenHub 实际型号与账单，授权后测试超时、JSON 输出和失败降级。单元测试使用模拟模型，没有替代真机和真实供应商验收。
- 本轮未运行微信开发者工具/真机视觉验收，原生页面仍需上述验收。

## Post-Deploy Monitoring & Validation

负责：发布操作者；窗口：先用本人白名单账号验收，首日观察后再扩展。

- 搜索云函数错误码 `PERSONAL_MEMORY_CHANGED`、`PERSONAL_MEMORY_SOURCE_CHANGED`、`AI_RATE_LIMITED`、`AI_CONTENT_CHECK_UNAVAILABLE`；不记录原话和完整模型内容。
- 查看 personal_memory_jobs 的 running/failed 占比、各函数耗时、账号 aiUsage.byKind 和 TokenHub 调用账单。
- 健康信号：保存不等待模型、同一证据重试不重复抽取、忘记后候选为空、跨账号请求被拒、故事新建不触发迁移。
- 若出现跨账号数据或忘记后复活，立即停用 PERSONAL_MEMORY_ENABLED 并暂停发布；保留 tombstone，修复后重新双账号验收。
- 若模型超时或费用超预期，关闭记忆提炼和客户端 AI 发布闸门，保留原文记录能力。不要调用重置房间或删除家庭函数排障。
