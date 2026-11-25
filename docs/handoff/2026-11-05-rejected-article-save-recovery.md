# 保存被内容检查拦住后的恢复（2026-11-05）

业务提交：ed3db26c3a1476c3b9a6ee9fd2a2cd6a7a8204de。继续 document07-miniapp-acceptance 候选；未合 main，未生成新二维码、上传体验版、提审或发布。用户原稿未被本轮修改，不能声称手机草稿已经恢复。

## 已查证的故障

用户截图显示第一章“解放”修改仅存本机，整书发送报“文字未通过内容检查”。上一轮自动补存没有覆盖内容审核拒绝后的状态恢复。

1. 当前编辑页 articleAttempt 与关闭章节的存储 attempt 遇到明确 CONTENT_REJECTED 后仍保留旧 payload。后来输入的新内容被旧请求挡住，退出重开也重复旧请求。失败回归已复现。
2. 服务端原先先审核再查幂等回执，已落库但回执丢失的保存可能在重试时被新的检测结果拦住。失败回归已复现。
3. 微信直连的空结果、错误返回被当作 false；Review 与 Block 混为内容拒绝；部分明确 87014 异常可能进入备用服务重判。缺少准确诊断。

真实云控制台（只读）发现：contentSecurityCheck 请求 6a514ac3-8593-4d83-a50c-1df5b753b478 的 msgSecCheck 返回 45009 / reach max api daily quota limit。对应时段 storyBooks 请求 ac4e3b9c-29fe-4846-803f-71d0f48c891a 记录共享检查额度耗尽，最终返回 CONTENT_REJECTED。现有降级逻辑说明它走到了腾讯 TMS 非 pass，但旧代码没有记录 Suggestion，因此无法从这些旧日志断定是 Review 还是 Block。不能把额度耗尽说成文章违规，也不能声称已经确定误判原因。

## 修复范围

- 明确拒绝或需复核的请求释放旧 attempt，最新文字仍备份本机；检测期间继续输入自动接着保存。未知网络结果保留同一 requestId/payload。
- 关闭章节补存遇到新本机输入先重读，避免旧回调覆盖新稿。相同拒绝不在单次调用中无限重试。
- 已确认的不可变保存回执在检测之前返回，仍检查空间所有权、familyId 和 fingerprint；不为未确认的新稿跳过检查。
- storyBooks 区分 pass、reject、MODERATION_REVIEW、MODERATION_UNAVAILABLE。Review 与明确拒绝不调用另一服务重判；缺失或矛盾结果视为不可用。
- 非通过诊断仅记录 provider、verdict、数值 code、traceId、数值 label，不记录用户全文、openid 或原始错误。
- 六份既有 Tencent 适配器保持源码一致：缺失/未知 Suggestion 返回 unavailable，保留原 status 契约，并传回服务商 RequestId 供诊断。本轮仅部署 storyBooks，其余五个函数的适配器修复尚未部署。
- 无新增按钮，无审核放行、权限变化或资源购买。

## 自动验证

新增失败回归覆盖：拒绝后改稿、检测期间继续输入、关闭章节旧请求、后台并发新输入、相同拒绝不循环、确认回执恢复及授权边界、Review 独立错误码、系统错误分类、明确拒绝不降级、空/矛盾结果及日志隐私。旧丢回执重试与版本合并测试继续通过。

类型检查及全部 1801 项测试通过，git diff --check 通过。日志 /tmp/sg-moderation-full.log。当前主仓库缺少 jpeg-js/pngjs/sharp，按锁定版本安装到 /tmp/shiguang-1105-test-deps，通过 NODE_PATH 运行；没有修改项目依赖或锁文件。

## 云部署证据与未完成验收

部署前通过云控制台“下载 ZIP 包”取得 storyBooks-$LATEST.zip，37 个业务文件逐字节与 d910480 基线一致；不是从本地复制的假快照。CLI 下载连续 ECONNRESET，但 UI 下载成功。

