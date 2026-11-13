# Logo AI 对话复用电脑版：新工作树交接

## 用户本次目标

用户明确要求新建独立工作树和新对话，继承旧对话上下文：“按Logo开始进行AI对话，这件事情完全没有成立。但是其实电脑版本有好的对话路径，你可以直接抄。”
请实际追踪电脑版当前可用的聊天入口、上下文、发送、回复、历史恢复与写作采用流程，复用成熟流程到原生微信小程序已有小鸟Logo入口。不要仅改按钮文案或提示词，不要重新发明问卷，也不要把旧兼容组件误认作当前入口。新对话可以继续实现，不需要再让用户重复讲历史。

## 工作区与版本

- 本功能唯一写入工作树：/Users/yuandai/Documents/New project/shiguang-jiayi-hackathon/.worktrees/codex/logo-ai-conversation-20261113
- 分支：codex/logo-ai-conversation-20261113。
- 2026-11-13由ce-worktree脚本fetch origin/main后建树，main/origin/main均f53dbfe；随后在新树fast-forward至35e025c，纳入上轮125个已提交编辑器/保存等成果。main与原工作树不改，主仓库存在大量其他未提交工作，禁止覆盖/拷贝/顺手提交。
- 上轮开发线：.worktrees/codex/story-chain-simplify-20261105，HEAD 35e025c。
- 本对话最后实际上传手机包0.1.1106d，源码c963d1c691e12a0689fee099af66714b6d1e7a8a；35e025c仅追加上传记录。不能把此历史记录当作11月13日线上无变化的证明。
- AppID wx86ae3e9d507ce52d；云环境cloud1-d5ghzk30ve609f544。
- 先读本树AGENTS.md、docs/WORKSPACE.md、docs/STABILITY.md、docs/RELEASE-ACCEPTANCE.md与docs/handoff/2026-11-06-editor-module-media.md。内部体验与正式发布验收已分开，按文档顶部更新执行。workspace:check只对已记录快照，不能验证实时云端。
- 创建阶段跳过安装：现有根仓库node_modules可供TypeScript/tsx解析；不擅自升级依赖。

## 电脑版参考：必须用当前入口

仓库：/Users/yuandai/Documents/New project/drinking-time-local，当前读到HEAD 616a053b，只有outputs/未跟踪。只读参考，不在这个任务改动电脑版或启动第二个服务。
该仓AGENTS.md规定只在主仓库3000端口运行dev server。先读AGENTS.md、docs/handoff/SESSION-BOARD.md，使用pnpm feature:context定位权威实现。
2026-11-13已查功能卡writing-companion、publishing-module-chat-context；还有selection-scoped-chat-editing、independent-text-versions、book-chat-rewrite-adoption。

当前入口与优先参考文件：
- client/src/features/storyAgent/views/StoryAgentChat.tsx
- client/src/features/publishingAlbum/ChapterWriting.tsx、bookBlockContext.ts、ModuleSelectionBridge.tsx
- client/src/features/publishingDraft/PublishingDraftWorkspace.tsx
- client/src/features/writingCompanion/DesktopWritingContext.tsx、desktopWritingSession.ts
- client/src/features/storyAgent/desktopChatQueue.ts、useDesktopChatQueue.ts
- server/services/writingCompanion.ts、server/routers/storyAgent.ts、server/services/storyConversation.ts
- shared/creativeExploration.ts、server/services/writingTechniqueLibrary.ts
- WritingCompanionButton.tsx是旧兼容组件，账本明确说已不再有活动入口；10月12日旧交接不能替代当前代码与功能卡。

已确认的电脑版机制：
1. 打开聊天直接带入当前未保存全文或显式选区，不为开场自动请求模型；用户发送才调用。未选模块用全文，有选区只作用于明确选区，其他原文机械保留。
2. 对话共同探索而非固定问卷，最多一个具体问题，不必每轮追问；已有事实/目的足够或用户明确要求写就推进，不重复问完的问题，不捏造经历/对白/动机。
3. 每轮固定发送时的故事、版本、选区/模块和写作上下文；队列有序，失败/未知提交不能自动重放；恢复沿用同一轮次身份，发出的输入及时清除且不清除发送期间新输入。
4. 讨论给提议，生成候选与采用正文区分；改稿保留历史，正文变化或切换作用域不能被过期候选静默覆盖。复用规则与现有小程序入口整合，不因此新增一堆常驻按钮。
5. 不复制网页后端路径或凭证硬接小程序；识别可抽出的契约/纯逻辑、服务端规则和最小原生适配。不要把功能卡working当作所有真机/付费模型场景已验证。

