# 记忆分段：「接着讲」追加一段，而不是另存一条（问题八转来，问题四定数据）

状态：**方案稿，等用户确认后才写代码。** 分支待定（会开在 feat/story-records 之上）。
背景：问题八 09-15 定了产品方向——只有人、记忆、故事三样东西；记忆有三种来源（随手记、
回忆录·接着讲、每日一问）；「接着讲」改成给**同一条记忆**追加一段，不再新存一条记忆。
数据结构由问题四定，界面由问题八做。

## 核心决定（用户 09-15 确认）

**章节只记「用过这条记忆」，不精确记住用到第几段。** 「有没有新的一段没写进」靠一个轻量
水位标记推出来，不需要给每处引用都记清楚具体段号；改动集中在记忆和章节各自新增一两个字段，
不用把「放进哪章」「移出哪章」这些已有逻辑全部换成按段处理。

## 数据结构

### 记忆 MemoryContribution：新增 `segments`

```
segments?: MemorySegment[]   // 有 segments 时，text 是全部段落按顺序拼接（兼容旧读法）
MemorySegment = {
  id: string;                // 段内唯一，不跨记忆
  text: string;
  createdAt: string;
  source: "note" | "continue" | "daily-question";  // 亲友寄来的另有来源，归问题三
}
```

- 没有 `segments` 字段的旧记忆＝只有一段（迁移时不需要转换，读的时候当一段处理）。
- `text` 字段不删：始终等于 `segments` 按顺序拼接，旧客户端、AI 整理入口、列表摘要都不用改。
- `organizationMode` 按段存在各自的 `segments[].organizationMode`（每段可能是本地整理、也可能是在线 AI）；记忆顶层的 `organizationMode` 保留给旧客户端兼容，读最新一段的值。

### 章节 ManuscriptChapter：新增 `memorySegmentCounts`

```
memorySegmentCounts?: Record<string, number>   // memoryId -> 这一章上次用到这条记忆时，它一共有几段
```

- 只在这一章**用了**这条记忆（在 `memoryIds` 里）时才有对应项。
- 写进（或重新整理）这一章时，把这条记忆当前的段数记下来。
- 「这一章有没有新的一段没写进」＝这条记忆现在的段数 ＞ 记下来的数。
- 一条记忆能在好几章（用户昨天定的规则），每一章各自记自己的水位，互不影响。

### 「有新段没写进」怎么推给故事和每日一问

- 一个故事里，某条记忆「有新段没写进」＝它在这个故事**至少一个**引用它的章节里，段数比水位新；或者它在这个故事的素材里、但还没被任何章节引用（沿用现在的「未写进」概念）。
- 每日一问要问的候选：遍历本账号的故事，找「有新段没写进」的记忆，各选一条问「要写进《XX》吗？」
- 用户选「先不用」：记一笔「这条记忆在这个故事、这个段数时，用户说过先不用」（`story` 或单独一个小记录，故事级别即可），下次再问的条件是段数比这次又多了，不会天天追着同一段问；选「写进」或没理会都不受影响，随时能在故事页里主动补写。

### 写进时怎么更新章节（09-15 修订：先待确认，逐条确认才生效）

> 这一节替换掉最初「默认直接追加原文」的写法。问题八转达用户 09-15 定了更细的流程：
> 写进先进入「待确认」——新增内容淡绿字打框、（以后 AI 整章重新整理时）建议删除的内容
> 灰字打框，逐处点「确认 / 不要」，**全部处理完才生成新版本**，改之前那一版进历史版本。
> 并且已经确认：**用户自己讲的原话接上去，也要点一下确认**（框里不标 AI，AI 新增/建议
> 删除的框里标「AI 生成」/「AI 建议删除」）。

