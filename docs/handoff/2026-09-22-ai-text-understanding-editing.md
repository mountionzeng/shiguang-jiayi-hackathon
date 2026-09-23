# 拾光家忆 AI 文字理解与编辑交接

日期：2026-09-22
目标仓库：`/Users/yuandai/Documents/New project/shiguang-jiayi-hackathon`
基准分支：`main` = `ec42ffd`（**不要用** `chore/migrate-enterprise-miniprogram`，它落后 main 108 个提交）
参考仓库：`/Users/yuandai/Documents/New project/drinking-time-local`（同一作者的另一个产品，记忆机制已成熟，可照抄）

本文所有代码位置都在 2026-09-22 核对过，行号以 `main@ec42ffd` 为准。

## 四件事，按建议顺序

1. 修语音输入重复（纯前端，范围最小，先做）
2. 解除「新建故事书被旧数据迁移挡住」
3. 给小忆接上"记住用户说过什么"的能力（照抄 drinking-time-local）
4. 文字模型切到腾讯云 TokenHub 的 DeepSeek V4

## 一、语音输入文字重复

### 现象

用户用**微信键盘自带的语音输入**（不涉及任何语音 API）在采访页说话，同一句话被累积追加多次，
每次比上次长一段。真机截图里已发送的气泡内容形如：

> 今天阳光很好。今天阳光很好准备去散步。今天阳光很好准备去散步……（合成示例）

### 根因（已核对）

`miniprogram/pages/interview/interview.wxml` 第 135–148 行，主输入框是**受控 textarea**：

```html
<textarea
  class="input-field"
  value="{{inputText}}"          <!-- ← 受控绑定 -->
  maxlength="{{-1}}"
  auto-height
  bindinput="onInput"
  ...
></textarea>
```

`miniprogram/pages/interview/interview.ts` 第 360–363 行，每次输入都把值回写：

```ts
onInput(event: { detail: { value: string } }) {
  const inputText = event.detail.value;
  this.setData({ inputText });      // ← 回写同一个受控 value
  ...
}
```

微信键盘语音提交时会连续触发 `input` 事件，`setData` 的回写与输入法自身维护的内容合并，
就产生累积重复。`send()`（第 377 行起）只是 `this.data.inputText.trim()`，
它拿到的已经是重复后的文本，所以重复会原样进入 `answers` 和已发送气泡——
**修输入阶段即可，不用改发送逻辑**。

### 修复方向

标准做法是让 textarea 非受控：去掉 `value="{{inputText}}"`，只用 `bindinput` 收值；
确实需要清空时（`send()` 里）改用受控 + `setData` 一次性重置，或引入 `_skipEcho` 标记
避免 input 事件期间回写。**不要在 `onInput` 里无条件 `setData` 同名字段。**

采访页还有 4 个输入框：`onTitleInput`、`onDraftInput`、`onImportCaptionInput`、`onStoryTitleInput`。
**它们是否同样受控绑定本次没有逐个核对**，请一并检查，同一个坑不要只修一处。

### 验收

真机用微信键盘语音连说三段话，输入框与发送后的气泡都不得出现重复；
键盘收起/弹起、中途删改、超长文本都要试。加一个回归测试覆盖"连续 input 事件不累积"。

## 二、新建故事书被旧数据迁移挡住

### 现象

用户在「人生之书」点「新的故事」，填名字后提交，弹出提示：

> 故事书迁移尚未完成，请先打开书架

而书架本身显示「0 个故事」。用户**只是想新建一本和旧故事毫无关系的书**，却被旧数据迁移拦住。

### 根因（已核对）

`miniprogram/domain/storyBookCore.js` 第 79 行，在 `apply()` 的第一行：

```js
function apply(state, command, now = new Date().toISOString()) {
  if (!state.storyMigration || state.storyMigration.status !== 'active')
    fail('故事书迁移尚未完成，请先打开书架');
```

它拦下**所有**命令，包括 `command.action === 'create'`。

