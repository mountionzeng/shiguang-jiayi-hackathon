# 记忆编辑页五按钮整理

## 找回并采用的设计方案

- `docs/references/team-prototypes/人生之书页面布局.html`、`人生之书跳转逻辑.html`、`记忆之家页面.html`：用户此前提供的队友原型。用于延续页面结构，不照搬旧棕色和小字号。
- `docs/handoff/2026-08-28-mini-program-ui-redesign-handoff.md`：宣纸底、玉石绿、明确按钮边界、大触控与安全区的视觉要求。
- `design-handoff/ui-clarity-2026-09-15/BRIEF.md`：已确认的象牙纸、墨色、玉绿和克制留白方向。
- 本机既有便签预览 `/Users/yuandai/Documents/Codex/2026-09-12/codex-md-codex-book-shelf-handoff/work/recall-visual-check.html`：参考标题与辅助说明的层级。

没有找到专门画好这五个按钮的独立方案；本次是沿用上述已有视觉体系进行局部设计。无需新增图片或付费生成。

## 改动

仅修改 `miniprogram/pages/archive/archive.wxml`、`archive.wxss`，没有修改 TypeScript 行为、云配置或 AI 权限。

- 分组选项改为两列圆角按钮，选中项有玉绿边框、底色和勾选标记；无障碍文案说明已选中。
- 保留完整动态 `storyOptions` 循环，不将故事写死成“岱”，不为固定五个按钮删减故事。
- 保存修改为全宽实色主按钮；整理进书使用浅玉绿，标题与“预览后写入”分两层；返回使用素色描边。
- 操作间距 20rpx，分组与操作之间有留白；覆盖微信原生按钮固定宽度，消除狭窄宽度和长文案异常断行。
- 保留既有点击、保存禁用、加载、未保存提醒等行为。

## 验证与清理

基于 main `b7efc12` 的隔离工作树 `codex/archive-five-buttons`。`npm run check`：类型检查与全部 819 项测试通过；`git diff --check` 通过。

实际微信开发者工具项目为 `/private/tmp/shiguang-five-buttons-preview-20260923`。企业 AppID `wx86ae3e9d507ce52d`、环境 `cloud1-d5ghzk30ve609f544`；只有该隔离预览开启原有 release-ready 开关，仓库保持 false，personalMemory 保持关闭。没有部署云函数或调用付费模型。

真实流程：

1. 记录已有故事书稿和三条活跃记忆基线。通过客观记录随手记入口，真实输入并发送带 `FIVE-BUTTONS-0923` 标记的虚构文字，整理并保存到已有故事。
2. 在记忆库打开该临时记忆，选择“暂不归类”，保存、返回列表、重开，确认分组确实为空。再编辑测试标题和分组并保存，返回重开后确认云端保留两项修改。
3. 实际点击“暂不归类”和已有故事按钮，验证选中态切换；从新“整理进书”按钮进入章节流程，仅选中本条记忆。
4. 选择已有第一章，查看原文，打开原生位置选择器并确认章节末尾；下一步生成全文预览，核对原文完整保留、测试文字恰好一次。
5. 确认写入，再打开新的书稿页从云端读取。目标章节文本块拼接后与预览逐字一致，其余章节逐项不变。
6. 返回执行正常“撤回这次整理”，重开核对整份 draft 与基线完全一致。将本条测试记忆正常移入“最近删除”，重新打开记忆库确认三条原有记忆逐项不变；再次重开书稿仍与原始基线一致。没有永久删除历史或原文。

视觉检查：390px iPhone 12/13 Pro 和 320px iPhone 5 模拟器。额外以仅存在页面内存的多故事及长中英文名称检查换行，然后恢复实际选项；这部分仅作为布局检查，不充当云端流程验收。设备切换会重启小程序，应待首页稳定后重新导航。

截图只含虚构测试文字，保存在材料库：

`/Users/yuandai/Documents/ChatGPT/DK—小程序/artifacts/ui-feedback/five-buttons-20260923/`

- `after-390.png`：主流屏幕真实编辑页。
- `after-320.png`：小屏幕真实编辑页。
- `long-options-layout-only.png`：多选项、长名称布局检查。

云端基线与比较结果仅留本机 `/private/tmp/five-buttons-*.json`，不入仓库。当前完成的是电脑端真实云保存与读取；未声称真机或 AI 重写分支验收。

验收与清理之后成功生成预览码：`/private/tmp/shiguang-five-buttons-preview-20260923/five-buttons-e2e-verified.jpg`，入口为记忆库，点开任意记忆查看编辑按钮。工具返回 `ok=true`、`success=true`，总包 1,867,128 字节；没有上传发布。最终控制台 error 过滤结果为空。
