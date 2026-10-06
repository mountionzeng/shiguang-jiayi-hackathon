# 稳定性与交付约定

## 模块边界

| 功能 | 页面调用入口 | 共享边界及不变量 |
| --- | --- | --- |
| 书籍与版本 | `storyBooks`、`manuscript` | 写操作带 storyId、预期版本、requestId；成功回执必须匹配书籍。版本是追加保存，恢复也是新版本。 |
| 每日一问与对话 | `dailyQuestion`、`interviewService` | 文字 AI 独立检查 readiness 与 consent；每日一问必须有原文依据，失败不伪造 cloud-ai 结果。 |
| 封面 | `storyCoverService` → `storyImageService` | 全书正文、用户选择的参考图；云能力及用户同意在提交之前；选用封面后首页与书脊使用同一 coverImageId。 |
| 底图与插图 | `storyImageService` → `chapterBackdrop` / `chapterIllustrations` | 生成与选用分开；选用通过 manuscript 保存版本；保留原文字、照片和其他章节，不覆盖整本书。 |
| 云状态 | `roomRepository` → `cloudRoomStorage` → `storyStateTransport` | 一次权威读回；大状态分段但不裁掉历史；读取失败不能伪装为空库。 |
| 书体显示 | `bookFrameColor` → `bookCoverCache` | 仅生成可丢弃的显示衍生图；修改配色算法升级缓存版本；不修改原图。 |

页面负责交互，服务负责协议与流程，domain 负责纯数据规则。domain/config 不引入服务或页面，services 不引入页面/components；App 仅作为 type import。`architecture-boundaries.test.ts` 自动检查这些边界，以及客户端/云端 storyBookCore 一致性。

不把所有业务并到一个万能客户端。共享错误分类位于 `serviceFailure.ts`，业务服务仍负责自己的结果校验和 consent。新功能优先扩展自己的服务，并写清是否触碰故事正文、封面选择、章节媒体或可丢弃缓存。

## 故障语义与恢复

| 阶段 | 判断依据 | 行为 |
| --- | --- | --- |
| AI 请求失败 | 供应商/云调用拒绝或超时 | 保留原话和草稿；图片使用原任务号查询，不能无条件重复生成。 |
| 写入明确拒绝 | 服务返回 error/权限/版本冲突 | 保留草稿和服务器错误码，不读本地旧数据冒充成功。 |
| 写入结果未知 | 连接中断、超时、不完整回执 | 不宣称已保存；重新打开核对，需要重试时保持原 requestId。 |
| 已保存、刷新失败 | `{ok:true, storyId}` 已匹配，随后读回/绘制失败 | `SAVED_REFRESH_PENDING`；告诉用户已保存、重新打开核对，保留原请求号与可恢复历史，不自动重复写入。 |

微信 `-501000` 是通用失败，不能据此断言函数不存在。只有明确 FUNCTION_NOT_FOUND 等证据才允许旧协议回退。日志搜索 `[service-failure]`，字段仅 `service`、`phase`、`kind`；不可添加正文、图片 URL、身份编号、密钥或完整错误对象。

## 回归与视觉验收

`npm run check` 执行类型检查与全部测试，GitHub 的 **Typecheck and regression tests** 使用同一命令。`npm run test:regressions -- cover|images|questions|storage` 可跑专项，省略分组跑全部登记回归。登记文件缺失会报错，不能悄悄少跑。

| 用户曾遇到的问题 | 回归位置 | 实际页面验证 |
| --- | --- | --- |
| 封面没铺满、模糊、书体颜色/明度不匹配、蒙板丢失 | book-image-renderer、book-frame-color、book-cover-cache、story-cover | 首页切书→打开→返回；书脊、纸边、线、蒙板及缓存刷新。 |
| 照片没有参考、底图/插图与文章无关 | reference-photos、story-images、story-images-page、chapter-backdrop、chapter-illustrations | 手机参考入口与不选图分支；真实出图对照原文/参考图；选用后重新打开。 |
| 每日一问退回模板 | daily-question、daily-question-client、runtime-config、interview-service | 真实文章换题→连续回答；核对原文锚点及预览/正式版本开关。 |
| 保存后误报失败、刷新丢历史 | story-command-recovery、cloud-save-regression、story-state-transport、page-handlers | 保存→重开→恢复版本；清理测试增量，不能覆盖他人期间新增内容。 |

