# 2026-10-18 storyBooks 部署与预览交接

## 做了什么（附提交号）

- 用户批准部署整合成果，随后明确“还是你来吧”，授权本任务在控制台代建集合及设置拒绝权限。
- 固定部署源码为 `afc0ee1fc23771485c93c08f2af809ae0ad91629`，分支 `codex/integrate-invite-20261016`；实际业务改动来自此前整合及 `b21c119` 的家人邀请卡片连接。
- 在微信控制台核对环境 `cloud1-d5ghzk30ve609f544`，创建空集合 `story_rollout_admissions`，创建时选“所有用户不可读写”，随后进入数据权限重新查询，确认该项选中。等价于模板中的客户端 `read=false, write=false`；没有用建表脚本，没有写入准入记录。
- 部署前重新下载线上 storyBooks：新增 2、修改 4、不变 23，线上独有 0；66 个相对 require 均可解析。完整清单见下表。
- 使用标准命令 `node scripts/wechat-cloud-deploy.mjs --execute --env cloud1-d5ghzk30ve609f544 --only storyBooks`，在 **2026-10-18 00:46:39（北京时间）** 返回成功，函数 Active。部署前后源提交及干净工作树检查通过。
- 部署后用官方 CLI 重新下载到全新 `after-1` 目录，29 个业务 JS/JSON 文件逐一 SHA-256 相同：**零缺失、零差异、零额外业务文件**。排除 node_modules、远端生成的 package-lock.json；package.json 参与核对，下载目录没有符号链接。
- 00:48–00:55 电脑端实际从书稿重新进入“发送给家人”，选择第十章，调用真实云端权限/版本/导出接口并生成图文。第一次提示“图片生成失败，请重试”，无明确根因；点击“生成预览”重试后成功显示 1 张封面、1 张文字图、图片加标题的邀请卡片。没有修改原文、注入页面数据或替换云端响应。界面提示阅读邀请未开放，准备邀请按钮禁用。
- 调试器 3 条错误实际为同一 DOMNodeInserted 废弃事件提示重复 3 次；不能将其认定为第一次生成失败原因。云加载日志有 outcome=ok，但耗时较长，未宣称性能达标。
- 沿用当前业务代码已完成的类型检查与 1298 项全量测试，以及补强断言后的 28 项相关测试；本次没有业务代码修改。workspace:check 显示 clean=true，其 9 月 26 日历史快照差异不等于当前线上差异。

- 部署后新二维码：**2026-10-18 00:59:07（北京时间）**，干净提交 `afc0ee1`，约 01:29 失效。首次上传 read ECONNRESET，脚本第二轮成功；未改 DNS 或代理。二维码留存 `preview-afc0ee1-005907.jpg`，日志 `preview-after-deploy.log`，摘要 `preview-manifest.json`。后续提交仅改交接文档，不改变该预览与部署的业务源码。

## 没做什么、为什么

- 未部署其他函数，未合 main、未推送；main、A、B 原分支未改。没有改正文、清空房间、永久删除内容或付费调用 AI。
- 未修改任何线上开关或环境变量；`STORY_ACCESS_ENABLED`、`STORY_INVITATIONS_ENABLED`、`STORY_COPY_RECEIVE_ENABLED`、`STORY_SHARED_EDIT_ENABLED` 仍按用户要求不开放。本次通过真实页面确认邀请/副本能力未开放，没有展开含密钥的完整环境变量，也不能将“未写入”描述成逐项环境变量值已读回。
- 未真实发出邀请，没有双账号验证接受、保留、扩写、回信。代码部署不等于小程序公开上线；朋友访问开发/体验版本仍需对应微信账号权限。
- “目录无反应”手机问题仍未定位；扩写自动聚焦文末、首次落章引导仍未完整实现。两套邀请流程没有合并。性能仍未验收。

## 和本交接不一样的地方

- 此前要求集合由用户自己创建；本次依据用户新的明确授权，改为在控制台代办，仍未使用脚本绕过。
- 此前交接的“未部署”“集合待建”已被本次结果替代；此前测试与桌面预览记录仍保留为历史证据。源代码没有新增冲突或取舍，合并冲突细节继续见 2026-10-16 交接。
- 内容安全 `tencentModeration.js`、`moderation.js`，保存 `flow.js`、导出 `bookExports.js` 均未被旧分支覆盖，部署前与线上相同，部署后再次与固定源提交相同。
- 用户指定的 preview.sh 只用于界面预览；本次没有伪造 AGENTS/STABILITY 所要求的完整验收 manifest，不把预览二维码描述为全部功能验收通过。
- 证据保存在 `/private/tmp/shiguang-invite-deploy-20261018/`：部署前后下载、before/after-comparison.json、deploy.log、collection-permissions.png、preview-top.png、preview-card.png、二维码和日志。临时目录可能被系统清理；下表保留部署后全部业务文件 SHA-256。

