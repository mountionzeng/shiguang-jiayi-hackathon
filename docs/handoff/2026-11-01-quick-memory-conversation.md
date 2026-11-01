# 随手记：先保存原始对话，再选择聊天

## 用户要求与根因

用户希望随手记新开一段记忆，收下文字、照片、录音或混合素材，以消息流保存。分析与聊天随后由用户选择，聊天策略继续由“聊天与每日一问：自我探索和艺术风格”会话负责。

旧采访页 onLoad 无条件加载账号全部 captureList 和单一旧草稿，导致新入口展示过去的素材回执；sendMemoryCapture 发送后直接调用 continueMemoryCapture，等待视觉/语音/文字整理，每批各建一条记忆，页面没有用户消息气泡。

## 实现与接口

- 独立工作树 `codex/quick-memory-conversation-20261101`，从 main 756dde9 建立并合入已提交修复基线 c3235e2。主仓其他会话的未提交改动未动。
- 新入口不请求 captureList、不自动恢复旧草稿。本次 sessionId 等于第一条 captureId；后续不可变消息拥有各自 id，携带同一 sessionId。
- material_captures 首条记录保存 sessionCaptureIds；每次 receive 原子登记消息索引，最多50条。按 accountId/familyId 验证所有权。独立会话不允许绑定旧批次或跨账号记录。
- 新 `captureCapabilities` 返回 `{sessionVersion:1}`，客户端写入前先检查协议，避免旧云函数把新会话写成独立历史批次。新 `captureSessionRead({id})` 可用本次任一消息 ID 读取 `{sessionId,items}`，items 按接收顺序返回；旧 capture 返回单条，作为历史原件只读展示。
- 发送只上传/注册原件并调用 captureOriginal；不请求AI同意、不调用模型、不默认转写或识图。只有最终 saved 回执才标“已记下”。失败保留本机原件，可用相同 ID 重试。
- 同一会话稳定使用 memoryId=`memory-${sessionId}`。memories、source_records 与该消息 saved 状态同事务写入；重复请求不追加。已删除记忆不被复活。
- 完整文字、全部照片与录音均在消息原件中。为兼容已有记忆编辑/分享契约，memory.text 保留不超过500字的预览，memory.photoIds 最多9张预览；source_records.rawText 保留完整原文。新增 materialCapturePreviewText 只用于辨别自动预览：若用户修改了记忆正文，后续素材不覆盖手改正文。原记录仍继续追加。
- 新草稿使用账号+会话的本地键，并有未发送索引；普通聊天不加载这些草稿。新随手记提供显式恢复入口，旧 v1 草稿仍可恢复。连续发送后会创建下一条空草稿，未发送的新文字不会因为返回而丢失。
- 右侧消息气泡直接显示原文字、多图与录音播放按钮；保存过程有动画。底部可另记一段、查看记忆、和小忆聊这段。图库加载失败可重试。
- 续聊继续使用 `/pages/interview/interview?sourceId=<memoryId>`。聊天方按明确 memoryId 加载远端来源；素材原话通过 memory.materialCaptureId → captureSessionRead 装载。未理解的照片/录音不能当作模型已知内容。此处不新增聊天策略。
- 修复原音频未传完却提前进入 ready、随后 register 被锁死的问题；历史 manual ready 未提交原音频也允许补传。照片只等待当前批次的上传，不再为了发一句文字等待其他照片队列。

## 验证

- 新云端回归在 c3235e2 基线确实失败：缺少会话读取/绑定，长原文仅审核摘要。基线复现日志 `/tmp/quick-memory-baseline-test.log`。
- 覆盖空白入口、显式恢复、普通聊天隔离、连续消息、网络失败重试、旧云协议拒绝、同会话幂等、跨账号拒绝、混合原件保存、录音补传、完整长原文、12张照片保存与9张预览、人工正文保护和删除保护。
- 自动化结果以本次最终检查日志为准，暂存 `/tmp/quick-memory-check.log`。这些是模拟依赖测试，不是云端或手机验收。
- 待完成：聊天方补丁整合；本次 organizeMemory 部署前云源码比对与部署后回读；开发者工具实点新建、多消息、混合素材、重开、指定来源续聊、测试清理。共享开发者工具当前由聊天方使用，串行交接。
- 本文初始提交时没有新二维码、没有上传提审，不沿用旧版本的验收结论。
