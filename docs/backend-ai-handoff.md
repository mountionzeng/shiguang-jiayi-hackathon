# 后端与 AI 对接说明

本文档记录 `dev_backend` 分支对后端、云开发和 AI 生成能力的协作边界，方便前端、产品和后端并行开发。

前端对接建议见 `docs/handoff/frontend-backend-integration-notes.md`。当前原则是尊重 `main` 分支的页面和 UI，后端分支只在确有必要时提出前端改动建议。

## 当前前端数据结构

当前小程序已经实现文字 MVP，核心数据在 `miniprogram/domain/biography.ts`：

- `FamilyRoomState`：一个家庭房间，包含主人公、成员、投稿和生成草稿。
- `FamilyMember`：家庭成员，包含姓名、关系、头像文字和角色。
- `MemoryContribution`：一段由某位成员提交的回忆，包含投稿者、正文、可见范围、审核状态和创建时间。
- `BiographyDraft`：生成后的传记章节草稿，包含标题、段落、来源数量、生成时间和生成模式。

这个结构已经覆盖了“这段记忆是谁提供的”“是否家庭可见”“老人是否确认”三个后端必须保留的事实。

## 与后端长期模型的对应关系

| 前端 MVP | 后端长期模型 | 说明 |
| --- | --- | --- |
| `FamilyRoomState` | `Family` | 当前一个房间对应一个家庭空间。 |
| `FamilyMember` | `FamilyMember` + `Person` | MVP 把成员账号和人物资料合在一起；后端会拆开，以支持一个用户管理多个人物。 |
| `MemoryContribution` | `SourceRecord` + `Memory` | 投稿原文先作为来源记录保存，经过确认/整理后再形成结构化记忆。 |
| `authorMemberId` | `SourceRecord.contributor_member_id` | 必须保留，用来说明素材来自 A 还是 B。 |
| `visibility` | `SourceRecord.visibility` | 私密内容不得进入公共传记或模型请求。 |
| `reviewStatus` | `Memory.review_status` 或审核字段 | 只有确认且家庭可见的来源可进入生成。 |
| `BiographyDraft` | `GenerationJob` + `GeneratedArtifact` | 产品级生成任务和最终输出拆开保存。 |

目前前端和后端方向一致，不需要推翻 UI。后端需要优先适配前端的 `MemoryContribution` 流程，而不是要求前端马上暴露完整的多模态模型。

## AI 功能分层

后续 AI 能力建议分两层接入：

1. 素材处理层：语音转文字、文字整理、照片理解、记忆提取、图片生成、配音、视频生成。后端称为 `AiTask`。
2. 产品生成层：把已确认材料生成可展示内容。后端称为 `GenerationJob`，当前至少分两类：
   - `memoir_review`：回忆录式回顾，精炼，适合章节、人生故事、纪念册。
   - `moment_note`：随手记，细节更丰富，适合近期记忆、多模态小片段。

当前仓库已有两个云函数入口：

- `cloudfunctions/generateBiography`：适合作为 `memoir_review` 的第一版章节生成入口。
- `cloudfunctions/chatInterview`：适合作为“和 AI 聊聊”的追问生成入口。

API key 应只放在云函数环境变量中，不能写入小程序代码或提交到 GitHub。

当前体验版准备使用 DeepSeek 的 OpenAI 兼容接口：

- `AI_BASE_URL`：`https://api.deepseek.com`
- `AI_MODEL`：`deepseek-v4-flash`
- `AI_API_KEY`：在 DeepSeek 控制台生成后，只填入微信云函数环境变量，不提交到仓库。

如果“追问”想使用更聪明或不同的模型，可以给 `chatInterview` 单独配置：

- `CHAT_AI_BASE_URL`
- `CHAT_AI_MODEL`
- `CHAT_AI_API_KEY`

如果 `CHAT_AI_*` 未配置，`chatInterview` 会尝试复用 `AI_BASE_URL`、`AI_MODEL`、`AI_API_KEY`。

## 当前云开发配置

- 小程序 AppID：`wx6be512f0fe129b62`
- 云开发环境 ID：`cloud1-d0g8c8yg0513a6068`
- 云 AI 开关：`miniprogram/config/runtime.ts` 中的 `CLOUD_AI_ENABLED`
- FastAPI 后端开关：`miniprogram/config/runtime.ts` 中的 `BACKEND_API_ENABLED`
- FastAPI 本地地址：`http://127.0.0.1:8000/api/v1`

当前 `CLOUD_AI_ENABLED = true`。如果云函数未部署或环境变量未配置，页面仍会自动退回本地演示整理，但真机上会多等一次云函数失败返回。

## 已加入的前端适配层

`miniprogram/services/backendApi.ts` 已经把当前前端数据映射到 FastAPI 后端：

- 投稿：`MemoryContribution` → `POST /families/{family_id}/source-records` + `POST /families/{family_id}/memories`
- 老人确认：`reviewStatus` → `PUT /families/{family_id}/memories/{memory_id}`
- 传记生成任务：确认且家庭可见的记忆 → `POST /families/{family_id}/generation-jobs`

当前已经默认开启微信云数据库接管真实数据，页面会显示“数据：微信云端”。如果云端初始化或权限失败，会自动退回本地兜底，并显示“数据：本地兜底”。

默认仍不开启 FastAPI 请求，因为体验版手机无法访问开发者电脑上的 `127.0.0.1`。后续若要使用独立公网 API，再打开 `BACKEND_API_ENABLED`。

## 云数据库集合

请在微信云开发控制台确认存在这些集合：

- `families`
- `family_members`
- `source_records`
- `memories`
- `biography_drafts`
- `generated_artifacts`
- `assets`
- `ai_tasks`

当前黑客松体验版会使用固定家庭 ID `demo-family` 保存演示数据：

- 房间信息保存到 `families`
- 家庭成员保存到 `family_members`
- 用户原始文字投稿保存到 `source_records`
- 可审核、可生成的记忆条目保存到 `memories`
- 当前章节草稿保存到 `biography_drafts`
- 每次生成结果追加保存到 `generated_artifacts`

后续接真实微信身份和家庭邀请后，再把固定 `demo-family` 替换成真实家庭 ID、用户 openid 和权限规则。

体验版试用步骤见 `docs/cloud-demo-test-guide.md`。

## 前端需要注意的改动

- 继续保留 `authorMemberId`、`authorName`、`relation`，不要只保存纯文本。
- 所有提交都要保留 `visibility`，私密内容不能进入公共列表和 AI 输入。
- 生成按钮只允许使用 `reviewStatus === "confirmed"` 且 `visibility === "family"` 的内容。
- 未来接后端后，前端可以先继续使用当前页面结构，只把 `roomStorage.ts` 替换成远程 API/云数据库适配层。

## 后端优先级

1. 先实现和当前前端一致的文字投稿、老人确认、来源追踪、生成章节闭环。
2. 再接入云数据库和云存储，支持多人真机同步。
3. 再扩展语音、图片、视频等多模态素材。
4. 最后把 `memoir_review` 和 `moment_note` 两类生成产品补全。
