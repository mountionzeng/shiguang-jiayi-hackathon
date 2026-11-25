# 手机素材收集：记忆入口交接

2026-10-30。用户确认iPhone和安卓都做，支持现有聊天输入文字、相册/拍照、现场录音及已有录音文件。网页另有系统分享接收，统一依据但不按昵称合并身份。

状态：代码已从 `codex/mobile-material-capture` 工作树接入主仓（17个业务/测试/部署文件），**未commit/push、未部署、未出二维码**。保留主仓原有10份未跟踪计划，未覆盖其他工作。工作树保留未提交修改，不能清理。接入前备份记录在 `/tmp/mobile-capture-mini-integration-path`，临时目录不是长期验收证据。

现有interview聊天里统一收集照片、录音与文字，发送后分步保存/理解/整理为新记忆；不覆盖正在编辑的正文。记忆详情有“查看原素材与整理过程”，按captureId回到原采访入口，超过最近列表仍可直达。原文字、机器转写、AI图片描述、原图片/录音与整理稿分别保留。原语音复刻模块未复用。

服务器按真实accountId/familyId归属和expectedFamilyId校验；同批请求指纹固定、未知模型失败不自动再发；memories/source_records/结果回执同事务。登记录音前验证实际大小和文件头，复制到服务端私有原件路径并保存SHA256，避免客户端覆盖已确认原件。照片receive和commit均核对上传归属。原音频通过本人鉴权拿5分钟URL，不在公共回执泄露fileID。

新增capture动作默认关闭，既有organizeMemory动作保留原行为。启用条件见 `deploy/material-capture/README.md` 与清单的organizeMemory条目；客户端存储、私有集合/索引、服务端原件目录规则必须在真实环境验证。不要将意图说明误当CloudBase可直接部署规则。`MATERIAL_CAPTURE_READY`只能在准备完成后开启。

`npm run check`完整类型/1608项测试通过。录音真实供应商、photoAccess云调用、审核、断网恢复及两手机全过程未测；mock不代表云可用。网页使用既有豆包Key实测遇403极速版资源未授权，备用服务也不可用；须分别核对小程序配置，不能假设共享Key即拥有权限或自动换供应商。

没有使用微信开发者工具验证本次包，因此不提供预览二维码。后续按AGENTS完整流程验收并清理测试数据，再出码/提审。网页对应完整记录：drinking-time-local仓的 `docs/qa/2026-10-30-mobile-material-capture.md`。

## 2026-10-30 随手记入口确认

用户指定首页既有“随手记”纸卡作为素材收集入口。story-switcher 仅添加 capture=1 参数，不增加首页入口；采访页用此标记直接进入收集聊天，支持连续批次，隐藏本模式“整理成片段”和“返回聊天”，附件入口显示“添加素材”。普通采访和共享家庭不改变。

主仓与 mobile-material-capture 工作树已同步这次增量。npm run check：类型检查及 1609 项测试通过（含入口导航和连续发送路由回归；发送测试使用模拟，不代表真实 AI）。未部署、未生成二维码、未做本次真机验收。真实录音转写仍等待供应商权限解决。

## 2026-10-31 交付准备

用户要求继续做到可交付，并请求新版二维码。已真实下载 organizeMemory，下载的业务 JS/JSON 与当前 HEAD 基线逐文件一致（/tmp/capture-release-1031/cloud-before）。本次仅新增 capture 路由及素材处理模块，不覆盖云端独有修复。
修复空批次发送提前锁住输入；服务商录音 401/403 和未配置错误显示具体原因，原件保留、不自动重放。类型及 1611 项测试通过。测试日志 /tmp/capture-release-1031/check.log。真实素材保存、两账号权限和语音转写尚未验收，不能提供二维码。
微信公众平台浏览器访问被站点安全策略阻止，未尝试绕过。已请用户先创建私有 material_captures 集合/索引；存储规则与云端环境变量尚待配置，MATERIAL_CAPTURE_READY 不开启。保持此前录音供应商权限阻塞记录。

## 2026-10-31 后台代配实况（替代上文未部署状态）