`miniprogram/services/storyBooks.ts`：

```ts
24: export async function ensureStoryBooks(): Promise<FamilyRoomState> { ... }
48: const next = core.apply(state, command); saveRoomState(next); return next;
50: export async function createStoryBook(input: {...}) {
51:   await ensureStoryBooks();      // ← 先要迁移，再允许创建
```

而 `storyMigration.status` 只有 `migrate()` 跑过才会变成 `active`，
`cloudfunctions/storyBooks/index.js` 第 21–23 行：

```js
const migrationFamilyIds = String(process.env.STORY_BOOKS_MIGRATION_FAMILY_IDS || '')
  .split(',').map(v => v.trim()).filter(Boolean);
const dispatch = createStoryService(repo, {
  migrationReady: process.env.STORY_BOOKS_MIGRATION_READY === 'true',
  migrationFamilyIds, ...
```

企业云环境（`cloud1-d5ghzk30ve609f544`）**没有配这两个环境变量**，
于是 `migrate()` 永不运行 → `status` 永不为 `active` → 创建永远被拦。
「0 个故事」和「创建被拦」是**同一个根因**，不是两个 bug。

### 修复方向

**新建一本空书不应该依赖旧数据迁移。** 建议把 `apply()` 的前置检查按命令分级：

- `create` 且不引用任何旧记忆（`memoryIds` 为空）→ 不要求 `storyMigration.status === 'active'`
- 涉及旧书稿章节、旧配图、旧记忆归属的命令 → 保留原检查

注意 `apply()` 里紧随其后的幂等机制（`requestId` + `storyOperations` 指纹比对，第 80–86 行）
必须保留，不要为了放行 `create` 把幂等一起绕过。

另一条并行动作：企业环境补配 `STORY_BOOKS_MIGRATION_READY=true` 和
`STORY_BOOKS_MIGRATION_FAMILY_IDS=<用户自己的 familyId>`（白名单限定范围，不要一次对所有人放开）。
这属于云端配置，需用户在控制台操作，且要先确认企业库里有没有旧数据——
详见 `docs/handoff/2026-09-22-old-data-migration-to-enterprise.md`。

### 顺带要改的命名

`pages/stories` 的措辞把"集合"和"单本"混用了，用户明确反对：

- 顶部导航与标题：「人生之书」
- 副标题：「你所有的故事 / 每个故事就是一本独立的书」
- 新建页标题：「新建一本人生之书」

按用户的产品定义，**「人生之书」= 这个人全部书的集合**，不是单本的名字。
新建单本要换措辞（例如「新建一个故事」／「新建一本故事书」），
并且**后端字段语义也要跟着一致**，不要只改文案。

## 三、AI 原话/撤回/修改历史 —— 已经做完了，不要重做

这一节是**现状说明**，不是待办。另一个会话已经完整实现并提交：
分支 `claude/goofy-bell-dd947d`，commit **`421f1b9`**，36 个文件 / 980 行插入，
工作树在 `.claude/worktrees/goofy-bell-dd947d`（基于 `ec42ffd`）。

### 已实现的领域模型（`miniprogram/domain/biography.ts`）

```ts
export type MemoryAiRevisionKind = "spoken" | "ai" | "manual" | "restore";
export interface MemoryAiRevision { kind: MemoryAiRevisionKind; ... }
// MemoryContribution 新增：aiRevisions?: MemoryAiRevision[]
```

不变式：**有 `aiRevisions` 时首条恒为 `spoken` 原话**，`appendAiRevision()` 会在调用方忘记时自动补上。

配套函数：`memoryAiRevisions()`、`memoryOriginalSpokenText()`、`memoryAiLabel()`、
`appendAiRevision()`、`revertMemoryToSpoken()`。

### 已接线的位置

- `pages/interview/interview.ts`：462 行写入 `spoken` 原话，495 行记 `ai` 整理，
  866 行记 `manual` 人工修改，504/535 行显示标签
