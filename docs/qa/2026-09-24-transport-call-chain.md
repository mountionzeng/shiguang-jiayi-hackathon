# 响应传输、调用链与真机对照准备

日期：2026-09-24。分支：`codex/miniprogram-performance`；生产源代码仍为 `e2d763a`，上一轮测量记录提交为 `b5f7eb1`。本轮不部署、不修改业务代码或权限开关，只增加诊断工具、测试与记录。

## 结论及证据强度

已确认：秒级等待不只由大响应造成；多个串行云调用会累计放大等待；完整状态携带大量书稿版本内容。尚未分清调用接入/平台排队、网络和开发工具各占多少；尚无真机样本，不能声称手机也有相同耗时或已经提速。

## 小响应与完整状态交替对照

同一微信开发工具账号、同一 `storyBooks` 部署，顺序为 capabilities → state → state → capabilities → capabilities → state，无并发探测。时间截止于云调用 Promise 返回，再做本地统计。平台执行时间按 request ID 从云日志 Report 精确对应：

| 操作 | 客户端 ms | 平台执行 ms | request ID |
|---|---:|---:|---|
| capabilities | 4621 | 5 | `f23abc96-d471-4aab-ac2e-ec7ab90f82fd` |
| state | 3058 | 386 | `2856a851-53b8-41b7-a901-be3ca0c7b430` |
| state | 2770 | 300 | `6b81015c-b9bc-4dff-88ae-65d5feda36ff` |
| capabilities | 1136 | 1 | `40eebc16-bb10-43bc-815e-c499cbdb0a6d` |
| capabilities | 4605 | 1 | `634ec9f8-931c-42f0-9787-c64cc087e2ce` |
| state | 2831 | 219 | `e6092934-6c7f-438e-900a-02d1f1cac731` |

capabilities 返回仅 204 字节，当前 identityVersion=0；读取代码确认此配置下该操作没有 state 的数据库读取。204 字节/服务端 1 ms 的请求仍等了 4605 ms，足以否定「仅大响应下载或仅数据库执行造成数秒等待」；不能据此断言一定是网络或一定是开发工具。

完整 state 三次均 261800 个 JS 字符、627596 个 UTF-8 字节（约 612.9 KiB）。本地 JSON stringify/parse 各 0–1 ms；这是显式二次序列化实验，不是 SDK 内部解码计时。

### 响应内容分布（只记录统计）

| 字段 | UTF-8 字节 | 数量/说明 |
|---|---:|---|
| manuscriptRevisions | 560288 | 23 个版本，占总响应约 89.3% |
| storyMigration | 58851 | 迁移状态及附带结构 |
| contributions | 4194 | 7 条记忆 |
| stories | 3626 | 7 条记录 |
| members | 377 | 3 位成员 |

23 个版本中的 draft 字段合计 540760 字节。当前 story.currentRevisionId 指向其中 2 个版本，两个版本数组共 38600 字节。**这不是可以直接删除另外 21 个版本的依据**：仍须核查旧书稿回退、历史版本、恢复和迁移契约。合适的后续候选是按场景提供轻量读取/按需历史，保留完整历史与权限检查。

### 开发工具 Network 不是原始网络抓包

Network 记录的 URL 是 `wx.cloud.callFunction.storyBooks` 等虚拟调用，state 的 `encodedDataLength` 为 342587，小响应为 344；与显式 JSON 字节数不同，不能直接认定这些就是实际传输字节或推出压缩比。其 DNS/connect 字段几乎固定为 1 ms，SSL 为 -1。

例如 requestTime=1790225150.916 的虚拟记录 receiveHeadersEnd=3380 ms，而同一调用 Promise 为 3058 ms；初版诊断在 Promise 返回后做较重的字节统计，约 322 ms 的差额说明该字段不能当作可信的真实 TTFB 来拆阶段。正式诊断改用线性 UTF-8 计数，并另记 analysisMs。未导出 Network 请求正文、响应正文、请求头或凭据。

## 实际页面调用链

在非编辑状态依次：打开书架 → 选中已存在故事 → 打开书稿目录。通过临时运行时观察器记录固定函数名、动作、页面、开始时间、耗时与请求编号，不记录调用参数或回包。观察器保留原调用参数、原 Promise 和原日志行为，结束后已恢复。

