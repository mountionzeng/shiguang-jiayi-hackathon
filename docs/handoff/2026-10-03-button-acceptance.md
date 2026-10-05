# 逐按钮验收清单与生成反馈

> 最新状态：每日一问已真实验证保存后更新，四个提速云函数已部署并核对源码。详见 `2026-10-03-daily-question-deployment.md`；下方未部署记录为历史过程。

日期：2026-10-03。分支：`codex/restore-approved-ui-20260930`。

## 二维码后的书架插图反馈（2026-10-03 20:47）

用户真机反馈书架只剩色块，希望复用原插图、仅调整颜色。定位到历史提交 `a160aaa` 把 stories 的 `story-book-spine.png` image 替换成了渐变 view。本次从 `a160aaa^` 原样恢复优化后的透明 PNG（38158字节），保留纸纹、装订线、书页及顶部书签；删除矩形调色蒙层，以 image 的 CSS hue-rotate 区分颜色，原 PNG 字节不变。仅修改书架展示，不涉及数据或云端。

同步到现有测试预览，开发工具实测首页→人生之书→打开临时图片测试簿→返回所有故事，三本书插图、标题及点击正常。截图：材料目录 `artifacts/button-acceptance-20261003/bookshelf-original-art-restored.png`。`npm run check` 类型检查及1073项测试通过，日志 `/private/tmp/shiguang-spine-check.log`。本轮未新增业务测试，仅复用完整检查与真实界面验证。颜色滤镜的手机表现尚待下次二维码真机确认；前一张 `6ff7936` 二维码不包含本次恢复，尚未重新生成二维码、push或部署。

## 本轮二维码交付（2026-10-03 19:44 发起）

用户让本对话判断继续修改或先提供二维码；本轮选择先交付已实测客户端供真机确认。官方 CLI preview 已成功退出（exit 0），二维码和 info 文件均生成，包体 2141173 字节。代码固定为 `6ff7936830e090d66924ba0d606b776e83d40b09`，预览目录 `/private/tmp/shiguang-xiaoyi-input-fix-20261002`。生成前后核对189个客户端文件，哈希未变；唯一源码/预览差异为此前已授权的 runtime.ts 预览开关。

产物目录：`/Users/yuandai/Documents/ChatGPT/DK—小程序/artifacts/button-acceptance-20261003/`，文件前缀 `preview-6ff7936-20261003-194407`：`.png` 为新二维码，`-info.json` 为官方包体信息，`-manifest.json` 为版本及逐文件哈希，`.log` 为成功日志。本次已经目视检查二维码图像。

客户端包含本轮按钮修复、重复读取优化、生成反馈动画。电脑端实际对话、整理入书、插图生成/插入/保存重开及图文导出记录见下方，测试增量已清理；不能表述为所有319处绑定全通过。四个云端函数仍未部署，手机输入法、相册和转发仍待真机确认；本码不代表云端提速修改已生效。

## 当前结论

生成反馈及本轮实测修复已通过类型检查和 1073 项自动化测试，0 失败。Mac 解锁后已进行真实按钮点击、真实文字整理、真实插图生成与图文导出；以下保留未测分支，不能宣称 319 个绑定位置全部通过。预览已同步并编译全部本轮客户端修复；记忆快速打开、“确认写入”防重入和社交导出阶段文案已实际复测。正式云端尚未更新。

已接入：小忆三个编辑入口、对话回应、整理成片段、看照片写文字、正文预览生成、插图/底图/封面、朋友圈文字图排版、公开故事卡和邀请图片。文字用三个轻轻起伏的点；图片用呼吸图框。只使用 CSS，不增加网络请求、JS 计时器或虚构进度；系统支持时遵循减少动态效果偏好。任务结束后卸载动画。

图片任务每次状态返回都会更新行内文案；stored、failed、unknown 均停止动画，即使后续列表加载失败。封面列表失败仍保留重试，但不再把已完成任务显示为生成中。两项新增回归分别覆盖这三种结束状态。删掉旧对话圆点样式和书稿中两处因外层条件排除而永不显示的按钮。

## 当前验收状态与剩余边界

再次解锁后，先重开第一章确认 `【虚构验收1003入书】` 已撤回、原文与底图保留，再同步最后的书稿防重入修复。

- 防重入真实复测：虚构记忆→保留原文插入→预览改成 `【虚构验收1003防重】`→双击确认。立即显示“正在核对最新版本并写入…”，输入与取消/确认按钮禁用；完成后只出现一次增量，目录重开核实。再撤回并重开，仅有原文基线与原底图，历史保留。
- 社交导出新阶段/指标已复测：封面1张+文字1张生成成功并目视核对。27.5秒观察时已排好图、正在最终核验；62.7秒观察时完成。观察间隔不能当作精确总耗时。
- 有声书已检查无声音校验、两种官方声音选择及“我的声音”页；录制被云开关禁用，未录音、未提交付费有声任务。
- 云端四函数部署确认尚未收到；真机输入法、相册/转发和未开放的亲友权限功能仍不能算通过。以下逐项保留未测分支。

## 按钮验收方法

先重开「临时图片测试簿」第一章核对原文基线，确认上轮 `虚构测试1002` 已移除。再按首页→记忆→书稿→图片→发送→家庭→我的顺序验收；每个入口记录点击时间、首次可见反馈、可操作结果时间、错误提示、页面/调用日志。慢项用 `ai.organize`、`ai.biography`、`image.submit`、`image.status`、`image.list` 日志区分传输等待与模型/存储阶段。网络传输完成不等于业务成功。

每个 handler 的 data-action/data-purpose 等分支分别点；列表重复行至少选一项，并覆盖空状态、禁用状态和可重试失败。原生选择器、弹窗的选项属于对应 handler 的补充验收，不能只打开弹窗就算完成。对文字和图片真实生成，要看到忙碌→结果/失败，再返回重开；写入后保存并重开，测试结束清理增量。

向真实亲友发消息、发布朋友圈、不可恢复删除、账号清空和扩大权限只验收入口/取消分支，不执行最终动作。语音输入法、手机相册、微信转发等需单独标注真机限制。当前没有因验收而修改 VPN、锁屏设置、功能开关或共享云端。

## 慢在哪里：已有证据与待测项

已有控制流证据：章节图片原来提交后重读整房与列表并固定等 3 秒，封面等 4 秒；前序修复已省去这些步骤。串行图片状态请求改为最多两路；云端单条记忆从整房扫描改为定向读取，HTTP 连接可复用，美观检查移到后台。详见 `2026-10-03-generation-performance.md`。这些不构成手机实测提速比例。

四个云函数修复尚未部署，部署确认仍待用户回复。后台 sweep 后续已通过实际每分钟调用及返回结果核实运行，配置面板空态不是可靠安装证据。章节插图已真实生成；封面本轮测试了参考选择与取消，真实新封面仍未生成。动画已目视核验，云端 sweep 已只读核实每分钟成功执行；新美观检查逻辑仍待部署后用真实待检查图片验证。


## 2026-10-03 真实点击记录（持续补充）

