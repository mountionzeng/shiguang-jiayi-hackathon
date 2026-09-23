# 已有故事继续聊：连续追问修复

## 原因与改动

用户从已有故事的“继续聊”进入，若故事为 objective（忠于原话），且 URL 没有 question 参数，interview.send 在显示用户回答后直接 return，不调用追问服务。之前 guidedQuestion 只修复了每日一问入口，遗漏故事入口；旧测试还将无追问作为期望。

删除该提前返回及只用于该分支的 guidedQuestion 字段。两种入口都可以连续引导，objective 故事仍不传 storyId 给追问服务，不读取整本旧稿作为上下文；整理仍 useAi=false，保留原话。未改云函数、供应商配置或发布默认门禁。

## 验证

- 先写回归：无在线 AI 时本地追问、已有 objective 故事连续三轮云追问；原代码分别失败于 0 对 1、0 对 3。
- 修复后两项通过，已有每日一问两轮回归通过。
- 类型检查通过，全量 820 项测试通过。
- 企业环境 wx86ae3e9d507ce52d / cloud1-d5ghzk30ve609f544；隔离预览 /private/tmp/shiguang-interview-continue-preview-20260924，基于 d4a0cb2 + 本修复；只在预览开启 CLOUD_AI_RELEASE_READY=true，仓库默认 false。
- 真实开发者工具：人生之书 → 既有 objective 故事 → 继续讲这个故事 → 输入带“联调验证0923”标记的虚构薄荷素材 → 连续发送三次。
- 三次都收到“文字 AI 生成”回复，第二次延续摸土/浇水细节，第三次顺着用户“不急着做出成绩”的表达提出反思问题；没有使用模型 mock 或注入聊天状态。
- 整理为 132 字片段，逐字等于三轮回答合并；选择未整理片段保存，重新打开核实三轮原话完整。
- 从正常记忆列表删除本次临时片段（可恢复软删除），再次调用页面真实 refresh 从云读取：正常列表临时片段 0，未入书记忆 3，已入书记忆 1。
- 返回原故事页面重新 refresh，与私有基线比较：故事摘要数组和原有故事记忆完全相同。未向文章插入测试内容。
- 私有证据保存在 /private/tmp/interview-continue-baseline.json、interview-continue-after.json、interview-continue-three-turns.jpg。基线包含私人记忆，不提交仓库。此次没有原稿全文基线，不将摘要比对称为全稿逐字比对。

## 交付边界与经验

本轮真实验证三次模型回复，没有查询供应商最终账单，也不宣称已接入手机算力扣减。没有追加独立 personalMemory 提炼或语音调用。真机输入法仍需用户体验。

最近图片现状预览从仓库原样出码，文字门禁为 false；后续给本用户的联合预览须保留文字预览的 true 门禁，不能退回仅本地追问。

开发者工具初始连接曾 socket hang up；页面就绪后恢复。属性选择器 .story-book[data-key] 等待失败，实际页面正常；优先 class selector 或可见界面索引。测试结束无未决调用，已释放共享开发者工具给图片任务。