| 页面动作 | 调用 | 客户端 ms | 平台执行 ms |
|---|---|---:|---:|
| 打开书架 | state | 6105 | 477 |
| 选中故事 | state | 4310 | 267 |
| 打开目录 | state | 4858 | 298 |
| 同一次打开目录，在 state 后 | getOpenId | 2951 | 本轮未取 Report |

对应 state request ID：`fbd26bdb-c706-4b51-b308-161fec388952`、`738de812-8d2f-4a93-ae6c-4d55c99f52e6`、`2d9e4f3d-7fb5-45f9-a3b5-8dd5115fa89d`；getOpenId 为 `7f3ced0b-00d8-40c5-8f9c-7c58a70f1bb3`。

三个动作每次都拉完整状态，合计约 1.88 MB 未压缩 JSON；这是三次响应的累计序列化大小，不是网络流量。`stories.onShow → refresh → ensureStoryBooks → loadRoomStateRemoteFirst`，以及 `stories.openStory → refresh`、`book.onShow → refreshBook` 都触发 state。当前迁移已 active，没有观察到 migrate 或业务写命令；但正常 getOpenId 内部可能进行账号关联元数据维护，不能把整个页面链路宣称为数据库零写入。

`book.refresh` 为 7843 ms（目录数据准备完成，不是屏幕首帧），其中 state 4858 ms + 新鲜草稿身份确认 2951 ms；普通列表计算只在 0–1 ms 量级。之后 storyImages.list 1652 ms、两次 photoAccess 4229/4829 ms 并行执行；book.photos 共 4850 ms，不能把并行图片耗时再加到目录准备时间上。

定位代码：`miniprogram/pages/stories/stories.ts` 的 refresh/openStory；`miniprogram/pages/book/book.ts` 的 refreshBook；`miniprogram/services/chapterDraft.ts` 的 chapterDraftScope；`miniprogram/services/cloudRoomStorage.ts` 的 readCloudRoomState。

账号检查不可直接删掉或换全局缓存。自动保存任务确认：本次真实 OPENID/primaryFamilyId 与本次 state 决定 bookId，必须二者齐全才读草稿；失败保留原草稿，旧 refresh 不得覆盖新账号/新输入，sourcePolicyRequired 规则保持。并行二者只是一项待验证方案，须先核查 getOpenId 的账号链接副作用和初始化依赖，本轮未实施。

## 真机对照工具与实际完成范围

新增 `scripts/diagnostics/story-transport-probe.js` 及 `page/` 临时页面，只注册到性能任务临时预览 `/private/tmp/shiguang-performance-preview-pimj_o2v`，不加入生产 app.json。页面提供「开始测量/复制测量结果」，只导出固定统计及运行环境，不含账号标识、书稿内容。失败即停止，离页停止后续请求。新工具的 5 项测试通过：Unicode 字节数、请求顺序/计时边界、隐私白名单、失败停止和取消。

临时页面已实际编译、点击测量、核对完成状态并查看截图，无 console error。页面版六次结果：capabilities 2646/1226/1241 ms，state 1970/1998/2061 ms，响应大小保持相同；state 的统计 analysisMs 为 14/7/8 ms，计在调用耗时之外。这一组用于验证同一真机工具在模拟器可运行，不与前一组做代码提速比较，后端部署没有变化。

运行时实读 `platform=devtools`、`SDKVersion=3.16.3`、`system=iOS 10.0.1`、`wechatVersion=8.0.5`、network=wifi。**其中 iOS 字样是模拟器配置，不是真 iPhone 实测。** 已询问用户可配合的手机类型，当前无真机结果；不启用远程调试伪装手机原生运行，不自行更改网络设置。

后续用同一预览、同一账号，在真机 Wi-Fi 和移动网络各跑一次，复制结果后按 request ID 对应云端 Report。确认字节数/数量相同再比较；记录设备系统、微信/基础库版本和网络。若移动网络明显改善，进一步排查本地网络；若手机两种网络均改善，优先调查开发工具开销；若均慢，再查平台接入/区域链路。三者仍只是排查方向，不是单次对照即可证明的根因。

本机临时证据：`/tmp/shiguang-transport-result.json`、`/tmp/shiguang-call-trace-result.json`、`/tmp/shiguang-network-sanitized.json`、`/tmp/shiguang-diagnostic-page-result.json`、`/tmp/shiguang-transport-diagnostic.jpg`。只保留脱敏统计；不入库用户正文截图。