通过标准脚本从干净提交 ed3db26 仅部署 storyBooks 到 cloud1-d5ghzk30ve609f544，AppID wx86ae3e9d507ce52d；部署状态核验时间 2026-11-04T17:35:16.963Z。脚本日志 /tmp/sg-moderation-deploy.log。Active 不等于源码比对；部署后 CLI 下载仍 ECONNRESET，需再用云控制台下载核对。

电脑二次锁屏，页面验收尚未完成。本轮尚未创建测试书，无待清理的测试文字。用户已收到解锁并保持亮屏的问题。另请用户在手机重新打开“满城/解放”触发一次自动补存，不改正文、不清缓存；准确原稿仅存在手机，等待真实提示及新诊断。

下一步：
1. 电脑解锁后，通过云控制台下载部署后的 storyBooks，逐文件比对 ed3db26。
2. 在已确认候选源码的开发者工具编译，通过正常 UI 新建可识别虚构测试书；编辑、直接退出、重开、核对目录和最新版分享。若能复现真实检测拦截，再核对改稿恢复；不得注入假审核状态冒充实际验收。
3. 查询用户手机重新触发的真实检测诊断。若仍 Review/Block，保留原稿并调查对应服务结果；不修改用户文字来绕过检查，也不把错误文案修正称为同步已解决。
4. 清理虚构测试书并补充证据，全部涉及路径验收后才按内部体验授权出新码。旧 d910480 二维码不代表本轮。

外部记录：/Users/yuandai/.codex/visualizations/2026/11/04/01a1a475-8d35-7062-b667-bdf431d3267e/shiguang-moderation-recovery/deployment-checkpoint.json。没有将未完成项填 passed。

## 继续：简化私人保存（2026-11-05，尚未部署或页面验收）

用户明确拒绝新增隔离草稿库、复核队列及按钮，要求编辑直接自动保存、退出重开最新、分享最新。

真实补存日志已确认：storyBooks request `ed81f2b4-71c8-42a7-bf2b-9565d99190ca`，微信返回 45009，shared unavailable，腾讯 TMS 返回 review，trace `f8fc8377-760a-4c41-829b-75672b21d69b`。这是保存前文字检查阻塞，不是手机断网。

本次代码：
- articleSave 去掉私人持久化前的文字审核，复用既有不可变版本、幂等回执、所有权和来源检查；图片检查保留。不新增存储集合或用户步骤。
- sharedRead 对实际授权章节的返回快照检查；复制和发回在事务外检查，在事务内再次校验同一快照。已完成的幂等回执仍可恢复。
- 章节包的 sendChapter/createChapterClaimLink/returnChapter 在 drinkingTimeBridge 实际投递前检查标题、正文、署名、图片说明和页名，身份来自微信运行时。复用相同 moderation/TMS 适配器，不改环境变量、不复制密钥、不开启付费开关。
- 不再用“草稿已保留，暂未同步”的审核提示描述已经保存的文章。
- 既有分享导出检查仍保留。没有部署这批更改；不能只部署 storyBooks 而遗留旧投递出口。

验证：全量类型检查及 1808 项测试通过（/tmp/sg-private-save-check4.log）；之后增加两项并发变更/拒绝发回测试，22 项复制测试通过（/tmp/sg-egress-final-tests.log）。最终全量类型检查与 1810 项测试通过，日志见 /tmp/sg-private-save-final.log。

阻塞与下一步：
- CUA 返回 Mac locked，已请用户解锁。尚未进行当前代码的电脑完整流程验收，没有创建测试书，没有新二维码。
- storyBooks 云部署已获授权；drinkingTimeBridge 不在既有部署授权内，更新前仍需用户明确授权。
- 上轮 storyBooks 部署后业务源码下载比对尚未完成；新增 drinkingTimeBridge 部署前也需下载当前线上源码比较，避免覆盖其他工作。
- 两个服务按已核验版本更新后，再用正常 UI 验证编辑、直接退出、重开、目录标题/正文和分享最新快照，清理测试增量后生成二维码。不要清理手机缓存，手机“解放”原稿仍是待恢复的真实数据。
