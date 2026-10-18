# 邀请功能单家庭开放交接（2026-10-18）

## 做了什么（附提交号）

- 延续 `codex/integrate-invite-20261016`，菜单源码提交 `10bbd54`，前次交接 `927afa6`。线上 storyBooks 业务源码仍为 `afc0ee1`；本轮仅调整配置与数据库规则，没有部署函数代码。
- 用户明确批准核对权限后，为本人家庭开放阅读、邀请及收入副本，直接修改原稿保持关闭。用户手动登录腾讯云并处理网络后，进入官方 CloudBase 平台，确认环境 `cloud1-d5ghzk30ve609f544`、AppID `wx86ae3e9d507ce52d`。
- 在控制台逐项读取模板的 22 个集合。`user_accounts` 与 `story_rollout_admissions` 原为 ADMINONLY；其余 20 个专用集合原为 PRIVATE。逐项改为 ADMINONLY 并确认保存后为已选中、不可编辑的“无权限”状态。首项保存遇网络错误，重试成功后继续；不把失败请求当成功。
- 调整的 20 个集合：story_principals、story_identity_aliases、story_principal_spaces、story_grants、story_source_policies、story_copies、story_excerpt_operations、story_collaboration_operations、story_copy_requests、story_copy_edits、story_returns、story_return_indexes、story_desktop_grants、story_desktop_nonces、story_desktop_operations、story_copy_media、story_copy_assets、story_invitations、story_invite_indexes、story_invite_rates。未改数据记录。
- 单独核对 families、stories、biography_drafts、photos、memories、story_images 均为 PRIVATE；保留原规则。云存储自定义规则为 read/write 均 `resource.openid == auth.openid || resource.openid == auth.uid`，保留仅创建者访问规则，没有改全员可读。
- 核对唯一 active story_principal、对应 story_principal_spaces、原 AppID 的 identity_alias 及 families.ownerAccountId 一致，家庭名称与用户现有故事对应。未伪造身份、未手工写 admission，也未改账号记录。家庭明文标识不写进 Git。
- 只修改 storyBooks 环境变量：ACCESS_RULES_READY、ACCESS_ENABLED、INVITATIONS_ENABLED、COPY_RECEIVE_ENABLED 为 true（均带 STORY_ 前缀），IDENTITY_BOOTSTRAP_APP_ID 为上述 AppID，ACCESS_CANARY_FAMILY_IDS 仅一个已核验家庭，SHARED_EDIT_ENABLED 明确 false。全部九项变量回读逐值一致，包括保留原值的 AI_MODERATION_TENCENT_BIZ_TYPE 和 AI_PAID_MODERATION_ENABLED。
- 配置、规则与截图证据在 `/private/tmp/shiguang-book-tools-20261018/`。包含家庭标识的配置备份以 private 文件存放，不提交。

- 主人端实际从“岱”第十章生成图文预览，填写“桌面验收未发送”，成功获得“邀请已准备好，24 小时内有效”及“把卡片发给这位亲友”按钮。未点击外发。
- 返回书稿，经“发送 → 亲友阅读与权限”撤销该测试邀请，确认列表显示“等待加入 · 1 个章节 · 已撤销”。截图为 `invitation-created.png`、`invitation-revoked.png`。未改书稿正文。
- 修正分享预览页的管理入口提示，由“更多 → 亲友阅读与权限”改为“发送 → 亲友阅读与权限”，与 `10bbd54` 菜单整理一致；仅改提示文字。

## 没做什么、为什么

- 没有操作其他函数，没有合并 main，没有修改内容审核、sourceFingerprint、assertSpaceOwner、房间重置/删除护栏或 CLOUD_AI_RELEASE_READY。
- 不开放直接修改原稿、共享图片、公开故事卡或其他功能开关。灰度名单的唯一来源家庭是用户本人；亲友接受有效邀请后由服务端自动记录准入，仍逐章核验授权，不是让所有人读取故事。
- 第二微信账号的接受、保留、扩写及回信尚需验证。不能把主人端测试当双账号验收；小程序未公开发布，接收者仍需对应开发/体验权限。
- 云存储面板显示默认链接有效期 10 分钟；代码请求短时签名，不据此宣称真实 300 秒 TTL 已验收。媒体复制与过期访问仍须双账号实测，本轮测试选无正文图片的章节。
- 性能仍未验收；云控制台和小程序均出现明显等待，不能宣称保存或分享性能达标。

## 和本交接不一样的地方

- 前一交接中的“邀请未开放/控制台登录或网络阻塞”已推进至正确云环境内完成上述规则修正和单家庭配置。旧记录保留历史事实，以本交接为当前状态。
- 真云核对发现专用集合默认 PRIVATE，与模板要求不符；本轮收紧为 ADMINONLY，没有为通过测试放宽权限。
- 部署代码不是开通功能；本轮开通经过用户单独批准，配置与代码部署分开记录。

## 门禁表

| 门禁 | 状态 | 证据/边界 |
|---|---|---|
| 环境与 AppID | 通过 | 控制台和本地配置一致 |
| 22 个模板集合客户端拒绝 | 通过 | 20 项收紧，2 项原已正确，逐项确认保存结果 |
| 既有数据与存储规则核对 | 通过 | PRIVATE / 创建者私有，不扩大读取范围 |
| 唯一家庭灰度及身份绑定 | 通过 | 稳定身份、空间、AppID、家庭所有者一致 |
| storyBooks 环境变量回读 | 通过 | 9/9 逐值一致，审核变量未变，共享编辑 false |
| 主人端图文预览 | 通过 | 岱第十章真实生成图片和标题卡片 |
| 真实邀请创建 | 通过 | 图文预览后创建成功，未外发 |
| 撤销测试邀请 | 通过 | 页面明确显示已撤销，未外发，无正文测试增量 |
| 本次源码检查 | 通过 | npm run check：类型检查通过，1302 项通过，零失败/跳过；日志 /private/tmp/shiguang-family-rollout-check-20261018.log |
| 双账号接受、保留、扩写、回信 | 未通过 | 第二账号尚未测试 |
| 真机目录问题 | 未通过 | 电脑第七章能回目录，手机问题未复现 |
| 新二维码 | 未通过 | 提交后生成；二维码仅供继续体验，不代表双账号或全功能验收通过 |
