# 随手记后的全量验收：仍未完成

## 交付边界

用户明确选择“完成全部上线验收后再出码”，没有内部预览例外。未生成二维码、未上传、未提审、未正式发布。随手记专项结果见 `2026-11-01-quick-memory-conversation.md`；不能把专项通过转换为全应用通过。

独立工作树：`.worktrees/codex/quick-memory-conversation-20261101`。本轮功能提交截至 `b0f13d0dc1872b0102d4a0aa971b97c97341c5e3`。main 有其他会话未提交工作，未覆盖、未合并。

## 验收中发现的修复

- `b8be79c`：新建书写入成功后只读 home 当前稿投影，不下载全部历史稿。新增回归验证 state 请求参数。
- `a1b50e5`：大图已显示但封面裁切前再次 getImageInfo 失败，页面显示“暂时读不到图片”。复用预览图片 load 事件尺寸，校验 URL 和有效数值，未加载时保留原读取路径。修复后实际打开裁切、拖动取景、保存封面衍生版本成功，原图保留。网络读取失败的更底层原因未确认，未改变域名校验、VPN或权限。
- `b0f13d0`：选用章节插图/底图前后只取当前稿，避免两次全历史下载；旧 memberId 路径保持原协议。原实测日志曾有 room.load 70240ms；优化后尚未完成真实完整选用复测，不能宣称具体加速倍数。
- 类型检查和 1652 项自动测试通过。自动测试不是 UI 或真机验收。

## 实际操作与未完成项

全部只用虚构内容；设备为微信开发者工具 2.02.2608060，模拟器基础库 3.17.5，已有账号。没有真机或全新账号通过证据。

| 验收项 | 实际证据与缺口 |
| --- | --- |
| book-read-write-restore | 新建两本测试书；第二本保存 v1/v2，历史恢复 v1 后 v2 仍保留；重新编译重开看见 v1 与上传照片。未覆盖本轮最终代码的全部章节管理分支，不填整体 passed。 |
| article-question | 真实文字 AI 连续两轮回复，正确沿用蓝色纸船和绿色笔记本；已点整理成文，但未完成预览确认写入和重开。后续编译重启了页面，不能把问答通过当整链路通过。 |
| image-reference-and-layout | 上传小鸟夹具；仅根据虚构文字真实生成一张纸船插图并选用，图像列表重开显示“使用中”、章节概览显示 2 张图片。文章画面只确认上传照片，生成插图显示尚未确认。参考照片生成分支未测。最后版本点击图片预览未打开，原因尚未定位，原生返回可用。 |
| cover-and-spine | 裁切并选用生成图为封面成功，另存衍生图。主页截图已留，整套书脊/底图视觉检查未完成。 |
| returning-account-cold-start | 模拟器重新编译可显示已有书；未以手机冷启动背书。 |
| primary-navigation | 首页、人生之书、记忆之家、随手记及书稿有实点记录；“我的”已打开并返回；所有可见入口和取消分支未完整覆盖。 |
| failure-recovery | 尚未完成真实断网恢复重试。不调整系统网络或 VPN。 |
| fresh-account-home | 两个现有微信账号都使用过；没有从未进入过的真实账号。不能清库伪造新账号，也不反复索要不存在的第三个账号。 |

控制台检查到的一个红色项是渲染层 DOMNodeInserted 弃用错误，不能据此断言业务崩溃，也不能宣称控制台零错误。

## 云端与证据

云环境 `cloud1-d5ghzk30ve609f544`，AppID `wx86ae3e9d507ce52d`。此前 organizeMemory、chatInterview、storyBooks 部署记录见专项交接。本轮七个核心函数真实下载的业务源码已通过 release-evidence 比对；其后三处改动均为客户端，不需要重新部署云函数。

证据在源码仓库外：`/Users/yuandai/Documents/ChatGPT/DK—小程序/artifacts/release-acceptance-20261101-quick-memory`。包含 cloud-evidence.json、check-create-fix.log、check-crop-fix.log、check-image-state-fix.log、history-restored.png、image-uploaded.png、generated-illustration.png、cover-selected.txt、cover-home.png、progress.json。start.json 是开始时提交，不能冒充最终版本记录。没有完整 acceptance.json；证据 24 小时过期后须重新核验。

## 后续

先补图片选用、重开显示、文章 AI 确认入文、断网恢复和导航等可独立完成项；获得真实新账号条件后再完成首次使用验收。所有项有实际证据后，按 preview:wechat 正常入口生成对应提交二维码。禁止机械补 passed 或绕过门禁。

## 测试数据清理

本轮新建的 `QA1101上线验收纸船二` 与 `QA1101全流程虚构纸船` 均已通过书籍总览→更多→删除整个故事（可恢复）→确认，移入最近删除。删除需要等待云端返回，未重复提交、未永久删除图片或历史。当前故事列表已不含两项；重新进入核对结果以外部 cleanup-final.json 为准。