| 文件 | 部署前变化 | 部署后与固定源码一致的 SHA-256 |
| --- | --- | --- |
| access.js | 不变 | `ea841f4bed67e609c5819e1af5839ca0e381d9c7c072408035a515dcb1c050f9` |
| bookExports.js | 不变 | `59029f924a44d2a3580a5cdffd23e47e18151a09aef2fa50e3eb4f9e91b2a4ae` |
| changes.js | 新增 | `7dc38fb35730627165b4530be37ff52683e262c60ea45b9156f7728e0f32fb25` |
| collaboration.js | 不变 | `bd4bbc3bf69bfb73181daa1d8e05d981882947805f5ed991f3842b37690c2b6c` |
| config.json | 不变 | `88e047d3805336df2a7fe5cc3ef0ee1b0c75e5513d31ec53599777b61d71da9f` |
| copies.js | 修改 | `24b5490416df65874054621935ae89d5242aeaf9b4a9bc1faad6b818bcc9d659` |
| copyAssets.js | 不变 | `77651b30d33e76609a702636061581325449ca84dcb27149af9e7f82b013ca87` |
| copyMedia.js | 不变 | `3e4e2744ec6ccfd4f5d504f4d5500aa03b365887aa386581b3129ffa3838b84f` |
| copyStorage.js | 不变 | `9dafee970f5de424cddf1e903c13a60b9ea6f8ccb1a9f96df72f51228ae5a46e` |
| core.js | 不变 | `645d26e3301395c42e228835fec0a3fab14f82a89d8ea3504abb17386ba0d76d` |
| errors.js | 不变 | `75c533babeec9435f13ecd522df488acde5a71c1aba7bc3d7f4e8fc0761ed6fb` |
| excerpts.js | 不变 | `e09eef196b2df5a0693d47cc8f901022b6e05bb4a0e7029750237507ed921fdc` |
| exports.js | 不变 | `4589c46ff7a557a3a2b2dbac5d02f1d1407378f134a9d3d6fe96c05dad5095c9` |
| flow.js | 不变 | `4d33140772fe69ad00fed5bb81c497d762713012f51ab86cf47a12b79c6d950d` |
| identity.js | 不变 | `9310161016473feba9e9a40bc831ef7c8856ce7624ed86057c98fe06abeb7273` |
| index.js | 不变 | `f68191be61a7b40836c23030a4aa7b09fd97f96b4372dec249d06c7ffec7884c` |
| invitations.js | 修改 | `c7509f8f875dc7040f1e89825b66c48355206b5f09c847aa7386d8b4676585a1` |
| media.js | 不变 | `412f84ac8a74ac98828e39c276b9842db881351a8fddb07b8583d566162f0852` |
| memoryExports.js | 不变 | `d4226866e942be53e2ad3c1264a2cedafd2fed5d93e3ae09e67e968c73fd2941` |
| moderation.js | 不变 | `023a4167a1d7dd76301236a277e1020882e76631cbc9900a40920f4ae4d903f4` |
| package.json | 不变 | `64aab7aa0c92b7b620bed9b986cf367281241eea2cb1ad083eb727933bc23cc0` |
| performance.js | 不变 | `908f5a2ae479a3741ffcb934b58bfe8630152e58e0a68cde19da956b8bcf2fc4` |
| provenance.js | 不变 | `9b8d339609a93d4871d26bc8a67915c8be7175ed9ab9a65e73f06adb7ab616c1` |
| repository.js | 不变 | `d89f594909667d28b9eb525f1f17d8b4c348286247eeffbd2b55ff7b20591d35` |
| returns.js | 修改 | `29a20d0fcaad981bd7adf3048d03e5975d2cde2ad384ccc50eb0b4dc2963701b` |
| rollout.js | 新增 | `63e0cb9a0c05daf28200d9efdac3845db89b81e455ef6f3c11458b9940735d59` |
| service.js | 修改 | `82bead34f95c0513bb710446580cb34e4078d3e75c869e52f8f25aad772b5017` |
| stateTransport.js | 不变 | `8ecf2fb910064e89c8ebad42486b541bbd173fadc018f1854d1d9cc95bd64fd3` |
| tencentModeration.js | 不变 | `fe15338f341957cdc7135083efb900a52bb76399854f232196a80a3661481465` |

## 门禁表

| 项目 | 状态 | 证据 / 限制 |
| --- | --- | --- |
| 集合与客户端拒绝规则 | 通过 | 控制台创建后重新查询：所有用户不可读写 |
| 部署范围与来源 | 通过 | 仅 storyBooks，afc0ee1，标准脚本成功 |
| 部署后源码回读 | 通过 | 29/29，相同；零缺失、零差异、零额外业务文件 |
| 内容安全和保存/导出保留 | 通过 | 关键模块前后哈希一致 |
| 自动化检查 | 通过 | 既有类型检查、1298 全量测试，随后 28 项相关断言；本次仅文档修改 |
| 部署后实际图文预览及关闭提示 | 通过 | 首次失败后原流程重试成功，1 封面+1 文字图，卡片可见；稳定性未据此验收 |
| 实际邀请、接受、保留/扩写/回信 | 未通过 | 四开关未开放，双账号未测 |
| 是否开通邀请与副本功能 | 需要用户做 | 后续另行授权，当前不修改开关 |
| 手机目录故障、扩写聚焦及首次落章说明 | 未通过 | 沿用此前未完成事项 |
| 性能验收 | 未通过 | 加载仍慢，不能宣称达标 |
| 新界面预览二维码 | 通过 | 00:59:07 从 afc0ee1 生成；非完整邀请验收凭据 |
