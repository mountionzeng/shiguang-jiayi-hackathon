---
title: "fix: 对话智能第二轮——过硬门禁，并修好用户看得懂的降级提示"
type: fix
status: active
date: 2026-09-27
origin: docs/brainstorms/2026-09-25-conversation-intelligence-requirements.md
---

# 第二轮：代码到位了，门禁还没过

## Summary

`codex/conversation-intelligence-20260927` 分支（最新功能提交 `a760eaf`）已经实现了
需求文档 R4–R13 的主体，质量明显在线：截图里那句箴言「越是迷茫的时候，越是要往远处看」
现在得到的是「你说的『远』，也许不是某个具体地方，而是不让眼前这点占据全部视线。
对你来说，往远处看更像是去看长远想做的事，还是把眼下的事放小一点看？」——
不问事实、直接问意义，正是需求要的。

**但这一轮的产出还不能算完成，原因不是功能缺失，而是硬门禁没过。**
需求文档把「语义相关率 ≥ 90%」和「箴言类 0 条追问事实要素」列为硬门禁，
且明确写了「测试通过数不算成功标准」。当前状态是：

| 门禁 | 状态 |
|---|---|
| 20 条真实调用 | **已完成**，20/20 返回成功 |
| 语义相关率 ≥ 90% | **未通过** —— Codex 自判 20/20，但需求要求人工评审 |
| 箴言类 0 条追问事实要素 | **前 5 条通过**，但第 17 条追问了地点与活动，不符其 `noFactQuestions` 约束 |
| 第 17 条修复后复测 | **未通过** —— 两次均被腾讯云内容检查服务阻断 |
| 真机验证 | **未做** —— 只在微信开发者工具模拟器完成 |
| 3 个不同风格账号的倾向准确性 | **未做** |
| 双账号 / 两台设备隔离 | **未做**（五个集合的客户端读写拒绝已验，不等于双账号验收） |
| 页面打开率与确认/纠正点击率 | **未开始观察** |

本计划只做两件事：**把这些门禁逐项过掉**，以及**修好 R1**（降级提示对目标用户无效）。
不新增对话能力。

基线：`codex/conversation-intelligence-20260927`，993 项测试通过、0 失败 0 跳过。
本计划未做真机验证，未重新评审那 20 条回复。

> **执行环境**
> - 代码在 `.worktrees/codex/conversation-intelligence-20260927`，分支
>   `codex/conversation-intelligence-20260927`，最新功能提交 `a760eaf`。
> - **不要从 main 重新开始。** main 已前进到 `f805c15`（封面相关），
>   不含本轮对话智能改动；这一轮的成果只在上述分支，未推送、未合入。
> - 仓库根目录 checkout 停在 `chore/migrate-enterprise-miniprogram`，与两者都不同。
> - 已部署：chatInterview `a760eaf`、organizeMemory `01dd7a2`、personalMemory `26a0fd0`。
>   客户端 AI 发布开关仍为 `false`，仅隔离预览开启。个人记忆云端开关已恢复关闭。

## 上一轮的评价（先说清哪些不要重做）

实现质量高于需求要求的三处，**不要在本轮推翻**：

- **本地兜底已经不是维度轮询了。** `interviewService` 的回退换成三句贴着原话的通用问法
  （「你刚才这句话里，最想留下来的是哪个意思？」），并识别「暂停／只记录」意图。
  原需求只要求「可区分」，实现顺手把兜底本身也修好了。
- **`MIN_TENDENCY_SOURCES = 3` + `MIN_TENDENCY_CONFIDENCE = 0.75`，且
  `distinctTellingCount` 取 `min(不同 memoryId 数, 不同 fingerprint 数)`。**
  同一段话反复保存凑不出三条证据。原需求 R9 只写了「不得由单次对话下结论」，没给阈值。
- **模型不能给自己的猜测盖用户认可的章。** `personalMemoryCore.js` 的
  `origin: conversationTendency || ... ? 'inferred' : ...` 配注释
  「A model cannot confer the user's confirmation on its own tendency guess」——
  这是原需求 R9 没堵住的洞。

倾向的接线方式也正确：`formatContext` 写明「只有 `conversationTendency=true` 的项目
可以影响提问切入角度，且仅在当前发言支持该角度时使用；每个问题仍须贴着用户最新一句话，
**不得直接说出或给用户贴这些倾向标签**」。R8 最容易做歪的两种方式都被堵住了。