用户明确授权代配。通过微信开发者工具独立云控制台完成 material_captures 集合创建，客户端权限为“所有用户不可读写”；联合索引 account_family_created 为 accountId ASC、familyId ASC、createdAtMs DESC，非唯一。已回读界面确认。未绕过公众平台的浏览器站点限制。

organizeMemory 已从干净提交 6800bc0415f10d0d9321245d8497113efdd86508 使用标准 wechat-cloud-deploy.mjs 部署到 cloud1-d5ghzk30ve609f544。重新下载的11个业务文件与该提交逐字节一致；证据位于 /tmp/capture-release-1031/readback-check.json，部署日志 deploy.log。下载过程中发生两次 ECONNRESET，最终成功下载后才进行比对。

云存储已保存 deploy/material-capture/storage.rules.json 的目录白名单规则，界面显示“权限变更完成”，重新打开后回读。旧规则备份 /tmp/capture-release-1031/storage-before.json。此变更限制未知目录；仍需真实客户端验证已有图片路径、本人临时上传、他人拒绝访问和原件拒绝覆盖。定向规则测试12项通过，只代表表达式测试，不代表云端隔离验收。

环境变量已只读检查：既有 TokenHub 文本模型和 AI_SERVER_RELEASE_READY=true 保留；PERSONAL_MEMORY_ENABLED=false 保留。当前未配置 MATERIAL_CAPTURE_READY、PHOTO_ACCESS_INTERNAL_TOKEN、VISION_MODEL、DOUBAO_SPEECH_API_KEY；未修改或展示密钥。新增收集动作仍关闭。录音服务授权、真实素材全流程、权限隔离和二维码仍未完成；不能将此次后台准备描述为完整交付。


### 2026-10-31 13:55 后续配置与真实客户端存储测试

- organizeMemory 新增 PHOTO_ACCESS_INTERNAL_TOKEN，复用本应用 photoAccess 已有值；云控制台保存后更新时间为 13:45:41。未改其他变量，未开启 MATERIAL_CAPTURE_READY。
- 微信开发者工具真实客户端 SDK 测试（不是单元模拟）：memory-capture-uploads 上传成功、下载被拒绝；memory-capture-originals 上传被拒绝（-503002）；user-photos 测试目录上传、下载均成功。测试通过实际 Console 调用 SDK，不算完整页面验收，也未完成第二账号隔离测试。
- 临时测试文件内容仅为 fictional storage permission test。位置为 memory-capture-uploads/<当前测试OpenID>/qa-1031.txt 与 user-photos/capture-qa-1031/test.txt；尚未清理，不涉及用户故事内容。客户端 sandbox 的 capture-rule-test-1031.txt 同样是临时测试文件。
- 实际点击“记下此刻 → 随手记”，进入 capture 聊天且显示原素材保留说明；点击“添加素材”弹出原生菜单。相册项的 AX 点击、坐标点击及重新 Raise 重试未成功触发选择，坐标工具返回 windowNotFoundAtPosition。未把附件端到端验收写成通过。
- 用户明确回复录音服务尚未开通，需要入口。已提供 https://console.volcengine.com/speech/new ，目标“录音文件识别极速版”、资源 volc.bigasr.auc_turbo，并请求在 Codex 打开（工具返回 queued）。官方 API 文档确认该资源需开通；没有代购、充值、接受协议或切换供应商。
- 定向 memory-capture-cloud 测试12项通过。仍需开通录音服务、核实视觉模型可用、完成图片/文字/录音整理保存重开与清理，随后才可按预览脚本交付新二维码。


### 2026-10-31 标准版接口适配（待部署）

用户控制台实际已开通录音文件识别2.0标准版，显示20小时；未购买并发、未充值、未接受数据训练授权。依据官方标准版HTTP文档接入 volc.seedasr.auc，配置 DOUBAO_SPEECH_RESOURCE_ID 选择；既有极速版分支保留。任务UUID在提交前事务落库，提交响应丢失后只查询、不再提交；排队状态保留，客户端每5秒查询、单轮最多8步，之后可继续整理。超时中断的processing如存在未完成ASR任务可恢复查询。私有音频给供应商签发4小时URL；用户读取原件仍为5分钟。

