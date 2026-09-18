# 有声动态故事页：微信与腾讯云可行性核查

核查日期：2026-09-18。此次为公开文档、官方 SDK 和本地代码的只读核查，未提交录音、未读取云账号凭据、未调用付费服务。接口文档证据与真实账号可用性分开记录。

## 已确认的微信限制

| 项目 | 官方说明 | 对本项目的影响 |
| --- | --- | --- |
| 代码包 | 主包／单个分包不超过 2 MB；合计不超过 30 MB，服务商代开发不超过 20 MB | 动态故事页适合分包；音频与视频存云端 |
| 当前项目 | 当前 `miniprogram/app.json` 未配置分包或后台音频；9 月 17 日最后一次预览输出合计 1,697,296 字节 | 这是历史构建结果，不是本轮重编译测量；新增后重新检查主包和各分包 |
| 页面动画 | 微信原生动画支持时长、缓动、延迟和变换 | 可实现淡入和照片轻动画；长文分段渲染与音频进度同步需真机测量 |
| 音频播放 | InnerAudioContext 支持播放控制；官方建议长音频关闭 WebAudio 底层实现选项，避免额外内存增长 | 长文优先网络音频播放，正确释放音频对象 |
| 后台播放 | BackgroundAudioManager 全局唯一；需配置 requiredBackgroundModes，正式版需审核 | 前台可调配乐与后台连续播放需单独设计；不假设两条独立音轨切后台后仍能同步 |
| 录音 | 单次最多 600000 ms，支持单声道和多种采样率；不同端存在参数差异 | 可采集复刻样本；文件真实采样率、声道、位深须验证，必要时云端转换 |
| 保存视频 | saveVideoToPhotosAlbum 支持本地 MP4 文件 | 云端合成后下载，再保存；下载和保存失败只重试交付步骤 |

这不是完整的微信审核承诺；当前账号的类目、隐私声明和后台播放权限未登录核查。文件下载、存储额度和云任务执行时限需在选定部署方案后核实，不能把长任务塞进一次页面请求。

## 腾讯云声音复刻：官方 SDK 证据

查阅官方 Python SDK 的 `vrs/v20200824/vrs_client.py` 与 `models.py`，它们只作为接口证据，不要求实施使用 Python。

- `GetTrainingText` 提供训练文本；一句话复刻对应 `TaskType=5`，支持阅读场景 `Domain=2`。该类文本 ID 有效期 7 天，成功创建一次复刻任务后失效，不能长期硬编码一段通用文字代替供应商文本。
- `DetectEnvAndSoundQuality` 的方法说明要求一句话样本 **大于 5 秒、小于 15 秒，不超过 2 MB，单声道、16 bit**；建议 WAV、48 kHz 或 24 kHz。参数模型还列有其他格式与采样率，最终以所选复刻产品和真实调用验证为准。
- 质量检测接收音频和训练文本 ID；`CreateVRSTask` 的一句话复刻只需要一个质量检测返回的 AudioId。页面录音、检测和创建应保留同一授权与样本关联。
- 创建是异步任务。SDK 明确写明一句话复刻暂不支持回调，需要使用 `DescribeVRSTaskStatus` 查询，而不是只实现回调等待。
- 结果包含 `FastVoiceType` 和 `ExpireTime`；不能把复刻音色假定为永久有效。具体有效期、续期条件未确认。
- `CancelVRSTask` 是取消任务接口，不能据此宣称已具备删除全部训练样本／已完成音色的能力。供应商侧删除和保留规则仍需确认。

## 腾讯云朗读与同步

- TTS `TextToVoice` 支持 `FastVoiceType`；一句话复刻对应的 `VoiceType` 固定为 200000000，同时需传入实际复刻音色 ID。
- `EnableSubtitle` 可请求时间戳，返回 `Subtitles`，其 BeginTime / EndTime 单位为毫秒。
- 官方参数明确写有“部分超自然音色不支持时间戳”。尚未证明所选复刻音色与字幕功能可同时使用，必须以真实本人授权样本验证；仅 SDK 有参数不能作为同步成功的证据。
- 长文本 `CreateTtsTask` 文档写明文本上限 10 万字符、异步获取结果、输出音频服务端保存 24 小时；不应直接拿供应商临时结果作为作品永久链接。
- 长文本接口的音色参数和基础合成不同，不能推断一句话复刻 ID 能直接用于长文本接口。计划阶段先核实能力组合；必要时按自然段合成并实测拼接自然度和累计同步误差。

## 建议落地方式与待验证项

1. 小程序：保存版本选择、本人录音、试听、制作状态、动态播放和下载保存；展示代码按需分包。
2. 腾讯云后端：检查账号／故事／音色权限，保管服务凭据，提交并查询复刻与合成，保存成品与同步信息。
3. 腾讯云媒体执行环境：混音和视频渲染；具体使用哪项服务尚未选择，不能声称已有一键动画页转 MP4 的已验证接口。
4. 动态页与视频共享正文快照、分段时间和视觉设置；换配乐复用人声文件。预览中的音量控制与最终混音结果需要一致性测试。
5. 先做一份代表性短文，验证样本检测、音色训练、相似度、时间戳、配乐、MP4 与手机相册闭环，再据耗时／费用定正式限制。涉及真实声音与付费调用时使用明确授权样本和确定的费用范围。

尚未确认：本账号复刻与 TTS 开通情况、价格、音色数限额、有效期、数据保留／删除方式、后台音频审批、复刻音色时间戳、云端媒体处理方式与成本。

## 官方来源

- [微信分包](https://developers.weixin.qq.com/miniprogram/dev/framework/subpackages.html)
- [微信动画](https://developers.weixin.qq.com/miniprogram/dev/api/ui/animation/wx.createAnimation.html)
- [微信音频播放](https://developers.weixin.qq.com/miniprogram/dev/api/media/audio/wx.createInnerAudioContext.html)
- [微信后台音频](https://developers.weixin.qq.com/miniprogram/dev/api/media/background-audio/wx.getBackgroundAudioManager.html)
- [微信录音](https://developers.weixin.qq.com/miniprogram/dev/api/media/recorder/RecorderManager.start.html)
- [微信保存视频](https://developers.weixin.qq.com/miniprogram/dev/api/media/video/wx.saveVideoToPhotosAlbum.html)
- [腾讯云 VRS 官方客户端](https://github.com/TencentCloud/tencentcloud-sdk-python/blob/master/tencentcloud/vrs/v20200824/vrs_client.py)
- [腾讯云 VRS 官方参数](https://github.com/TencentCloud/tencentcloud-sdk-python/blob/master/tencentcloud/vrs/v20200824/models.py)
- [腾讯云 TTS 官方客户端](https://github.com/TencentCloud/tencentcloud-sdk-python/blob/master/tencentcloud/tts/v20190823/tts_client.py)
- [腾讯云 TTS 官方参数](https://github.com/TencentCloud/tencentcloud-sdk-python/blob/master/tencentcloud/tts/v20190823/models.py)

腾讯云网站部分页面本次抓取返回脚本校验页，因此声音接口细节以官方 SDK 的公开注释为证据，不把未读到的购买指南内容当作已核实。上述 master 链接会随 SDK 更新；实施时需重新核对所选 API 版本。