## 小程序相关现有入口

- miniprogram/pages/book/book.ts：onXiaoyi...、saveArticleChat、articleChatKey、已有聊天/采用/保存流程。
- miniprogram/pages/book/book.wxml/.wxss：既有小鸟、对话与三个媒体入口；保持无关样式。
- miniprogram/services/xiaoyiCompanion.ts、writingSession.ts、writingSupport.ts、writingStory.ts等。
- cloudfunctions/chatInterview、organizeMemory：已有问答与材料整理；按实际调用图决定范围。
- article-editor组件、articleModules/articleService与storyBooks/article.js保护模块、保存和来源协议。

## 用户此前的关键意图与不可回退项

用户对反复修坏、浪费额度和额外设计非常不满。只改请求范围；上传时逐项比较上次交付的完整差异，前后端同样约束。额外图片/字体/打包/配置调整须先给具体方案再确认，不能凭“看起来一样”擅自改格式。
- 用户给材料后先真正提取书中文字和照片信息，再结合上下文聊写作；不要让用户先会写或反复说明已说过的目的。记忆持续存在，可复用到多篇文章/多记忆合写。
- 用户纠正本次立即调整；明确表达的长期写作偏好需可查看与修改，禁止把推测当事实。
- 重开继承此前聊天和整理内容；不要清草稿或缓存来掩盖问题。
- 发送后输入框要清掉已发内容，保留新输入。失败有真实可操作反馈；不能按钮无反应。
- 正文/书名/章名自动保存，目录、分享、接收保持同一已确认版本。来源记忆/图片/封面不丢；不能拿旧云稿覆盖较新本机稿。私人保存与对外检查分开，勿新加用户无法理解的保存门槛。
- 回车在光标位置拆分新文字模块，后文进入相邻模块，图片顺序不乱；中间编辑不能跳到末尾，Done不反复弹键盘，滚动收起键盘，无大块空白/末行遮挡。
- 小鸟尺寸和底部渐变已确认；正常浏览只显示Logo，编辑提示动画文字正向慢速。当前选中模块时“转图片/转音乐/转有声书”三个文字入口保持可见（最新规则覆盖更早键盘收起三入口的要求）。不要顺手改Logo和媒体按钮。
- 0.1.1106d新增长按第一块、点第二块，上方合并两个完整文字模块。保留两块全部内容/换行、媒体顺序、来源权限；mergeSourceBlockIds由云端用旧块推导sourceIds，客户端不提供权限。不得破坏已验收的拆分/合并/保存重开。
- 手机体验槽用户说明会自动跟随上传，不要反复叫他去后台设体验版。此前mp.weixin.qq.com被工具站点安全策略阻止，不得换工具绕过。

## 验证、部署与费用边界

- 最后完整检查1865项通过；实际电脑用独立测试书验过两轮回车拆分→双选合并→云端保存→退出重开→继续编辑；通过正常删除将临时书放最近删除，用户五本书未改。手机键盘和长按不以电脑结果代替。
- 最近本对话storyBooks部署源dbaf85f061b3b0ed2d0d2335734d187bbb5775d0，41业务文件回读一致；20秒、Nodejs16.13。证据/tmp/1106-merge-before、/tmp/1106-merge-after、/tmp/1106-merge-deploy.log，只代表当时。
- 新任务部署前重新核对真实线上源码及相关配置，限定函数/接口/权限/数据语义范围，不能部署旧副本覆盖外部变化。已有历史授权不是扩大权限、公开发布、任意付费的许可。
- 不新增付费服务或直接沿用旧一次性媒体验证5元当本任务预算；先做不付费的代码/流程验证，真实付费验证需要当前明确额度。
- 0.1.1106d主包2,094,345字节，距2MiB只有2,807字节。已有批准仅涉及此前3张PNG以及这轮capture-memoir-book.png；不是后续任意压缩许可。需变动范围外资源时先准备方案。
- 发布证据/tmp/shiguang-1106d-trial/release.json、upload.log、upload-info.json；临时目录可能会清理，仓库交接才是持续入口。

## 新对话建议起步

先对照电脑版当前活动入口与小程序Logo完整调用链，用简短说明指出差异和本轮边界，再复用实现。保留现有功能，针对实际失败机制写有效回归；勿把本轮变成全项目重构或长篇空泛计划。关键未知先读源码/已有上下文，不反复找用户要截图。