完整check通过1613项（/tmp/capture-release-1031/check-standard.log）；随后新增中断恢复测试，定向14项通过。均为代码测试，非真实录音验收。现有网页DOUBAO_SPEECH_API_KEY对标准版随机任务查询真实返回HTTP200、45000092“任务不存在”，没有提交录音、没有转写消费，也不代表云函数已配置该Key。

当前内置浏览器工具报 browser.user is unavailable；按URL、标签ID及文档提供的tabs.get读取同一标签均失败。原生开发者工具仍可连接。新增标准版代码尚未部署，云端仍运行6800bc0，MATERIAL_CAPTURE_READY仍关闭。真实录音提交和完整UI验收仍待完成，不出二维码。

## 2026-10-31 重试连接与标准版配置

浏览器与独立微信开发者工具云控制台连接已恢复。organizeMemory 已复用网页现有 DOUBAO_SPEECH_API_KEY，并设置 DOUBAO_SPEECH_RESOURCE_ID=volc.seedasr.auc；控制台保存时间 18:46:28。未购买、充值或接受新协议。MATERIAL_CAPTURE_READY 仍关闭。配置保存截图位于 /tmp/capture-release-1031/speech-config-saved.png，不含环境变量值。

最新全量 check：1614 项通过，日志 /tmp/capture-release-1031/check-final-standard.log。主线程检查新增标准版提交/查询、超时恢复、私有链接和前端轮询；真实录音转写与混合素材保存仍待验收。标准版文档列举 raw/wav/mp3/ogg，M4A 兼容仍须实测，不能把支持导入原件等同于已支持转写。

### 标准版部署及首次真实验收

- 已从干净提交 a1d907ec9720fbfbb4d9037278dbfb7ae6646637 按标准脚本部署 organizeMemory。下载回读11个业务文件逐字节一致；证据 /tmp/capture-release-1031/deploy-standard.log、download-standard.log、readback-standard.json。
- 18:49:35 云配置增加 VISION_MODEL=hy-vision-2.0-instruct、MATERIAL_CAPTURE_READY=true，截图 capture-enabled.png。既有发布同意/内容审核/账号权限保留。
- 真实UI文字：记下此刻→随手记，输入 Fictional capture test 1031，允许在线AI，成功生成“虚构测试记录1031：蓝色纸船”，打开记忆读取到云端正文。证据 text-memory-reopened.png。
- 真实UI录音：从微信聊天选文件（开发工具系统文件选择器）导入本机合成的虚构MP3录音，26KB。允许豆包转写后成功保存“虚构测试录音整理”。来源显示准确转写“这是一段虚构测试录音。今天小何把蓝色纸船放进水里，纸船慢慢飘到黄色灯塔旁边。”并提供播放原录音入口。证据 audio-transcribed.png。本次已消费标准版测试时长，未购买新资源。
- 真实UI图片：导入已有虚构几何船只测试PNG，允许本次照片理解。成功生成“简约几何船只图形记忆初稿”，来源中准确描述浅蓝背景、深蓝梯形船体、黄色长条和橙色三角形。证据 image-described.png。
- 上述截图位于 /tmp/capture-release-1031。测试记忆尚待软删除清理，M4A、账号隔离、断网恢复、全新真实账号和整体发布验收未完成，不生成可交付二维码。

- 补充：M4A 使用同一虚构录音转成AAC/M4A，经真实文件选择→允许转写→保存成功，打开云端“虚构测试录音转写摘要”核对文字，证据 m4a-memory-reopened.png。供应商实际接受此测试M4A；不代表任意编码/长度M4A均已验证。

- 清理已完成：从记忆档案列表逐条软删除本轮4条测试记忆，均确认“放进最近删除，随时可以恢复”；记忆数量从18回到原有14，未操作原有14条记忆。原始素材和历史保留，不做永久删除。之前SDK存储权限探测留下的2份测试文件仍未删除，不将整体 cleanedUp 标成 true。
- 当前未完成：跨真实账号隔离、断网恢复、全新真实账号首次流程及其余本提交整体发布验收。因此不生成新二维码、不上传审核版本。已知用户只有两个既有微信号，不应反复要求其凭空提供第三个账号，也不伪造 fresh-account-home passed。