- 小忆：真实问题→虚构回答→真实整理（9921ms）→放进待确认→不要→完成选择→关闭。输入没有整句重复，文字圆点出现并结束。`虚构验收1003` 没有写入正文。
- 插图：真实提交（9822ms）、状态生成（17184ms）、列表（3036ms）；不是精确点击至显示耗时。新图 346KB。初次插入误报不存在，修复 storyId/memberId 混用后完整复测插入→保存→目录→重开，真实图显示。
- 清理：正常编辑移除该测试插图，保存→目录（0 张正文图片）→重开，原文基线及原底图保留；历史不清空。上一轮 `虚构测试1002` 也已核对移除。新生成图仍保留在测试图片库，不永久删除。
- 书稿：首次实测 room.state 7849ms + book.identity 2587ms → book.refresh 10472ms。并行修复后观察 6398ms、5541ms，网络有波动，不据此声称固定提速比例。来源记忆、历史列表、当前版本预览、返回均可用。
- 首页：换题原先触发约 4370ms 整房重读；修复后立即切换，并仅记录 story.shelf 0–1ms 和本地封面缓存，不再调用 room.load。选故事/不选故事也已复测。
- 社交媒体：真实整本书导出封面1张+文字1张，文本与底图完整；成功经开发工具保存到材料目录 `artifacts/button-acceptance-20261003/{cover-preview.png,text-preview.png}`。这验证电脑端导出保存，不代替手机相册权限。单张分享菜单显示“当前不可发送给朋友/分享到朋友圈”，已取消，未外发。
- 社交分支：选择章节勾选后为1章58字；原文拖选“秋日午后”，预览仅4字；未选文字时有提示。长图、大字号真实生成完成。长图点击35.2秒时已排好2张仍在最终核验，74.5秒观察时已结束，故真实耗时仅能界定在两次观察之间。新增 export-preview/material/render 日志和真实阶段提示用于后续拆分。
- “我的”：首次 room.load 10657ms，另见7010ms、10263ms；余额暂不可用、文字用量记录未开启。生日提醒明确为后续版本。资料只打开/取消；云照片和清空账号只确认框/取消，用户内容未删。
- 人物：空姓名点添加有提示，编辑/取消正常；删除前会整房读取再确认，清空确认已取消。
- 家庭：本轮无邀请、授权或对外发送。书稿亲友邀请为云开关未开放，家庭邀请表单的空输入错误已修复。

- 后续复测：封面确认→取消立即停止动画并恢复按钮，无额外 image.list；已有封面大图打开/关闭成功。电脑码确认弹窗正常显示并取消，未创建凭证。记忆之家亲友空状态→自己12条直接切换，没有新增 room.load。
- 家庭邀请空称呼/缺关系均立即显示持续错误，按钮保持可操作，无云请求；测试称呼已清空，未生成邀请。
- 旧记忆：原话/修改历史展开收起、分组临时切换再选回、撤回确认/取消；小忆“帮我写一下”真实提问→回答→整理13321ms→接到记忆后面→保存→重开核实持久化。随后移除本轮新增文字并保存，重新编译后重开原记忆仅有基线。历史仍保留。
- 整理入书：原测试记忆→已有第一章→保留原文插入→下一步预览，原文未改；把新增内容改为可识别虚构验收句→确认写入成功。发现确认前校验未锁按钮，已修复；随后点击“撤回这次整理”；再次解锁后重开确认成功。最后的防重入修复已同步并再次完整验收/清理，见上方。

## 本轮代码修复

1. 插入新图时按当前故事读取图片，兼容旧人物书；回归先失败后通过。
2. 书稿与草稿账号并行读取，初始加载显示动画，避免先出现空书稿。
3. 动画组件改为使用页面单独声明，避免全局注册警告。
4. 首页选题/选书、本人记忆之家人物筛选使用本页已显示数据；重新进入仍远程读取，共享家庭权限读取保持原路径。
5. 封面取消明确没有提交任务，立即结束忙碌；不明失败和超时仍查询云端防止重复付费。
6. 电脑登录码和声音同意弹窗按钮从5字改为不超过4字，符合微信原生接口限制；新增平台约束测试。声音录制本轮未作实际授权。
7. 邀请必填项本地检查；创建失败文字持续显示。
8. 旧记忆编辑直接使用本次列表快照，重新进入刷新；保存仍读取最新数据并拒绝覆盖冲突。真实复测点击至观察932ms（包含工具开销），没有新增 room.load；不能当成精确渲染时间。
9. 确认整理入书在首次云端校验前锁定，阻止重复点击、退出预览及迟到的输入事件；失败释放锁。回归覆盖双击只调用一次持久化、冲突后释放；新修复已双击实测、重开核对并撤回清理。

10. 普通随手记/回忆录移除80/200字最低篇幅，禁止素材缺失说明，保留虚构标记。真实旧云端测试42字被扩成240字；回归先失败后通过。此提示修复尚未部署，不能宣称新规则已通过真实模型质量或速度验收。

11. 新建故事和打开已显示的故事详情复用书架快照。原新建表单另读整房4102ms；修复后839ms工具观察时已出现，详情1120ms观察时已出现，均无新增 room.load（观察包含工具开销，不是纯渲染时间）。空池不会复用旧记忆列表，初始读取失败显示可重试提示；页面重进及实际写入仍走原云端核验。

### 补充按钮与清理证据

- 空随手记：发送提示“先说一句吧，短一点也行”；整理提示“还没有讲述内容”。照片和微信聊天文件选择器均实际打开并取消，没有选择或上传用户文件；离开空页未增加记忆。
- 最近删除：核对本轮虚构续聊片段在回收站；恢复后列表中标题与70字内容完整，随后仅将该片段重新移入最近删除。最终故事列表为3本，最近删除18项，未归类7段；记忆档案未入书10段、已入书2段，恢复到清理后的数量。永久删除单条和清空回收站只核对确认框并取消，没有永久删除。
- 旧章节迁移页正常加载；选择目标故事显示确认并取消，空名称新建有持续提示。未改变任何旧章节或配图的归属。
- 新建故事修复已同步预览编译；空名称、两种写作模式切换、取消均已复测，没有创建测试故事。故事删除只确认/取消。
- 本轮代码提交：`fd857bb`（按钮修复）、`9ece1cd`（短素材云端提示）、`b143fe3`（故事表单响应）；均仅在当前分支本地保存。最后全量1073项通过，类型检查和 diff check 通过。

## 页面入口清单

从 24 个页面和 1 个共享导航组件提取 319 个交互绑定位置（含按钮、可点击图文和选择器）；动态列表仅列模板一次。此清单记录源码入口，不代表全部入口在当前账号可见。行号取自清单建立时的 `de02147`，后续插入行会偏移；应以绑定名和分支定位。结果为本轮实际覆盖，入口/取消通过不等于最终动作通过。

| 页面 | 绑定位置数 | 本轮实测 |
| --- | ---: | --- |
| `pages/index/index` | 15 | 部分通过：切题、选书、不选故事、新故事入口、章节入口；切题/选书修复后已复测 |
| `pages/me/me` | 16 | 部分通过：资料编辑/取消、删除确认/取消、各管理入口、生日占位；保存变更未测 |
| `pages/personal-memory/personal-memory` | 5 | 已打开；账号处于暂停且无理解记录，未改变开关 |
| `pages/account-link/account-link` | 3 | 确认弹窗修复后通过，取消正常；未生成登录凭证 |
| `pages/profiles/profiles` | 11 | 空姓名校验、编辑/取消、删除确认/取消、清空确认/取消通过；未增删用户人物 |
| `pages/archive/archive` | 23 | 真实小忆提问/整理/追加/保存重开/清理通过；原话、历史、分组、快速打开通过；整理入书进入并写入成功 |
| `pages/stories/stories` | 26 | 新建表单/模式/空名称/取消、详情/章节、回收站恢复与清理、删除确认/取消通过；未新建或删除故事 |
| `pages/story-migration/story-migration` | 4 | 章节归属确认/取消及空名称校验通过；未迁移原内容，配图分支未测 |
| `pages/recall/recall` | 3 | 全部回忆列表、测试记忆续聊入口通过；无数据/错误分支未测 |
| `pages/interview/interview` | 26 | 续聊真实回应、整理、保存页小忆直接整理/追加、片段私密保存重开通过；测试片段已移入最近删除 |
| `pages/invite/invite` | 6 | 空称呼、缺关系本地校验及持续提示修复后通过；测试输入已清空，未创建邀请 |
| `pages/room/room` | 6 | 人物筛选、空状态、家庭邀请入口已点；本地筛选修复后复测通过，无新增整房读取 |
| `pages/review/review` | 6 | 尚未实测 |
| `pages/book/book` | 79 | 部分通过：小忆真实问/整理/拒绝、插图插入保存重开、目录、来源、历史预览、发送菜单 |
| `pages/story-images/story-images` | 12 | 真实插图生成、大图预览、插入完整链路通过；底图修改/删除未测 |
| `pages/story-cover/story-cover` | 6 | 参考图选择/取消、已有封面大图通过；生成确认/取消修复后通过，无额外刷新 |
| `packages/story-sharing/pages/invite/index` | 14 | 入口和刷新通过；云端提示亲友邀请尚未开放，其余不可达 |
| `packages/story-sharing/pages/read/index` | 7 | 尚未实测 |
| `packages/story-sharing/pages/receive/index` | 4 | 尚未实测 |
| `packages/story-sharing/pages/card/index` | 4 | 入口已实测；云端返回故事卡片尚未开放，预览按钮禁用，其余不可达 |
| `packages/story-sharing/pages/social/index` | 18 | 整书、章节选择、四字选段预览、分页/长图、大字号、生成2张、保存2张、单张分享取消通过 |
| `packages/audio/pages/create/create` | 4 | 无声音时有提示；温柔/清晰女声选择通过；未提交制作 |
| `packages/audio/pages/voices/voices` | 6 | 类型选择通过；录制被云开关禁用，无声音档案可操作 |
| `packages/audio/pages/player/player` | 5 | 尚未实测 |
| `components/story-switcher/story-switcher` | 10 | 尚未完成全部分支 |