- `pages/archive/archive.ts`：182 行取原话，224 行撤回，292 行记人工修改，
  299 行判断能否撤回；`archive.wxml` 有「原话」「撤回到原话」入口
- `pages/book`、`recall`、`room`、`stories`：都已显示 `aiLabel`
- 新增 `cloudfunctions/recordAiConsent/`（`index.js` + `aiGuard.js` + `package.json`），
  把 AI 授权落到服务端；`services/aiConsent.ts` 同步改造
- `chatInterview`、`generateBiography`、`organizeMemory` 三个 `aiGuard.js` 都动过

### 测试与缺口

`tests/biography-ai-revisions.test.ts` 8 个用例全通过，含一条重要的失败闭合测试：
「缓存里的 aiRevisions 畸形时退化为空历史，绝不伪造标签」。

**缺口：`interview` 和 `archive` 的接线层没有回归测试**，目前只有领域层被覆盖。
接手的人第一件事是补这两处的测试，然后跑 `npm run check` 确认 282 项基线没退化。
云函数改动（`recordAiConsent`、三个 `aiGuard`）涉及权限，**必须双微信账号真机验收**，
单元测试不能代替。

## 四、让小忆记住用户说过什么（照抄 drinking-time-local）

### 用户的原话

> 这个问题他太蠢了，他好像没有学习我之前的文字

**这个抱怨是准确的，不是错觉。** `cloudfunctions/organizeMemory/index.js` 只接收
`event.transcript`，被 `validateTranscript()` 截到**最后 8 句、每句 500 字**，
完全不读该账号已有的任何记忆。`chatInterview` 同样如此。所以小忆确实没有任何历史上下文。

这是设计缺口，不是配置问题，也不是换模型能解决的。

### 参考实现：`drinking-time-local` 的三段式

同一作者的另一个产品已经把这件事做透了，**建议整段照抄结构**，不要另发明。

#### 第一段：抽取 —— `server/services/personalMemoryExtraction.ts`

从单条经历判断能否形成「一条关于这个人的理解」。`SYSTEM_PROMPT` 在第 258 行，
那套硬规则值得整段搬过来：

- 六种 `statementType`：`direct_statement` / `question` / `quotation` /
  `hypothesis` / `project_scoped_instruction` / `inferred_behavior`
- **`question` / `quotation` / `hypothesis` 三类永远不产生理解**（提问不是陈述，
  引用别人的话不是用户自己的话，假设句不是事实）
- **允许输出空数组**——「大多数经历本来就不该形成理解，不要为了有输出而牵强附会」
- 涉及健康、心理、人际、隐私要格外克制，不下诊断，不断言因果
- 每条理解 ≤ 60 汉字，平实第三人称，不引用原话，不提具体日期
- 新证据要判断是**强化**既有理解、**修正/推翻**它，还是**全新**理解（`matchLineage` + `isContradiction`）
- 只输出 JSON；**对模型返回的字段一律不信任**，不认识的值丢掉整条而不是猜一个

#### 第二段：选材 —— `server/services/personalMemorySelection.ts`

决定这一次生成能用哪些理解：

- 候选池上限 20（`CANDIDATE_POOL_LIMIT`）
- 7 天冷却期（`COOLDOWN_DAYS`），回看窗口 30 天——近期提过的不重复主动提及
- 排序：`updatedAt` 降序，其次 `confidence` 降序
- 分类配额 `maxPerCategory`，避免某一类刷满
- **排除 `projectScoped`** 的理解。源码注释说明了原因：把某个创作项目里角色的偏好
  写进账号主人的日常生活来信，「会读起来像认错了人」
- 算法版本号 `PERSONAL_MEMORY_SELECTOR_VERSION = "u6-v1"` 写进产物，日后能看出用的哪一版

**隐私过滤放在仓储装配层，不在纯函数里。** 这个设计值得照抄：
`allowProactiveMention === false` 的理解在进入候选类型之前就被过滤掉，
纯函数的候选类型**故意不携带这个字段**，逼着以后任何新调用方都必须先过这层硬默认值，
不能绕过装配层直接拼一份候选喂给纯函数。