`confirm`/`correct` 也真的落到了数据层：`confirm` 把 `origin` 改为 `user_stated`
并记 `confirmedAt`；`correct` 新建一条 `kind: 'user_correction'` 证据、
把 `origin` 改为 `user_corrected`，空纠正则转为 `status: 'corrected'` 并停止主动提及。

---

## Problem Frame

需求文档写了「不作为成功标准的东西」，其中第一条是**测试通过数**，
因为前两轮都出现过「测试全绿、产品没变」。这一轮没有重犯那个错误 ——
Codex 的交接第一句就写「最终版线上复测被内容检查服务阻断；尚未正式发布或通过全部产品验收」，
并且主动标出第 17 条不合格、明确写「Codex 判断不能代替人工硬门禁」。**这份自我报告是可信的。**

所以本轮的问题不是「做得不对」，而是**验收链条断在几个只能由人完成的环节上**：

1. **20 条语义相关性需要人评。** Codex 自判 20/20，但自评不能当门禁 —— 这是需求写明的。
2. **第 17 条是唯一明确不合格的样例**，修复后两次复测都被内容检查服务阻断，
   目前没有成功的线上复测回复。
3. **真机、双账号、三种风格账号全部未做**，而倾向准确性只能靠后者验证。
4. **R1 的实现字面满足、实际无效** ——「模板追问」对不用电脑的长辈没有意义。
   这是原需求措辞太松导致的，已在需求文档中修订判据。

---

## Requirements

| 来源 | 实施覆盖 |
| --- | --- |
| 需求 R1（2026-09-27 修订判据：念给长辈听能懂） | U1 |
| 需求 Success Criteria 1（语义相关率 ≥ 90%，人工评审） | U2 |
| 需求 Success Criteria 2（箴言类 0 条追问事实要素）+ 第 17 条不合格 | U3 |
| 需求 Success Criteria 3（3 个风格账号的倾向准确性） | U4 |
| 需求 R16 + AE8（双账号、两台设备隔离） | U5 |
| 需求 Success Criteria 4（页面打开率与点击率） | U6 |
| AGENTS.md（二维码交付前的整体流程真机验收） | U5 |

---

## Scope Boundaries

### 本轮不做

- **不新增对话能力。** R4–R13 已实现，本轮只过门禁。
- **不推翻上一轮高于要求的三处实现**（本地兜底、倾向阈值、inferred 强制标记）。
- **不改倾向的接线方式。** `formatContext` 那段约束是对的。
- **不动阈值 3 / 0.75**，除非 U4 的真实账号验证给出反证。
  改阈值必须有数据支撑，不能凭手感调。
- **不绕过内容检查。** 第 17 条复测被阻断是外部服务问题，
  等服务恢复后复测；**不得为了跑通而临时关闭或跳过检查**。
- **不开启 `CLOUD_AI_RELEASE_READY` 并提交**。只在隔离预览副本开启。
- **不开启 `PERSONAL_MEMORY_ENABLED`** 直到 U4、U5 通过。
- **不合入 main、不交付新二维码**，直到全部门禁过完。

### 明显不属于这个产品

- 用 AI 评审 AI 的输出来代替人工门禁。需求已明确禁止。
- 为了让指标好看而挑样本。20 条是固定集合，不许换。

### 留给后续

- 「主动发现缺口」（你三次提到那口灶台，但没说它后来去哪了）。
  需求已写明这要等第 3 层跑准。
- 跨故事主题发现、家族叙事组织、家人分歧的呈现界面。

---

## Implementation Units

U1 可以立刻做。U2–U6 是验收，其中多数**只有用户能做** —— Agent 的职责是把条件准备好、
把结果如实记下来，不是替用户判断。

### U1. 把降级提示改成用户能懂的话

**Goal:** 一位不用电脑的长辈看到标签，能明白「现在小忆不太灵」。

**Requirements:** R1（2026-09-27 修订判据）。

**Dependencies:** 无。

**Files:** `miniprogram/domain/interview.ts:26`（`FOLLOW_UP_LABEL`）；
`miniprogram/pages/interview/interview.ts:433`（含 `moderation-quota-exhausted` 分支）；
测试 `tests/interview-service.test.ts`、`tests/page-handlers.test.ts`。