## pages/index/index

| 行 | 操作/文案 | 绑定与分支 | 结果 |
| ---: | --- | --- | --- |
| 11 | 打开我的 | bindtap=openMyHome | 通过 |
| 25 | 换一个故事聊，现在是{{currentStoryLabel}} | bindtap=toggleStoryChooser | 通过：展开故事选择 |
| 40 | 拾 光 录 {{item.title}} {{item.subtitle}} {{item.memoryCount}} 段记忆 {{item.chapterCount}} 章节 {{item.p… | bindchange=onBookSlideChange | 待实测 |
| 51 | 打开故事 {{item.title}} | bindtap=openMemoryArchive | 通过：测试故事 |
| 81 | 这本书里的记忆 | catchtap=openStoryMemories | 待实测 |
| 90 | 这本书整理好的章节 | catchtap=openStoryChapters | 通过：测试书章节 |
| 99 | 这本书里的人物，在记忆之家查看 | catchtap=openPeople | 待实测 |
| 129 | 写下我的名字 | bindtap=createFirstProfile | 待实测 |
| 141 | 换一个推荐问题 | bindtap=changeRecommendedQuestion | 通过：修复后无整房读取 |
| 148 | 回答每日一问 | bindtap=continueRecommendedQuestion | 待实测 |
| 160 | 回答每日一问：{{currentStoryLabel}} | bindtap=startCurrentStory | 待实测 |
| 180 | {{part}} {{item.title}} {{item.excerpt}} {{item.countLabel}} 继续聊 | bindtap=continueStory; data-id={{item.id}}; data-title={{item.storyTitle}} | 待实测 |
| 213 | 换到{{item.title}} | bindtap=chooseStory; data-title={{item.title}}; data-key={{item.key}} | 通过：选回测试书 |
| 230 | 先随便聊聊，不选故事 | bindtap=chooseNoStory | 通过 |
| 243 | 开一个新故事 | bindtap=startNewStory | 通过：新建表单及取消 |

## pages/me/me

| 行 | 操作/文案 | 绑定与分支 | 结果 |
| ---: | --- | --- | --- |
| 63 | {{item.avatarText}} {{item.roomName}} 以“{{item.memberName}}”的身份加入 · {{item.relation}} › | bindtap=openJoinedRoom; data-id={{item.familyId}} | 待实测 |
| 77 | 家 {{roomName &#124;&#124; "我的拾光房间"}} {{protagonistName ? "主人公 " + protagonistName : "还没有写主人公的名字"}} › | bindtap=startEditRoom | 通过：编辑入口/取消 |
| 85 | 忆 所有记忆 写没写进书的都在这里 › | bindtap=openArchive | 通过：记忆列表及编辑 |
| 93 | 人 家人和朋友 拉人进来，每个人的权限写在名字旁边 › | bindtap=openProfiles | 通过：人物管理入口 |
| 101 | 家 记忆之家 查看亲友共享的记忆 › | bindtap=openFamilyHome | 通过：记忆之家入口 |
| 109 | 照 云端照片 {{cloudPhotoCount}} 张 · {{cloudPhotoBytes}} 还有 {{pendingPhotoCount}} 张没存到云端 {{checkingPhot… | bindtap=deleteCloudPhotos | 仅确认/取消；未删除 |
| 123 | 铃 家人生日提醒 后续版本接入 › | bindtap=notYet | 已点：明确提示后续版本 |
| 135 | 屏 在电脑上继续 选择微信故事，生成一次性电脑登录码 › | bindtap=openAccountLink | 通过：登录码列表入口 |
| 136 | 称 修改个人信息 称呼与一个字头像 › | bindtap=editAccountProfile | 通过：编辑入口/取消 |
| 141 | 忆 小忆记住的事 查看、暂停或让小忆忘记 › | bindtap=openPersonalMemory | 已打开：暂停且无记录 |
| 142 | 私 在线 AI 授权 本次允许或关闭文字处理；看照片会另外询问 › | bindtap=configureAiPrivacy | 通过：保留已授权文字处理 |
| 147 | 清 清空当前账号云端档案 删除人物、记忆、书稿和云端照片，无法撤销 › | bindtap=clearCurrentAccountData | 仅确认/取消；未清空 |
| 164 | 取消 | bindtap=cancelEditRoom | 通过 |
| 165 | 保存 | bindtap=saveRoomProfile | 待实测 |
| 179 | 取消 | bindtap=cancelAccountProfile | 通过 |
| 180 | 保存 | bindtap=saveAccountProfile | 待实测 |

## pages/personal-memory/personal-memory

| 行 | 操作/文案 | 绑定与分支 | 结果 |
| ---: | --- | --- | --- |
| 6 | 重新读取 | bindtap=refresh | 待实测 |
| 10 | {{enabled ? '暂停' : '开启'}} | bindtap=toggleEnabled | 未测：当前为暂停/无理解记录，未改变设置 |
| 25 | 说得对 | bindtap=confirmInsight; data-key={{item.lineageKey}} | 未测：当前为暂停/无理解记录，未改变设置 |
| 26 | 不对 | bindtap=correct; data-key={{item.lineageKey}} | 未测：当前为暂停/无理解记录，未改变设置 |
| 27 | 忘掉 | bindtap=forget; data-key={{item.lineageKey}} | 未测：当前为暂停/无理解记录，未改变设置 |

## pages/account-link/account-link

| 行 | 操作/文案 | 绑定与分支 | 结果 |
| ---: | --- | --- | --- |
| 7 | 复制登录码 | bindtap=copyCode | 未测：未创建登录凭证 |
| 11 | {{item.title}} {{item.detail}} {{item.excerpt}} 生成电脑码 › | bindtap=choose; data-key={{item.key}}; data-title={{item.title}} | 修复后通过：显示确认/取消；未生成凭证 |
| 14 | {{loadError}} | bindtap=refresh | 待实测 |

## pages/profiles/profiles

| 行 | 操作/文案 | 绑定与分支 | 结果 |
| ---: | --- | --- | --- |
| 13 | 重新加载 | bindtap=retryLoad | 待实测 |
| 18 | 创建并切换到这本书 | bindtap=createBook | 待实测 |
| 26 | 重新加载 | bindtap=retryLoad | 待实测 |
| 32 | 加进来 | bindtap=addPerson | 通过空姓名校验；未添加人物 |
| 60 | 保存 | bindtap=saveEdit | 待实测 |
| 61 | 取消 | bindtap=cancelEdit | 通过 |
| 64 | 编辑{{item.name}} | bindtap=startEdit; data-id={{item.id}} | 通过：已有测试人物 |
| 65 | 删除{{item.name}} | bindtap=removeMember; data-id={{item.id}} | 仅确认/取消；确认前整房读取较慢 |
| 83 | 最近删除 · {{trash.length}} {{trashOpen ? '收起' : '展开'}} | bindtap=toggleTrash | 待实测 |
| 93 | 恢复 | bindtap=restoreMember; data-id={{item.id}} | 待实测 |
| 99 | 清空当前账号数据 | bindtap=clearCurrentFamilyData | 仅确认/取消；未清空 |

## pages/archive/archive

| 行 | 操作/文案 | 绑定与分支 | 结果 |
| ---: | --- | --- | --- |
| 9 | 重新加载 | bindtap=retryLoad | 待实测 |
| 11 | 查看《{{item.bookTitle}}》· {{item.chapter}} | bindtap=openPlacement; data-member={{item.memberId}}; data-chapter={{item.chapterId}} | 待实测 |
| 18 | 小忆 | bindtap=openXiaoyi | 通过：展开 |
| 28 | 关掉 | bindtap=closeXiaoyi | 通过：关闭 |
| 31 | 问我一个问题 | bindtap=askXiaoyiQuestion; data-mode=ask | 待实测 |
| 32 | 帮我写一下 | bindtap=askXiaoyiQuestion; data-mode=write | 通过：真实提问 |
| 44 | 就用我的原话 | bindtap=useXiaoyiOriginal | 通过空输入提示；有内容使用未测 |
| 45 | {{xiaoyiLoading ? '小忆正在处理…' : '请小忆整理'}} | bindtap=organizeXiaoyiAnswer | 通过：真实整理13321ms并结束动画 |
| 50 | 接到记忆后面 | bindtap=useXiaoyiDraft | 通过：追加→保存→重开 |
| 54 | {{showOriginal ? '收起原话' : '查看原话'}} | bindtap=toggleOriginal | 通过：展开/收起 |
| 55 | 撤回到原话 | bindtap=revertToSpoken | 仅确认/取消；未恢复旧原话 |
| 56 | {{showHistory ? '收起修改历史' : '查看修改历史'}} | bindtap=toggleHistory | 通过：展开/收起 |
| 68 | 暂不归类{{!editStory ? '，已选中' : ''}} | bindtap=chooseEditStory; data-title= | 通过：临时选择后选回 |
| 72 | {{item}}{{editStory === item ? '，已选中' : ''}} | bindtap=chooseEditStory; data-title={{item}} | 通过：选回原测试分组 |
| 78 | {{savingEdit ? '正在保存' : '保存修改'}} | bindtap=saveEdit | 通过：真实保存、重开及清理 |
| 79 | 整理进书，预览后写入 | bindtap=organizeIntoBook | 通过：进入已有章节插入流程 |
| 86 | 返回记忆列表 | bindtap=closeEditor | 通过：返回后重新打开 |
| 90 | 选择记忆，整理进书 | bindtap=organizeIntoBook | 待实测 |
| 95 | 删除{{item.title}} | bindtap=deleteMemory; data-id={{item.id}}; data-title={{item.title}} | 通过：仅本次虚构续聊片段移入最近删除，列表回到原数量 |
| 96 | 编辑{{item.title}} | bindtouchstart=onNoteTouchStart; bindtouchend=onNoteTouchEnd; bindtap=openMemory; data-id={{item.id}} | 待实测 |
| 110 | 删除{{item.title}} | bindtap=deleteMemory; data-id={{item.id}}; data-title={{item.title}} | 通过：仅本次虚构续聊片段移入最近删除，列表回到原数量 |
| 111 | 编辑{{item.title}} | bindtouchstart=onNoteTouchStart; bindtouchend=onNoteTouchEnd; bindtap=openMemory; data-id={{item.id}} | 通过：真实编辑；快速打开修复后无新增云请求 |
| 124 | 记录一段记忆 | bindtap=startRecording | 通过：进入新记忆录入 |

## pages/stories/stories

| 行 | 操作/文案 | 绑定与分支 | 结果 |
| ---: | --- | --- | --- |
| 7 | 重新加载 | bindtap=retryLoad | 待实测 |
| 10 | 打开整理好的章节 翻开目录，继续读写 › | bindtap=openSelectedManuscript | 通过：从故事详情打开测试书 |
| 15 | 继续讲这个故事 从新的记忆接着说 › | bindtap=continueStory | 待实测 |
| 20 | 返回所有故事 回到人生之书 | bindtap=backToStories | 待实测 |
| 24 | 删除这个故事 | bindtap=deleteSelectedStory | 仅确认/取消；未删除故事 |
| 27 | {{item.title &#124;&#124; '一段记忆'}} {{item.aiLabel}} {{item.text}} 点开编辑或调整归类 | bindtap=editMemory; data-id={{item.id}} | 待实测 |
| 37 | 打开故事：{{item.title}}，{{item.label}} | bindtap=openStory; data-key={{item.key}} | 通过：测试故事详情；修复后无新增 room.load |
| 45 | 创建新故事书 | bindtap=openCreate | 待实测 |
| 50 | 整理记忆，{{ungroupedCount}} 段还没放进故事 | bindtap=openMemories | 通过：打开记忆档案并核对恢复片段 |
| 58 | 新建一本故事书 | bindtap=openCreate | 通过：修复后打开表单无新增云读取 |
| 59 | 待确认的旧内容 {{pendingMigrationCount}} 项需要确认去向 › | bindtap=openMigration | 通过：迁移页及章节确认/取消 |
| 63 | 最近删除{{deletedItems.length ? ' · ' + deletedItems.length : ''}} | bindtap=openTrash | 通过：打开并核对本轮测试片段 |
| 68 | view | bindtap=closeCreate | 待实测 |
| 69 | 新建一本故事书 | bindtap=closeCreate | 待实测 |
| 70 | 新建一本故事书 客观记录 AI 共创 可以空白开始，也可选记忆作为这本书的素材。 {{item.title &#124;&#124; item.text}} 创建并打开 取消 | catchtap=keepCreateOpen | 待实测 |
| 73 | 客观记录 AI 共创 | bindchange=onCreateMode | 通过：客观记录/AI共创切换并选回 |
| 79 | {{item.title &#124;&#124; item.text}} | bindchange=onCreateMemories | 待实测 |
| 86 | 创建并打开 | bindtap=createBook | 通过空名称提示；未新建故事 |
| 87 | 取消 | bindtap=closeCreate | 通过：关闭新建面板 |
| 91 | view | bindtap=closeTrash | 待实测 |
| 92 | 最近删除，点空白处关闭 | bindtap=closeTrash | 待实测 |
| 93 | 最近删除 删掉的故事和记忆都在这里，恢复后原样回来。永久删除后就找不回来了。 {{item.title}} {{item.deletedLabel}} 永久删除 恢复 这里是空的。 清空已删除的… | catchtap=keepTrashOpen | 待实测 |
| 102 | 永久删除 | bindtap=purgeItem; data-id={{item.id}}; data-title={{item.title}} | 仅确认/取消；未永久删除 |
| 103 | 恢复 | bindtap=restoreItem; data-type={{item.type}}; data-id={{item.id}} | 通过：仅恢复本轮虚构片段，核对后再次移入最近删除 |
| 107 | 清空已删除的记忆 · {{deletedMemoryCount}} | bindtap=purgeAll | 仅确认/取消；未清空 |
| 108 | 关闭 | bindtap=closeTrash | 通过：关闭回收站面板 |

## pages/story-migration/story-migration

| 行 | 操作/文案 | 绑定与分支 | 结果 |
| ---: | --- | --- | --- |
| 11 | 《{{story.bookTitle &#124;&#124; story.title}}》 · {{story.writingMode === 'creative' ? 'AI 共创' : '… | bindtap=assign; data-pending={{item.id}}; data-story={{story.id}} | 仅章节归属确认/取消；原内容未迁移 |
| 16 | 新建客观记录故事并放入 | bindtap=createNew; data-pending={{item.id}} | 通过空名称校验；未创建故事 |
| 24 | 《{{story.bookTitle &#124;&#124; story.title}}》 · {{story.writingMode === 'creative' ? 'AI 共创' : '… | bindtap=assignAsset; data-pending={{asset.id}}; data-story={{story.id}} | 待实测 |
| 29 | 新建客观记录故事并放入 | bindtap=createNewAsset; data-pending={{asset.id}} | 待实测 |

## pages/recall/recall

| 行 | 操作/文案 | 绑定与分支 | 结果 |
| ---: | --- | --- | --- |
| 9 | 重新加载 | bindtap=retryLoad | 待实测 |
| 13 | 接着聊{{item.title}} | bindtap=continueMemory; data-id={{item.id}}; data-title={{item.storyTitle}}; data-story={{item.storyId}}; data-choice={{item.needsStoryChoice}} | 通过：虚构测试记忆进入续聊；多书选择分支未测 |
| 37 | 随手记一段 | bindtap=startQuickNote | 待实测 |

## pages/interview/interview

| 行 | 操作/文案 | 绑定与分支 | 结果 |
| ---: | --- | --- | --- |
| 37 | 选择随手记，先留下几句话 | bindtap=chooseType; data-type=note | 待实测 |
| 55 | 选择回忆录，和小忆多聊几轮 | bindtap=chooseType; data-type=memoir | 待实测 |
| 74 | {{memoryType === 'note' ? '开始随手记' : '开始聊回忆'}} → | bindtap=beginInterview | 待实测 |
| 147 | {{asking ? '小忆正在回应' : '发送'}} | bindtap=send | 通过：空输入提示、真实虚构回答→真实追问；输入只出现一次 |
| 154 | {{importing ? '正在导入…' : '导入'}} | bindtap=importMemory | 通过：照片/聊天文件选择器打开及取消；未上传文件 |
| 156 | {{organizing ? '正在整理…' : asking ? '小忆正在回应…' : '整理成片段'}} | bindtap=finish | 通过：真实整理15855ms，进入保存页；此为旧云端提示结果 |
| 178 | {{importAiLoading ? '正在看…' : '让 AI 看看照片'}} | bindtap=generateImportCaption | 待实测 |
| 181 | 取消 | bindtap=cancelPhotoImport | 待实测 |
| 182 | {{importing ? '正在保存…' : (importCaption ? '保存' : '跳过并保存')}} | bindtap=savePhotoImport | 待实测 |
| 194 | 继续选择章节 | bindtap=continueToChapter | 待实测 |
| 195 | 查看这段记忆 | bindtap=viewSavedMemory | 通过：保存后重开，70字测试正文完整 |
| 196 | 返回 | bindtap=leaveSavedMemory | 待实测 |
| 246 | 小忆 | bindtap=openXiaoyi | 通过：保存页打开 |
| 260 | 关掉 | bindtap=closeXiaoyi | 通过：整理完成后关闭 |
| 263 | 问我一个问题 | bindtap=askXiaoyiQuestion; data-mode=ask | 待实测 |
| 264 | 帮我写一下 | bindtap=askXiaoyiQuestion; data-mode=write | 待实测 |
| 276 | 就用我的原话 | bindtap=useXiaoyiOriginal | 待实测 |
| 277 | {{xiaoyiLoading ? '小忆正在处理…' : '请小忆整理'}} | bindtap=organizeXiaoyiAnswer | 通过：空输入提示；未先提问直接真实整理8970ms |
| 282 | 接到草稿后面 | bindtap=useXiaoyiDraft | 通过：接到草稿后面，保存并重开确认 |
| 290 | 片 先存为未整理片段 以后想清楚了，再把它放进某个故事 {{storyTitle === '' ? '✓' : ''}} | bindtap=chooseFragment | 通过：改存未整理片段 |
| 303 | {{item.title}} · {{item.chapterCount ? item.chapterCount + '章 · ' : ''}}{{item.count}}段记忆 | bindtap=chooseStory; data-key={{item.key}} | 待实测 |
| 326 | {{item.avatarText}} {{item.name}} {{item.relation}} {{item.selected ? '✓' : ''}} | bindtap=toggleRelatedMember; data-id={{item.id}} | 通过：选择自己再取消；未关联其他人物 |
| 347 | 私 仅自己 暂时不分享给任何人 {{audienceMemberIds.length === 0 ? '✓' : ''}} | bindtap=choosePrivate | 通过：保持仅自己；未扩大共享范围 |
| 360 | {{item.avatarText}} {{item.name}} {{item.relation}} · 可阅读 {{item.selected ? '✓' : ''}} | bindtap=toggleAudienceMember; data-id={{item.id}} | 待实测 |
| 384 | 继续编辑 | bindtap=backToChat | 待实测 |
| 385 | {{saving ? '正在保存…' : (sharedFamilyId ? '提交给主人确认' : selectedStoryKey ? '保存并选择章节' : '保存这段记忆')}} | bindtap=save | 通过：仅自己保存片段、重开核对；本轮未再入书 |

## pages/invite/invite

| 行 | 操作/文案 | 绑定与分支 | 结果 |
| ---: | --- | --- | --- |
| 44 | 生成邀请图片 | bindtap=createInvitation | 通过：空称呼/缺关系立即提示；未创建邀请 |
| 50 | image | bindtap=previewPoster | 待实测 |
| 52 | 发送邀请图片 | bindtap=sharePoster | 待实测 |
| 53 | {{albumSaving ? '保存中…' : '保存邀请图片到相册'}} | bindtap=savePoster | 待实测 |
| 54 | 也可以直接转发小程序 | open-type=share | 待实测 |
| 75 | {{invitation.acceptedByMe ? '进入记忆之家' : '接受邀请，一起写'}} | bindtap=acceptInvitation | 待实测 |

## pages/room/room

| 行 | 操作/文案 | 绑定与分支 | 结果 |
| ---: | --- | --- | --- |
| 4 | 人员管理 · 可删除 | bindtap=openPeople | 待实测 |
| 5 | ＋ 邀请亲友一起写 生成一张邀请图片，发给微信好友 › | bindtap=inviteFamilyMember | 通过：打开邀请表单 |
| 13 | 重新加载 | bindtap=retryLoad | 待实测 |
| 18 | 看和{{item.name}}有关的记忆 | bindtap=choosePerson; data-id={{item.id}} | 通过：亲友空态及自己12条；修复后无新云请求 |
| 38 | {{part}} {{item.title}} {{item.text}} {{item.aiLabel}} 故 {{item.storyLabel}} {{item.placeLabel}} | bindtap=openMemory; data-id={{item.id}} | 点击未确认导航，待滚动到可见位置复测 |
| 63 | 开始聊聊 | bindtap=startInterview | 待实测 |

## pages/review/review

| 行 | 操作/文案 | 绑定与分支 | 结果 |
| ---: | --- | --- | --- |
| 12 | 回到记忆之家 | bindtap=goBack | 待实测 |
| 46 | {{focus.confirmLabel}} | bindtap=reviewMemory; data-status=confirmed | 待实测 |
| 49 | 大致是，但有出入 | bindtap=reviewMemory; data-status=conflict | 待实测 |
| 52 | 不是这样 | bindtap=reviewMemory; data-status=rejected | 待实测 |
| 85 | 回记忆之家看看 | bindtap=goToMemoryHome | 待实测 |
| 86 | 先回去 | bindtap=goBack | 待实测 |

## pages/book/book

| 行 | 操作/文案 | 绑定与分支 | 结果 |
| ---: | --- | --- | --- |
| 3 | {{view === 'chapter' ? '目录' : '返回'}} | bindtap=onBack | 通过：目录/返回 |
| 4 | {{pickingPhoto ? '添加中' : '照片'}} ⌄ | bindtap=togglePhotoMenu | 通过：照片菜单 |
| 5 | {{refreshingStoryImage ? '准备插图' : '插入插图'}} | catchtouchstart=placeSelectedStoryImage | 通过：新插图插入保存重开 |
| 6 | {{preparingSend ? '准备中' : '发送'}} ⌄ | bindtap=toggleSend | 通过：目录发送菜单 |
| 7 | 发给家人 | catchtouchstart=openShareSelection | 待实测 |
| 8 | 补充经历 | bindtap=openAppendOwn | 待实测 |
| 9 | {{returningOwn ? '发送中' : '发回原作者'}} | bindtap=returnOwnExperience | 待实测 |
| 10 | {{saving ? '保存中' : '保存'}} | bindtap=saveEdits | 通过：保存后重开及插图清理 |
| 11 | 更多 | bindtap=showMore | 通过：更多菜单 |
| 13 | 收起照片菜单 | bindtap=closePhotoMenu | 待实测 |
| 16 | 图片导入 › | bindtap=choosePhotoAction; data-action=import | 待实测 |
| 17 | 图片生成 › | bindtap=showPhotoGeneration | 通过：生成子菜单 |
| 20 | ‹ 返回照片菜单 | bindtap=togglePhotoMenu | 待实测 |
| 21 | 生成插图 › | bindtap=choosePhotoAction; data-action=illustration | 通过：进入并真实生成插图 |
| 22 | 生成底图 › | bindtap=choosePhotoAction; data-action=backdrop | 待实测 |
| 23 | 生成封面 › | bindtap=choosePhotoAction; data-action=cover | 通过：封面页及取消 |
| 28 | {{item.label}} · {{item.title &#124;&#124; '还没起名字'}} › | bindtap=choosePhotoChapter; data-id={{item.id}} | 待实测 |
| 33 | 收起发送菜单 | bindtap=closeSend | 待实测 |
| 35 | 发送给家人 › | bindtap=chooseSend; data-destination=family | 通过入口；亲友邀请云开关未开放 |
| 36 | 发送到社交媒体 › | bindtap=chooseSend; data-destination=social | 通过：图文导出页面 |
| 39 | 亲友阅读与权限 | bindtap=selectTool; data-action=invite | 待实测 |
| 40 | 制作公开故事卡 | bindtap=selectTool; data-action=share-card | 通过入口；云端提示故事卡片尚未开放 |
| 41 | 历史版本 | bindtap=selectTool; data-action=history | 待实测 |
| 42 | 复制当前正文 | bindtap=selectTool; data-action=copy-draft | 待实测 |
| 43 | 放弃修改 | bindtap=selectTool; data-action=discard | 待实测 |
| 45 | 本章记忆 | bindtap=selectTool; data-action=memories | 通过：查看本章来源 |
| 46 | 上移本章 | bindtap=selectTool; data-action=up | 通过：单章上移边界 |
| 47 | 下移本章 | bindtap=selectTool; data-action=down | 待实测 |
| 48 | 删除本章 | bindtap=selectTool; data-action=delete-chapter | 待实测 |
| 49 | 历史版本 | bindtap=selectTool; data-action=history | 通过：历史列表 |
| 50 | AI 整理 | bindtap=selectTool; data-action=generate | 通过：章节更多→整理→预览→双击确认→撤回重开 |
| 51 | 给本章配图 | bindtap=selectTool; data-action=images | 待实测 |
| 52 | 制作有声书 | bindtap=selectTool; data-action=audio | 通过：有声书创建页、官方声音选择；未提交制作 |
| 55 | 切换写作模式 | bindtap=selectTool; data-action=mode | 待实测 |
| 56 | 新开一章 | bindtap=selectTool; data-action=new-chapter | 待实测 |
| 57 | 历史版本 | bindtap=selectTool; data-action=history | 待实测 |
| 58 | 命名存档 | bindtap=selectTool; data-action=version | 待实测 |
| 59 | AI 整理 | bindtap=selectTool; data-action=generate | 待实测 |
| 60 | 原始记忆 | bindtap=selectTool; data-action=sources | 待实测 |
| 61 | 这本书的图 | bindtap=selectTool; data-action=images | 待实测 |
| 62 | 记录经历 | bindtap=selectTool; data-action=record | 待实测 |
| 67 | 重新加载 | bindtap=retryLoad | 待实测 |
| 69 | 撤回这次整理 | bindtap=undoOrganize | 通过：两轮撤回均重开核对，仅剩基线 |
| 72 | {{view === 'chapter' ? '回到正文' : '回到目录'}} | bindtap=closePanel | 通过：来源/历史返回；其他面板未穷尽 |
| 73 | 恢复此版 | bindtap=restoreVersion | 待实测 |
| 74 | 存为版本 | bindtap=saveVersion | 待实测 |
| 75 | {{sharingExcerpt ? '发送中…' : '确认发送'}} | bindtap=sendExcerpt | 待实测 |
| 76 | {{appendingOwn ? '保存中…' : '保存我的补充'}} | bindtap=appendOwnExperience | 待实测 |
| 94 | {{item.label}} {{item.title &#124;&#124; '还没起名字'}} {{item.memoryCount}} 段记忆 · {{item.photoCount}}… | bindtap=openChapter; data-id={{item.id}} | 通过：第一章 |
| 102 | 新开一章 | bindtap=selectTool; data-action=new-chapter | 待实测 |
| 112 | 放进哪一章 › | bindtap=chooseChapterFor; data-id={{item.id}} | 待实测 |
| 135 | 小忆 | catchtouchstart=openXiaoyi | 通过：展开 |
| 145 | 收下 | bindtap=decidePendingEdit; data-id={{item.id}}; data-decision=accept | 待实测 |
| 146 | 不要 | bindtap=decidePendingEdit; data-id={{item.id}}; data-decision=reject | 通过：拒绝待确认文字 |
| 149 | 把已收下的写入正文 | bindtap=finishPendingEdits | 通过：拒绝分支完成选择；本轮接受分支未测 |
| 157 | 关掉 | bindtap=closeXiaoyi | 通过 |
| 160 | 问我一个问题 | bindtap=askXiaoyiQuestion; data-mode=ask | 通过：真实提问 |
| 161 | 帮我写一下 | bindtap=askXiaoyiQuestion; data-mode=write | 待实测 |
| 162 | 看看这一章的记忆 | bindtap=openXiaoyiMemories | 待实测 |
| 174 | 就用我的原话 | bindtap=useXiaoyiOriginal | 待实测 |
| 175 | {{xiaoyiLoading ? '小忆正在处理…' : '请小忆整理'}} | bindtap=organizeXiaoyiAnswer | 通过：真实整理9921ms并结束动画 |
| 180 | 把这段放进正文待确认 | bindtap=useXiaoyiDraft | 通过：放入待确认，原文未改 |
| 195 | {{item.name}} {{item.relation}} | bindchange=onShareRecipients | 待实测 |
| 212 | {{item.label}} {{item.savedAt}} | bindtap=previewHistory; data-id={{item.id}} | 通过：当前版本预览 |
| 227 | {{item.title}} {{item.detail}} | bindchange=onOrganizeBook | 待实测 |
| 230 | {{item.text}} {{item.where}} | bindchange=onOrganizeMemories | 待实测 |
| 239 | {{item.label}}{{item.title ? ' ' + item.title : ''}} 新开一章 | bindchange=onOrganizeTarget | 待实测 |
| 253 | 保留原文，插入这段记忆 让 AI 结合本章重新衔接 | bindchange=onOrganizeMethod | 待实测 |
| 257 | 插入位置：{{insertionPoints[insertionIndex].label}} ⌄ | bindchange=onInsertionPoint | 待实测 |
| 285 | 空白的一章 自己写，或之后把记忆放进来 | bindtap=createChapter; data-story= | 待实测 |
| 288 | 用故事「{{item.title}}」开一章 这个故事的 {{item.count}} 条记忆原文会加入正文 | bindtap=createChapter; data-story={{item.title}} | 待实测 |
| 294 | {{item.label}}{{item.title ? ' ' + item.title : ''}} | bindtap=assignTo; data-id={{item.id}} | 待实测 |
| 297 | 新开一章放它 | bindtap=assignTo; data-id=new | 待实测 |
| 308 | 移出 | bindtap=removeFromChapter; data-id={{item.id}} | 待实测 |
| 317 | 放进本章 | bindtap=addToChapter; data-id={{item.id}} | 待实测 |
| 327 | 新开第一章 | bindtap=selectTool; data-action=new-chapter | 待实测 |
| 332 | 暂不整理 | bindtap=closePanel | 待实测 |
| 333 | {{switchingBook ? '正在切换…' : generating ? '正在整理…' : '下一步：预览正文'}} | bindtap=runOrganize | 通过：已有章原文保留插入预览 |
| 334 | {{saving ? '正在写入…' : '确认写入正文'}} | bindtap=confirmOrganize | 通过：双击后立即禁用，只写入一次；重开及撤回清理通过 |

## pages/story-images/story-images

| 行 | 操作/文案 | 绑定与分支 | 结果 |
| ---: | --- | --- | --- |
| 10 | 重新加载 | bindtap=retryLoad | 待实测 |
| 21 | {{submitting === group.id + ':illustration' ? '提交中' : '配一张插图'}} | bindtap=generate; data-id={{group.id}}; data-purpose=illustration | 通过：真实生成/完成动画 |
| 24 | {{submitting === group.id + ':backdrop' ? '提交中' : '配一张底图'}} | bindtap=generate; data-id={{group.id}}; data-purpose=backdrop | 待实测 |
| 32 | 不用了 | bindtap=setBackdrop; data-chapter={{group.id}}; data-image= | 待实测 |
| 42 | 查看大图 | bindtap=previewImage; data-url={{image.url}} | 通过：新图大图预览/关闭 |
| 51 | {{submitting === group.id + ':illustration:' + image.imageId ? '提交中' : '参考这张再画'}} | bindtap=generate; data-id={{group.id}}; data-purpose=illustration; data-reference={{image.imageId}} | 待实测 |
| 54 | {{image.inText ? '已在正文中' : '选用这张插图'}} | bindtap=insertIntoBook; data-id={{image.imageId}}; data-chapter={{group.id}}; data-url={{image.url}} | 通过：选择→插入→保存重开 |
| 57 | 设为本章底图 | bindtap=setBackdrop; data-chapter={{group.id}}; data-image={{image.imageId}} | 待实测 |
| 60 | 不用了 | bindtap=setBackdrop; data-chapter={{group.id}}; data-image= | 待实测 |
| 63 | 删除 | bindtap=remove; data-id={{image.imageId}} | 待实测 |
| 76 | 查看大图 | bindtap=previewImage; data-url={{image.url}} | 待实测 |
| 83 | 删除 | bindtap=remove; data-id={{image.imageId}} | 待实测 |

## pages/story-cover/story-cover

| 行 | 操作/文案 | 绑定与分支 | 结果 |
| ---: | --- | --- | --- |
| 6 | 重新加载 | bindtap=retry | 待实测 |
| 12 | {{item.selected ? '取消选择' : '选择'}}{{item.kind === 'photo' ? '照片' : '插图'}}作为封面参考 | bindtap=toggleReference; data-id={{item.id}} | 通过：选择参考再取消 |
| 21 | {{submitting ? '正在构思封面' : '生成一张封面'}} | bindtap=generate | 通过确认/取消；取消后即时恢复，无额外读取；未生成新封面 |
| 31 | 查看封面大图 | bindtap=preview; data-url={{item.url}} | 通过：已有封面预览/关闭 |
| 34 | {{item.selected ? '已是封面' : (!item.ready ? '等待审核' : '设为封面')}} | bindtap=choose; data-id={{item.imageId}} | 待实测 |
| 37 | 恢复纸本封面 | bindtap=choose; data-id= | 待实测 |

## packages/story-sharing/pages/invite/index

| 行 | 操作/文案 | 绑定与分支 | 结果 |
| ---: | --- | --- | --- |
| 11 | {{item.title &#124;&#124; '未命名章节'}} | bindchange=chooseChapters | 不可达：亲友邀请云开关未开放 |
| 17 | switch | bindchange=chooseEdit | 不可达：亲友邀请云开关未开放 |
| 19 | switch | bindchange=chooseCopy | 不可达：亲友邀请云开关未开放 |
| 20 | switch | bindchange=chooseForward | 不可达：亲友邀请云开关未开放 |
| 23 | 生成阅读邀请 | bindtap=create | 不可达：亲友邀请云开关未开放 |
| 24 | 把邀请发给亲友 | open-type=share | 不可达：亲友邀请云开关未开放 |
| 31 | 不收 | bindtap=decideReturn; data-return-id={{memory.returnId}}; data-decision=reject | 不可达：亲友邀请云开关未开放 |
| 32 | 收进原故事 | bindtap=decideReturn; data-return-id={{memory.returnId}}; data-decision=accept | 不可达：亲友邀请云开关未开放 |
| 38 | 撤销 | bindtap=revoke; data-invitation-id={{inv.invitationId}} | 不可达：亲友邀请云开关未开放 |
| 44 | 拒绝 | bindtap=decide; data-invitation-id={{inv.invitationId}}; data-applicant-id={{person.applicantId}}; data-decision=reject | 不可达：亲友邀请云开关未开放 |
| 45 | 核对并允许 | bindtap=decide; data-invitation-id={{inv.invitationId}}; data-applicant-id={{person.applicantId}}; data-decision=approve | 不可达：亲友邀请云开关未开放 |
| 52 | 申请阅读 | bindtap=apply | 不可达：亲友邀请云开关未开放 |
| 54 | 阅读获准的章节 | bindtap=openStory | 不可达：亲友邀请云开关未开放 |
| 56 | {{loading ? '正在刷新…' : '刷新状态'}} | bindtap=refresh | 通过：刷新后显示云端未开放 |

## packages/story-sharing/pages/read/index

| 行 | 操作/文案 | 绑定与分支 | 结果 |
| ---: | --- | --- | --- |
| 11 | 稍后再写 | bindtap=cancelEdit | 不可达：没有已授权邀请，未扩大权限 |
| 11 | 保存修改 | bindtap=saveEdit | 不可达：没有已授权邀请，未扩大权限 |
| 16 | 编辑这一章 | bindtap=beginEdit; data-id={{chapter.id}} | 不可达：没有已授权邀请，未扩大权限 |
| 19 | 放进我的故事里 | bindtap=receiveCopy | 不可达：没有已授权邀请，未扩大权限 |
| 20 | 申请再邀请一位亲友 | bindtap=createInvitation | 不可达：没有已授权邀请，未扩大权限 |
| 21 | 发送新的阅读邀请 | open-type=share | 不可达：没有已授权邀请，未扩大权限 |
| 22 | 重新核对并刷新 | bindtap=refresh | 不可达：没有已授权邀请，未扩大权限 |

## packages/story-sharing/pages/receive/index

| 行 | 操作/文案 | 绑定与分支 | 结果 |
| ---: | --- | --- | --- |
| 10 | {{item.title &#124;&#124; '未命名章节'}} | bindchange=chooseChapters | 不可达：没有已授权邀请，未扩大权限 |
| 14 | 新建一本自己的故事 加入已有故事 | bindchange=chooseMode | 不可达：没有已授权邀请，未扩大权限 |
| 19 | {{selectedTargetTitle &#124;&#124; '选择已有故事'}} › | bindchange=chooseTarget | 不可达：没有已授权邀请，未扩大权限 |
| 21 | 确认放进我的故事 | bindtap=receive | 不可达：没有已授权邀请，未扩大权限 |

## packages/story-sharing/pages/card/index

| 行 | 操作/文案 | 绑定与分支 | 结果 |
| ---: | --- | --- | --- |
| 6 | {{item.title &#124;&#124; '未命名章节'}} | bindchange=chooseChapter | 不可达：云端提示故事卡片尚未开放，未改变开关 |
| 9 | {{block.preview}} 照片 没有公开发布许可 | bindchange=chooseBlocks | 不可达：云端提示故事卡片尚未开放，未改变开关 |
| 15 | {{busy ? '正在生成…' : '预览故事卡'}} | bindtap=preview | 不可达：云端提示故事卡片尚未开放，未改变开关 |
| 18 | 重新核对并保存到相册 | bindtap=save | 不可达：云端提示故事卡片尚未开放，未改变开关 |

## packages/story-sharing/pages/social/index

| 行 | 操作/文案 | 绑定与分支 | 结果 |
| ---: | --- | --- | --- |
| 14 | 整本书 | bindtap=chooseScope; data-scope=book | 通过：整本书预览导出 |
| 15 | 选择章节 | bindtap=chooseScope; data-scope=chapters | 通过：切换章节范围 |
| 16 | 选择文字 | bindtap=chooseScope; data-scope=text | 通过：切换文字范围 |
| 19 | {{item.title}} {{item.characterCount}} 字 | bindchange=chooseChapters | 通过：勾选章节 |
| 23 | {{chapters[textChapterIndex].title &#124;&#124; '暂无章节'}} ⌄ | bindchange=chooseTextChapter | 待实测 |
| 26 | 使用选中文字 | catchtouchstart=captureSelection | 通过：未选提示、拖选四字抓取 |
| 30 | {{checking ? '正在核对书稿' : '预览所选内容'}} | bindtap=previewSelection | 通过：整书/四字预览 |
| 33 | 重新选择 | bindtap=backToSelection | 通过 |
| 37 | 先制作 AI 封面 | bindtap=makeCover | 待实测 |
| 40 | 分页图片 | bindtap=chooseLayout; data-layout=pages | 通过：分页/长图，长图真实导出 |
| 40 | 一张长图 | bindtap=chooseLayout; data-layout=long | 通过：分页/长图，长图真实导出 |
| 41 | 字号：{{fontSize === 28 ? '紧凑' : fontSize === 32 ? '标准' : '大字'}} ⌄ | bindchange=chooseFont | 通过：选择大字 |
| 44 | {{exportBusy ? renderProgress : imagePaths.length ? '重新生成图片' : '生成图片预览'}} | bindtap=generateImages | 通过：2张真实导出；新阶段文案及分段指标已复测 |
| 51 | 发这张图片 | bindtap=shareImage; data-index={{index}} | 仅分享菜单/取消；模拟器禁止实际发送 |
| 53 | {{savedIndices.length === imagePaths.length ? '已全部保存' : savedIndices.length ? '继续保存剩余图片' : '保存全部图… | bindtap=saveImages | 通过：电脑原生保存2张；手机权限未测 |
| 58 | 重新选择内容 | bindtap=backToSelection | 通过 |
| 62 | 重新加载 | bindtap=refresh | 待实测 |
| 63 | 回到书稿 | bindtap=goBack | 通过 |

## packages/audio/pages/create/create

| 行 | 操作/文案 | 绑定与分支 | 结果 |
| ---: | --- | --- | --- |
| 8 | 重新确认 | bindtap=refreshCapabilities | 待实测 |
| 13 | {{item.label}} | bindtap=chooseOfficial; data-id={{item.id}}; data-label={{item.label}} | 通过：温柔女声/清晰女声切换 |
| 13 | {{selectedVoice ? '更换声音' : '选择我的声音'}} | bindtap=openVoices | 通过：我的声音页面 |
| 18 | {{creating ? '正在提交…' : canCreate ? '开始制作' : '真实制作暂未开放'}} | bindtap=startCreate | 通过未选声音提示；未提交付费制作 |

## packages/audio/pages/voices/voices

| 行 | 操作/文案 | 绑定与分支 | 结果 |
| ---: | --- | --- | --- |
| 1 | 声音类型（腾讯云创建音色必填） 男声 女声 | bindchange=chooseGender | 通过：男声/女声选择 |
| 1 | 使用这个声音朗读 | bindtap=useVoice | 待实测 |
| 1 | 结束录音 | bindtap=stopRecording | 待实测 |
| 1 | {{uploading ? '正在上传…' : available ? '阅读授权文字并录音' : '暂未开放录音'}} | bindtap=beginRecording | 未测：云开关禁用录制 |
| 1 | 停用这个声音 | bindtap=disableVoice | 待实测 |
| 1 | 删除声音与样本 | bindtap=deleteVoice | 待实测 |

## packages/audio/pages/player/player

| 行 | 操作/文案 | 绑定与分支 | 结果 |
| ---: | --- | --- | --- |
| 5 | {{item.text}} | bindtap=seekLine; data-index={{item.cueIndex}} | 待实测 |
| 11 | A− | bindtap=changeTextSize; data-delta=-0.08 | 待实测 |
| 11 | {{waiting ? '缓冲中' : playing ? '暂停' : '播放'}} | bindtap=togglePlayback | 待实测 |
| 11 | A+ | bindtap=changeTextSize; data-delta=0.08 | 待实测 |
| 11 | {{savingVideo ? '保存中…' : '保存视频到相册'}} | bindtap=saveVideo | 待实测 |

## components/story-switcher/story-switcher

| 行 | 操作/文案 | 绑定与分支 | 结果 |
| ---: | --- | --- | --- |
| 9 | 切换到人生之书，我的故事 | bindtap=openPersonal | 通过：打开人生之书列表 |
| 29 | 记下此刻，记录一段故事 | bindtap=startInterview | 待实测 |
| 49 | 切换到记忆之家，我和亲友的故事 | bindtap=openFamily | 待实测 |
| 70 | 关闭记录方式选择 | bindtap=closeChooser | 待实测 |
| 77 | 选择记录方式，点空白处关闭 | bindtap=closeChooser | 待实测 |
| 91 | 接着聊{{item.title}} | catchtap=continueMemory; data-id={{item.id}}; data-title={{item.storyTitle}} | 待实测 |
| 120 | 从全部回忆里挑一段 | catchtap=openAllMemories | 待实测 |
| 133 | 随手记 回忆录 | catchtap=keepChooserOpen | 待实测 |
| 134 | 随手记，直接开一段新的 | bindtap=startQuickNote | 待实测 |
| 151 | 回忆录，挑一段接着聊 | bindtap=openMemoir | 待实测 |

## 新阶段计时（再次解锁后）

本轮58字、封面1张+正文1张：book.export-preview 3875ms；首次 book.export-material 4384ms；book.export-render 5875ms；最终 book.export-material 6368ms；生成前/后 room.load 3733/3242ms。账号身份调用另在快照读取前后执行，未纳入上述 room.load。不能把这些部分值之和当作精确端到端时间。云端 bookExports 的 material 内部仍包含多次版本/权限读取、内容安全检查和图片签名；未把必要校验删掉。

验收工具注意：只截取页面 Webview 的 AX 文本可能漏掉原生授权弹窗。续聊首轮一度停在文字 AI 授权；已经用截图核实并确认授权，不能把该停留记成模型超时。后续 UI 摘要同时保留原生弹窗区。

## 续聊与保存页补测

从全部回忆选择原有虚构银杏记忆，输入 `【虚构验收1003续聊】`。真实追问成功，思考动画结束、输入只出现一次；授权弹窗停留不计入模型耗时。“整理成片段”真实 ai.organize 15855ms，另有先保存原话的房间读写。保存页小忆未先提问，直接整理 `【虚构验收1003小忆】`，8970ms返回保留虚构标记的短句；追加后70字、选择未整理片段/仅自己保存，再用“查看这段记忆”重开确认。随后只将本次新增片段移入可恢复的最近删除，列表从11条未入书回到10条，原银杏记忆仍在，未写入任何章节。

最后完整检查：类型检查+1071项测试全部通过，日志 `/private/tmp/shiguang-buttons-final-check.log`。189个已跟踪客户端文件逐一比较，预览仅 runtime.ts 的已授权文字AI开关不同。新增短素材提示属于云端变更，尚未部署或真实复测；客户端没有使用模拟AI结果替代验收。
