# 素材收集启用条件

此目录是部署核对材料，尚未应用到云端。`database.rules.json` 是分集合模板，不能把整个文件直接上传为全库规则。

1. 建立 `material_captures`，对客户端读取与写入均设置 false。云函数使用 SDK 并按 accountId + familyId 查验。建索引：accountId ASC、familyId ASC、createdAtMs DESC。不要从请求中动态创建集合。
2. 云存储规则必须实际验证：`memory-capture-uploads/<openid>/...` 仅当前认证 OpenID 可上传，客户端不可公开读取；`memory-capture-originals/**` 客户端不可读、写或覆盖。云函数校验字节/类型后复制到该私有目录，只向本人签发5分钟 URL。不同 CloudBase 控制台版本的规则语法需在部署环境确认，本目录不提供伪装成可执行的占位规则。
3. `organizeMemory` 仍使用现有 AI 同意、正式发布闸门、内容审核和额度配置；补充 `PHOTO_ACCESS_INTERNAL_TOKEN`（与 photoAccess 一致）、`VISION_MODEL`、`DOUBAO_SPEECH_API_KEY`。照片模型仍只走已允许的 TokenHub。录音为普通转写，不是声音复刻。
4. 用该云端账号实际核验 `volc.bigasr.auc_turbo` 权限及语音请求。网页本机当前已有 Key 被该接口403拒绝，不能据此宣称小程序语音已开通，也不自动把小程序录音转送另一供应商。
5. 以上完成后才设置 `MATERIAL_CAPTURE_READY=true`。默认关闭只影响新增 capture* 动作，既有采访聊天、文字整理不变。未配置时保留本机草稿并提示尚未开放。
6. 固定干净提交，按标准部署脚本部署 organizeMemory 并回读源码比对。手机包与云函数分开验收；必须亲自点击图片/录音混合发送、原件保存、重开记忆、切换账号和断网恢复，再按 AGENTS.md 提供二维码。

录音仅支持 MP3/M4A/WAV/Ogg，单份≤8MB、同批最多6份素材（音频最多3份）。当前云端音频长度没有媒体探针，客户端现场录音限10分钟；已有录音文件只按文件字节限制，长文件的转写可能超出函数时限而转入不确定状态，原件可保存。不能声称任意长度录音已通过。

客户端路径仅作为暂存；私有原件使用字节摘要保存。部署后由负责人首轮检查两账号拒绝读取、上传与字节校验、每批一条 memories/source_records 回执、失败不自动再调用模型。异常时先关闭 MATERIAL_CAPTURE_READY，保留集合和原件，不清库；按部署前保存的提交恢复函数。