**Approach:** 把「模板追问」换成用户语言。建议方向：把状态说成小忆的状态
（「小忆今天有点迟钝」），或说明后果而不解释原因（「小忆暂时没连上，先按常问的问题陪你说」）。
模型正常那侧的「文字 AI 生成」也偏工程，可一并改，**但两侧必须仍然可区分**。
额度用尽那条分支（`moderation-quota-exhausted`）现在拼接成
「模板追问 · 今日内容检查额度已用完」，同样要改 —— 用户不需要知道什么是内容检查额度。

**Test scenarios:** 三种状态（模型正常、模型不可用、额度用尽）标签互不相同且都不含
「模板」「本地」「降级」「AI」「模型」「云端」「额度」这类词；
现有 `generationMode` 断言继续通过。

**Verification:** 念给一位长辈听（门禁，见下节）。

### U2. 人工评审那 20 条回复

**Goal:** 把「语义相关率 ≥ 90%」从 Codex 自判变成人工结论。

**Requirements:** Success Criteria 1。

**Dependencies:** 无（20 条结果已在仓库里）。

**Files:** 更新 `docs/acceptance/2026-09-27-conversation-intelligence-results.md`
的评审结论；不改代码。

**Approach:** 逐条看 `2026-09-27-conversation-intelligence-live-model-results.md`。
每条已附「评审锚点」（例如第 01 条是「迷茫／往远处看对自己的意义」），
判断标准是需求 R4 的原句：**能否从原话里指出这个问题所回应的那个词或那个意思。**
不相关的记为不通过，写明原因。**Agent 不要代替用户下这个结论。**

**Test scenarios:** 不适用。

**Verification:** ≥ 18/20 相关；前 5 条箴言/感想 0 条追问事实要素。

### U3. 第 17 条：复测并确认修好

**Goal:** 第 17 条不再追问地点与活动，且有成功的线上回复作为证据。

**Requirements:** Success Criteria 2。

**Dependencies:** 腾讯云内容检查服务恢复。**这是外部依赖，不可控。**

**Files:** 可能需要继续收紧 `cloudfunctions/chatInterview/index.js` 的
`FOLLOW_UP_RULES` 第 5 条；测试 `tests/cloud-function.test.js`。

**Approach:** 按 `followup-optimization.md` 的原计划复测 10 条固定输入。
注意首轮的教训：三次都不再问「待在哪儿、做什么」了，但转而问「周围动静」「身体哪里松了」
——**从事实盘问变成了感官扫描，仍然不是沿着意义推进。**
第三次的回复（「这份不赶的感觉，对你最要紧的是什么？」）是正确方向。
收紧时以它为样板，不要再加新的提问模板。

**Test scenarios:** 提示约束回归（已有，修改前失败、修改后通过）；
**但这类测试只能检查提示词文本，不能代替语义验收** —— 这点上一轮已写明。

**Verification:** 10 条中取得真实回复，第 17 条对应样例不含地点/活动/感官扫描式追问。

### U4. 三个不同风格的测试账号验证倾向准确性

**Goal:** 确认倾向学得准，以及学错时用户能纠正。

**Requirements:** Success Criteria 3、AE4、AE5、AE7。

**Dependencies:** `PERSONAL_MEMORY_ENABLED` 需在隔离环境临时开启，用完恢复关闭
（上一轮已按此做法，照办）。

**Files:** 新增验收记录；不改代码，除非发现阈值问题。

**Approach:** 三个账号分别用三种风格讲述：偏关系（总提到身边人）、
偏自我感受（只讲自己的想法）、偏事物场景（讲物件与地点）。
每个账号至少四次独立讲述（阈值是 3 条不同证据，上一轮实测是第 4 条才学出来）。
观察三件事：倾向是否与人工判断一致、依据是否可追溯到具体日期与原话、
以及点「不对」之后下一个问题是否真的换了角度。
**AE7 同样要验**：证据不足时不显示任何暂定理解，不许为了展示能力而给低置信度猜测。

**Test scenarios:** 已有单账号链路验收可作参考，但不能代替三风格验证。

**Verification:** 三个账号的倾向均与人工判断一致；纠正后角度改变；证据不足时不猜。

### U5. 双账号、两台设备、真机

**Goal:** 满足 AGENTS.md 的整体流程验收，并确认隔离。

**Requirements:** R16、AE8、AE1（真机复测基线原句）。

**Dependencies:** U1（标签改完再验，否则要验两遍）、U3。

**Files:** 新增验收记录。

**Approach:** 两个微信账号、至少两台设备。验：A 账号的理解 B 看不到、
B 无法纠正或忘记 A 的理解、忘记后不复活。同时在**真实手机**上复测截图那句原话
（「越是迷茫的时候，越是要往远处看。」）—— 目前只在模拟器验过。
按 AGENTS.md：用可识别的虚构测试文字，测完通过正常编辑流程清理，重新打开核对清理结果。

