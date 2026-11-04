# 随手记先读取材料

用户测试两个完整故事时指出：系统应先读出材料再帮助整理，不要求用户先想好怎么写。接续昨天0.1.1103qb候选987d444，工作树为 /Users/yuandai/Documents/Codex/2026-11-03/document07-miniapp-acceptance；主仓原有改动保持原样。

根因：随手记会话只保存原件；源记忆续聊仅读取item.text，媒体始终标为未分析。旧看图仅小图120字概述，不能用于读取文档正文。

新增captureReadMaterials：在已保存且本人未删除的记忆上逐份读取，图片用display规格，转录可见文字、描述画面、标注不确定处。结果独立保存到evidence，原件、正文与历史不变。截断明确失败；逐份缓存、事务领取、失败不自动重复付费。语音沿用已提交任务查询。新增material-reading照片同意用途，客户端先显示识别结果再带来源续聊。

类型及1678项测试通过。共享依赖缺jpeg-js/pngjs/sharp，临时目录/tmp/shiguang-1104-test-deps按相同锁文件npm ci，用NODE_PATH测试；未改共享依赖。新增已存图片读取、来源全文、拒绝授权、原文不变、复用、并发、异常、删除/越权等回归。

官方CLI已下载organizeMemory，11个业务JS/JSON与987d444逐字节一致。证据/tmp/shiguang-material-read-1104/cloud-before-comparison.json。

两次自动审批拒绝提交部署后，用户本轮明确授权：从此工作树提交修复，仅更新既有环境cloud1-d5ghzk30ve609f544的organizeMemory用于验证。不是提审/正式发布授权。工作树未归档/未锁定，merge-base(main,HEAD)=main=f53dbfe。

待实测：两张虚构图片保存、真实识别、重开复用、来源续聊、软删除清理，以及恢复用户5张待发草稿。尚未上传新内部包、提审或发布。完整故事与成稿入文仍需后续验收；当前续聊保留既有6000字预算并标明省略，不能声称任意长材料均完整进入模型。