- `ManuscriptChapter` 新增 `pendingRevision?: { createdAt; edits: ChapterEdit[] }`；`ChapterEdit` 有 `id`、`kind`（`insert` / `delete`）、`text`、`source`（`ai` / `memory`）、可选 `memoryId` 和 `memorySegmentCountAtProposal`、`status`（`pending` / `accepted` / `rejected`）。
- 写进（阶段 1，已实现）：只对着水位之后的新段生成一条 `insert`、`source: "memory"` 的待确认修订，**不碰正文和水位**，函数 `proposeMemorySegmentInsert`。
- 逐条确认/不要：`resolvePendingEdit`，只改这一条的状态，不碰文字。
- 全部处理完：`finalizePendingRevision`——接受的新增按提出顺序接到正文末尾，更新这条记忆在这一章的水位和 `memoryIds`；被「不要」的什么都不留下。**确认/不要本身不算手改，不设置 `handEdited`**（只有用户在编辑器里亲手改字才设）。
- 接受了任意一条 `source: "ai"` 的新增，标 `ManuscriptChapter.containsAiText = true`（只会变 true，不会自动退回 false）；和 `generationMode`（整章由谁生成）、`handEdited`（手改过）分开记，因为一章可以同时「含 AI 文字」又「被手改过」。
- 标识文字：`chapterAiLabel(chapter)` 给界面小标签用——含 AI 文字时「文字 AI 生成」，再加上手改过时「文字 AI 生成 · 已由你修改」；`chapterAiExportPrefix(chapter)` 给复制/导出用，同样的文字套上书名号变成「【文字 AI 生成】」「【文字 AI 生成 · 已由你修改】」，问题七要求的三条落地在这里。没有 AI 文字时两个函数都返回空字符串，不加标识。
- **阶段 2（还没做）：AI 整章重新整理**——用户点「请 AI 重新整理这一章」时，需要把 AI 改写的结果和原文做差异对比，产生若干 `insert`（`source: "ai"`）和 `delete`（`source: "ai"`）修订，逐条确认。这需要一个文字差异算法，比阶段 1 复杂得多，本方案先不做，等阶段 1（记忆写进）跑通、问题八界面接线完之后再单独定。

### 待确认状态怎么持久化

- `pendingRevision` 存在正在编辑的那个版本（`ManuscriptRevision`，`kind: "draft"`）里，和现有版本走同一套保存机制；因为 `currentManuscript()` 只看最新一条，它自然会成为「当前」状态，页面能看到待确认的框。
- 全部确认完，`finalizePendingRevision` 产出的章节正常存成一条 `kind: "version"` 的新版本，成为新的「当前」；中间那条 `kind: "draft"` 仍在历史里，不删除、不算作正式版本。
- 中途退出页面：`pendingRevision` 已经落在这一版里，下次回来读到的还是同一条，能接着确认（问题八要求的「建议保留」）。
- `validateChapters` 已经加了对 `pendingRevision`/`containsAiText` 的轻量校验（条数、单条文字长度上限），待确认的文字暂不计入整本书 20000 字的限制，接受后才计入。

### 发到电脑端快照

- 建议带上 `segments` 明细，不只是合并后的 `text`：问题七要求的 AIGC 标识要按段/按来源判断，只有整段合并文本做不到。这一条会和问题一·小程序端另外对齐字段。
- 快照文字建议直接调用 `chapterAiExportPrefix`，不要自己再拼一遍「【...】」前缀。

## 迁移与回退

- 旧记忆没有 `segments`：读的时候当作「只有一段」，`text` 不变；旧章节没有 `memorySegmentCounts`：当作「水位是 0」，即所有段都算新的（保守，宁可多问一次「要不要写进」，不会漏）。
- 不改任何现有记忆或历史版本；新字段都是可选的，旧客户端忽略即可。

## 进度

- **已实现**（services/chapters.ts、domain/biography.ts）：`MemorySegment`/`segments`、
  `appendMemorySegment`；`ChapterEdit`/`pendingRevision`/`containsAiText`；
  `proposeMemorySegmentInsert`/`resolvePendingEdit`/`pendingRevisionResolved`/
  `pendingEditCount`/`finalizePendingRevision`；`chapterAiLabel`/`chapterAiExportPrefix`；
  `shouldAskToWriteIn`/`declineStorySegment`（services/storyRecords.ts）。都只是纯函数
  和类型，没有接线到任何页面，`interview.ts`/`book.ts` 由问题八接线。
- **还没做**：阶段 2（AI 整章重新整理产出 delete/insert 差异）；真正的「先不用」持久化
  （现在只有 `declineStorySegment` 这个纯函数，写进 `Story.declinedSegments` 需要等
  `stories` 集合在阶段 B 真正开始读写）。