**Test scenarios:** 不适用（真机）。

**Verification:** 隔离全部成立；真机追问与原话相关；清理后核对无残留。

### U6. 开始观察页面打开率与点击率

**Goal:** 验证需求里那个诚实的假设 —— 用户是否愿意从记录走向发现。

**Requirements:** Success Criteria 4。

**Dependencies:** U1–U5 全部通过并正式开启后才有意义。

**Files:** 无代码改动（若现有埋点不足，另议）。

**Approach:** 观察「小忆记住的事」页面打开率、「说得对／不对」点击率。
**需求已写明：如果没人打开这个页面，第 3 层的可见性价值不成立。**
这是需要诚实面对的结果，不要因为功能做完了就假定它有价值。

**Test scenarios:** 不适用。

**Verification:** 有连续数据可看；出现「无人打开」时如实报告。

---

## Verification & Operational Notes

### 门禁清单（全部为「人做」，不能用测试数代替）

| # | 门禁 | 通过条件 | 谁做 |
|---|---|---|---|
| 1 | R1 标签 | 念给一位不用电脑的长辈，他能说出「小忆不太灵」的意思 | 用户 |
| 2 | 语义相关率 | 20 条人工评审 ≥ 18 条相关 | 用户 |
| 3 | 箴言类不问事实 | 5 条箴言/感想 0 条追问事实要素 | 用户 |
| 4 | 第 17 条 | 内容检查恢复后复测通过，且不再问地点/活动 | Agent + 用户评审 |
| 5 | 倾向准确性 | 3 个风格账号，倾向与人工判断一致 | 用户 |
| 6 | 隔离 | 双账号两设备，读取/纠正/忘记互不可见 | 用户 |
| 7 | 真机 | 真实手机复测基线原句 | 用户 |

**门禁 1、2、3、5、6、7 只有用户能做。** Agent 能做的是 U3 的复测、U4/U5 的
测试账号与脚本准备、以及把结果记录下来。**不要用「993 项测试通过」回复这些门禁。**

### 成本与额度

- 每次真实追问调用走 TokenHub `deepseek/deepseek-flash`，
  延迟中位数 7.08 秒、最长 12.52 秒（实测）。
- `computeUsage` 全部返回空值，**费用无法从响应确认** ——
  U3 的 10 条复测前先问用户额度授权，不要默认可以随便跑。
- 2026-09-23 记录过该模型在短素材上会扩写重复；追问是短输出，注意同类问题。

### 部署与回退

- 本轮只改文案（U1）与验收记录，不改数据结构，不需要迁移。
- U1 改完需重新部署客户端隔离预览；云函数不受影响。
- 若某条门禁无法通过：**如实写在交接里，不要把未完成写成完成。**
  上一轮的交接做到了这一点，本轮保持。
- 不要 reset / checkout / 清理别人的未提交改动。
- 两个危险维护函数（`resetCurrentUserRoom`、`deleteDemoFamilyOnce`）的护栏不要绕过 ——
  这个项目 2026 年 9 月发生过真实房间被清空的事故。
- 不要碰 `/Users/yuandai/Documents/ChatGPT/DK—小程序` 里的资质、备案与审核材料。

---

## Sources & References

- `docs/brainstorms/2026-09-25-conversation-intelligence-requirements.md` ——
  需求与硬门禁定义（R1 判据已于 2026-09-27 修订）
- `docs/handoff/2026-09-27-conversation-intelligence.md` —— 上一轮交接与未通过项
- `docs/acceptance/2026-09-27-conversation-intelligence-results.md` —— 验收总表
- `docs/acceptance/2026-09-27-conversation-intelligence-live-model-results.md` ——
  20 条逐条输入、回复与评审锚点
- `docs/acceptance/2026-09-27-conversation-intelligence-followup-optimization.md` ——
  第 17 条两轮优化与内容检查阻断记录
- `cloudfunctions/chatInterview/personalMemoryCore.js` —— 倾向阈值与 `inferred` 强制标记
- `cloudfunctions/personalMemory/service.js` —— `confirm` / `correct` 的数据层实现
- `miniprogram/domain/interview.ts:26` —— `FOLLOW_UP_LABEL`（U1 的修改点）
- `AGENTS.md` —— 二维码交付前的整体流程验收约定