#### 第三段：进提示词 —— `shared/personalMemory.ts:1445`

最终形态只有五个字段：

```ts
export type PersonalMemoryPromptContextItem = {
  category: PersonalMemoryInsightCategory;
  origin: PersonalMemoryInsightOrigin;   // ← 关键
  text: string;
  projectScoped: boolean;
  earliestEvidenceOn: string | null;
};
```

消费处在 `server/services/emotionDailyReference302.ts:639`，`text` 被 `cleanText(item.text, 200)`
截断。`origin` 字段的作用，源码注释写得很清楚：供提示词区分
「用户自己说的/纠正过的」与「系统从行为推断的」——**后者置信度更低，不得被写成用户认领过的事实**。

**这就是你说的「必要的背景整理」**：不是把历史原文全塞进去，而是把已提炼、经选材、
带来源标记的少量条目喂进去。

### 落到拾光家忆要做的事

1. 新增集合存 insight 与 evidence，**同步更新 `deploy/wechat-cloud.manifest.json`**
   （它已登记 43 个集合，必须保持一致）
2. 记忆保存后**异步**触发抽取，不要卡住用户的保存操作
3. `organizeMemory` / `chatInterview` 调模型前，按选材规则取少量理解拼进提示词
4. 必须有「忘记」入口。参考 `shared/personalMemory.ts:364` 的
   `PersonalMemorySuppressionRecord`——忘记 tombstone 绑定
   `userId + lineageKey + 被禁止的证据`，永久压制
5. 抽取与选材**先写纯函数 + 单元测试**，再接仓储层。照抄那边的分层，别把算法写进云函数里

**隐私底线**：不允许主动提及的理解必须在**进候选池之前**就被过滤掉，
不能靠在提示词里嘱咐模型「别说这个」。

## 五、文字模型切到腾讯云 TokenHub 的 DeepSeek V4

### 好消息：不用改代码

三个 AI 云函数（`organizeMemory`、`chatInterview`、`generateBiography`）已经是标准
OpenAI Chat Completions 格式。以 `cloudfunctions/organizeMemory/index.js` 为例：

```js
const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const apiKey = process.env.ORGANIZE_AI_API_KEY || process.env.CHAT_AI_API_KEY || process.env.AI_API_KEY;
const model  = process.env.ORGANIZE_AI_MODEL   || process.env.CHAT_AI_MODEL   || process.env.AI_MODEL;
const baseUrl = (process.env.ORGANIZE_AI_BASE_URL || ... || DEFAULT_BASE_URL).replace(/\/$/, "");

await fetch(`${baseUrl}/chat/completions`, {
  method: "POST",
  headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
  body: JSON.stringify({ model, messages: [...] }),
});
```

腾讯云大模型服务平台 **TokenHub 支持 OpenAI Chat Completions 协议**，
所以只改云函数环境变量即可：

```
ORGANIZE_AI_BASE_URL=<TokenHub 的 OpenAI 兼容端点>
ORGANIZE_AI_API_KEY=<TokenHub 密钥>
ORGANIZE_AI_MODEL=<DeepSeek V4 的模型名>
```

`chatInterview` 用 `CHAT_AI_*`，`generateBiography` 用对应前缀，同样处理。