单元测试不证明生成图片的美观和物理合理性；实际视觉验收仍按 AGENTS.md 执行。CI 不调用付费模型、不连接云数据库，不持有生产密钥。

## 新预览必须留下证据

使用 `npm run preview:wechat -- --env ENV --acceptance /外部目录/acceptance.json --cloud-evidence /外部目录/cloud.json --output-dir /外部目录` 先检查；增加 `--execute` 才执行完整测试和微信预览。不再手改临时副本的开关或直接用 CLI 裸命令交付。

验收记录使用下列格式，所有 passed 必须来自当前提交的实际操作；这是一份操作员证明，脚本不会代替实际验收：

```json
{
  "schemaVersion": 1,
  "commit": "完整40位提交",
  "appId": "实际AppID",
  "environment": "实际云环境",
  "completedAt": "实际验收完成时间ISO8601",
  "configs": { "每个配置文件路径": "验收时SHA256" },
  "cleanedUp": true,
  "visualChecked": true,
  "flows": {
    "book-read-write-restore": "passed",
    "article-question": "passed",
    "image-reference-and-layout": "passed",
    "cover-and-spine": "passed"
  }
}
```

验收开始前用 `configHashes` 导出配置摘要并填入 `configs`（包括存在的 private 配置）；验收后改变本机编译配置也必须重验，不能只匹配 Git 提交。可运行 `node --input-type=module -e 'import {configHashes} from "./scripts/release-evidence.mjs"; console.log(JSON.stringify(configHashes(process.cwd()),null,2))'`。

把当前六个核心函数 getOpenId、recordAiConsent、storyBooks、chatInterview、organizeMemory、storyImages 从指定云环境下载到外部目录（每个函数一个子目录），再运行 `node scripts/release-evidence.mjs SNAPSHOT_DIR ENV OUTPUT_JSON`。它核对本地已跟踪 JS/JSON 业务文件及下载文件集合（排除 node_modules），拒绝额外业务文件与符号链接，记录每个函数摘要和时间，不把 Active 当源码一致。package-lock.json 是远端安装产物，不作业务源码比较；package.json 参与比较。快照必须真实下载，不能拿本地副本伪造。新增影响核心流程的函数须扩充 requiredFunctions。

验收/云源码证据有效期 24 小时。云配置和供应商状态不在源码摘要里，仍需实际验收。正式发布、语音、分享等不在这六个核心函数的源码核验范围，涉及它们时须另外核验对应函数；不能把本工具描述成全应用上线许可。

输出目录每次新建，内含二维码和 manifest.json，记录提交、AppID、环境、配置文件摘要、云核验、验收、检查结果及二维码摘要。源代码/配置中途改变、测试失败、证据不匹配、没有明确预览成功标记或没有新图片时拒绝出码。输出放源码仓库之外，不提交私人截图或验收文字。

## 合并与恢复

PR 自动检查和 main 更新检查都运行；主线应要求 **Typecheck and regression tests** 成功才允许合并。工作流配置本身不等于分支保护，应在 GitHub 确认规则有效。

纯客户端回归通过 revert 对应提交恢复，再检查并重新出预览。云函数变更单独通过标准部署脚本从干净提交部署，并回读核对；不能因为客户端失败而盲目回退数据库。用户内容使用历史版本恢复，并检查并发新增内容；不删除版本记录。

## 交付后观察

本轮交付者在第一次预览验收及后续用户反馈时检查 `[service-failure]`：正常操作不应持续出现 write/refresh 错误；refresh 错误必须伴随“已保存”的可恢复提示，不能让用户再次生成或重复新增。发现误报成功、版本重复、正文/图片丢失即停止继续出码，保留原请求号、版本和草稿，优先恢复客户端已验证版本后定位；不要通过清空云数据修复。
