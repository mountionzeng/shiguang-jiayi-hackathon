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
- 聊天方补丁已整合：来源完整读取、captureSessionRead 原话加载、6000字上下文预算和已批准死代码清理。对应上游 1e2a879、86f2be9、1edeabf、8aefc77。
- 实点发现 storyBooks/flow.js 的 contributionForClient 丢弃 materialCaptureId，导致重开时原件入口和续聊原话读取均被跳过；已补字段，story-read-volume 同时覆盖 home/memories 服务序列化。
- 最终功能提交 217a836，npm run check 类型检查及1648项测试通过。仅源码结果，不等于手机或全新账号验收。
- organizeMemory 从67e532b部署；chatInterview/storyBooks 从217a836部署到 cloud1-d5ghzk30ve609f544。部署前业务源码分别与 c3235e2 / main756dde9 / HEAD已知基线相符；部署后60个业务文件与最终功能提交逐字节一致（11+12+37）。下载曾遇ECONNRESET，后续重试成功，没有更改VPN或网络设置。
- 实点完成：新随手记空白；两次发送归入同一记忆；第二次混合文字+照片+录音直接保存，未请求AI分析授权；重新编译后从记忆库→查看原始记录，显示两条原话、图片和原音频文件；图片可点开大图；录音播放按钮实点无报错，但未验证扬声器输出，不声称录音音质/真机麦克风通过。
- 实点完成：另记一段不带旧消息；未发送文字只在明确点恢复后带回；清空测试草稿后新入口不再显示恢复项。素材菜单仅照片/文件/录音，修正绿色气泡内录音按钮对比度。
- 实点完成：原始记录→和小忆聊这段，开场包含这两条原话；真实AI调用准确复述先后两条虚构原话，不猜图像/录音内容。本次文字AI同意仅在主动续聊时出现。
- 本轮测试记录：QA1101随手记验收（虚构）及退出续聊自动保存的“这是虚构验收”。已通过正常最近删除软删除清理；返回首页再重开云端列表显示15条，两项均不在列表中；另一个聊天的“虚构验收素材1101整理”亦不在列表。见 cleanup-verification.json。
- 证据目录：/Users/yuandai/Documents/ChatGPT/DK—小程序/artifacts/quick-memory-20261101；check-final.log、cloud-after-comparison.json、linked-deployment.log、reopened-originals.txt/png、real-continuation.txt/png、fresh-after-draft-cleanup.txt。
- 本轮没有生成二维码、没有上传提审；没有完成真机麦克风、全新微信账号、全量发布流程。工作在独立分支，未合并存在其他会话改动的main，不沿用旧版本验收。