参考文档：
- [TokenHub DeepSeek 调用指南](https://cloud.tencent.com/document/product/1823/132248)
- [知识引擎原子能力 DeepSeek API](https://cloud.tencent.com/document/api/1772/115963)
  —— **不推荐**，它走腾讯云自有签名协议，要重写请求签名

### 五个注意事项

1. **模型名与计费档位要在控制台确认。** 搜索结果显示 V4 有 Pro 等分档
   （"2026 年 9 月 14 日之后继续提供 DeepSeek V4 Pro 的 API 调用服务"），
   但本次排查**无法确认该账号能用哪些档位、单价多少**。
2. **别把 provider 硬编码。** 参考 `drinking-time-local` 的
   `personalizeEmotionDailyReference302()`：它解析出 `provider.chatCompletionsUrl` /
   `provider.apiKey` / `provider.model`，带回退链（`302-deepseek` / `openai-next` /
   `local-template`）和失败降级。照抄这个形状。
3. **超时要重测。** `organizeMemory` 现在是 28 秒 `AbortController`，
   而 manifest 里云函数上限是 10 或 20 秒。推理型模型可能更慢，换完必须实测。
4. **切换前做一次受控真实请求验证**，带稳定 request ID。
   runbook 明确写了这**可能产生费用，执行前需要用户明确授权**。
5. **发布闸门。** main 上 `CLOUD_AI_RELEASE_READY = false`，
   `app.ts:51` 把 `aiReady = CLOUD_AI_ENABLED && CLOUD_AI_RELEASE_READY`。
   验证时要显式开闸，但**绝不要把 `true` 提交进仓库**。

## 任务拆分建议

这几件事耦合度低，可以分给不同会话并行做。优先级从上到下：

| # | 任务 | 范围 | 说明 |
|---|---|---|---|
| 1 | 补 AI 版本闭环的接线测试 | `tests/` | **最紧急**。代码已落地（`421f1b9`），只差 interview/archive 接线层的回归测试 |
| 2 | 修语音输入重复 | `interview.wxml` + `interview.ts` | 纯前端，范围最小，可独立验证 |
| 3 | 解除新建拦截 + 改「人生之书」命名 | `storyBookCore.js` + `storyBooks.ts` + `pages/stories` | 含前后端语义一致 |
| 4 | 记忆机制（照抄 personalMemory 三段式） | 新增集合 + 纯函数 + 云函数接线 | **工作量最大**，建议独立会话 |
| 5 | 切 DeepSeek V4 | 云函数环境变量 | 简单，但需要你在腾讯云控制台操作并授权费用 |

## 共同约束（每个接手的会话都要遵守）

1. **基准分支是 `main` = `ec42ffd`。** 不要用 `chore/migrate-enterprise-miniprogram`
   （落后 108 个提交，没有独立故事书）。
2. **不要碰 `/Users/yuandai/Documents/ChatGPT/DK—小程序`** 里的微信资质、算法备案和审核材料，
   另一个任务在处理。
3. **不要 reset / checkout / 清理任何工作树的未提交改动。**
   `.worktrees/chore/migrate-enterprise-miniprogram-main` 有 34 处未提交改动，
   已逐文件哈希核对、备份在 `salvage/2026-09-21-enterprise-worktree-uncommitted`
   （该分支**未并入 main**）。
4. **每批改动后跑 `npm run check`**（`tsc --noEmit` + `tsx --test`），
   282 项基线必须全绿，不许降低。
5. **不要破坏现有产品语义**：新故事默认归讲述者所有、个人阅读名单与「涉及的人」分开、
   家庭投稿先 pending、书稿版本历史、照片顺序、电脑端单向故事传递。
   这些都有回归测试，**改前先读测试**。
6. **涉及云函数或云权限的改动，单元测试不能代替双微信账号真机验收。**
7. **两个危险维护函数有护栏，不要绕过**：`resetCurrentUserRoom`
   （`PROTECTED_FAMILY_IDS` + `confirm="RESET_MY_ROOM"` + `ALLOW_ROOM_RESET=yes`，默认只预演）、
   `deleteDemoFamilyOnce`（固定确认语 + ≥24 位 operator token + `timingSafeEqual`）。
   这个项目 2026 年 9 月发生过真实房间被清空的事故。

## 相关文档

- `docs/handoff/2026-09-22-old-data-migration-to-enterprise.md` —— 旧库数据迁移到企业库
  （含 `_openid` 系统字段这个阻塞项）
- `docs/wechat-account-migration-runbook.md` —— 换账号迁移手册
- `docs/handoff/2026-09-13-drinking-time-account-import.md` —— 跨系统单向导入的既有范式
