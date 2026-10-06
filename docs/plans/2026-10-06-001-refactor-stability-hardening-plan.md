---
title: refactor: 加固服务边界与交付验证
type: refactor
status: completed
date: 2026-10-06
---

# 稳定性加固

## 范围与依据

落实用户四项要求：模块边界、历史问题回归、交付前自动检查与版本证据、故障分阶段定位与恢复。保留现有界面、模型供应商、权限和历史版本机制；不做数据库迁移或大规模重写。

依据：`docs/handoff/2026-10-06-daily-question-restoration.md`、`docs/solutions/integration-issues/wechat-media-cross-layer-debugging-2026-09-19.md`。当前故事命令写成功后读状态失败会抛普通错误；图片与迁移路径仍把通用 -501000 误判成函数缺失。已有回归测试覆盖多数历史问题，应复用而非复制。

## 实施项

### U1. 服务边界和统一错误分类

- 目标：固定跨功能的基础错误语义，减少共享代码误改。
- 文件：`miniprogram/services/serviceFailure.ts`、`storyBooks.ts`、`cloudRoomStorage.ts`、`storyImageService.ts`、`dailyQuestion.ts`、`interviewService.ts`；`tests/service-failure.test.ts`、`tests/architecture-boundaries.test.ts`。
- 方式：共用纯错误分类器，区分函数缺失、超时、响应过大、权限、冲突、未知故障；日志仅记录固定分类和阶段，避免输出正文或任意供应商错误。既有服务保持领域响应校验和 consent，不合并成万能请求层。按现有 imports 建立可执行分层边界。
- 验证：-501000 不降级为空库/未部署；确认缺失才能兼容回退；服务端领域错误码保留；日志失败不改变业务结果，日志不包含输入内容。
- 依赖：无。

### U2. 区分写入与刷新

- 目标：已确认写入后读取失败，明确告知已保存、引导重新打开，不报写入失败，不自动重复写入。
- 文件：`miniprogram/services/storyBooks.ts`、`miniprogram/pages/book/book.ts`、`tests/story-command-recovery.test.ts`、`tests/page-handlers.test.ts`。
- 方式：在故事命令边界确认成功回执，写入后刷新单独分类；未知回执不宣称成功。保留请求编号与既有幂等语义、历史版本、本机草稿。页面渲染失败与云写入结果分开。
- 验证：正常保存、明确拒绝、超时结果未知、已写入刷新失败、重复相同请求不重复版本；正文/底图/插图其他章节不被跨功能改动覆盖。
- 依赖：U1；执行前先补失败场景。

### U3. 回归清单和持续检查

- 目标：历史问题进入每次 PR 与 main 更新的自动检查。
- 文件：`.github/workflows/check.yml`、`package.json`、`scripts/check-regressions.mjs`、`docs/STABILITY.md`。
- 方式：按封面与书体、参考照片与生成、文章提问、保存读回四组收录现有行为测试；清单验证防止删除后静默跳过。CI 使用锁文件安装、类型检查、全量测试，最小只读权限，不含云凭据，不做自动部署。
- 验证：本地与 CI 使用同一 check 命令；缺失清单文件报错；新增集成测试覆盖跨功能状态保留。视觉验收仍是独立人工步骤。
- 依赖：U1、U2。

### U4. 可核对的预览交付证据

- 目标：二维码与精确源码、配置、云源码核验、实际验收相绑定。
- 文件：`scripts/wechat-preview.mjs`、`scripts/release-evidence.mjs`、`tests/release-evidence.test.js`、`docs/STABILITY.md`、`AGENTS.md`。
- 方式：复用干净工作树/主线祖先/AppID 环境检查；生成前全量检查。要求当前提交的验收记录及清理结果、需要的云函数下载比对记录；对本地函数源码计算摘要，与证据比对。输出 manifest，包含源码提交、配置摘要、云核验时间/摘要和二维码摘要。CLI exit 0 但没有成功标记或新图片仍算失败。没有证据时明确拒绝出码，不伪称 Active 等于源码一致。
- 验证：过期/错误提交、环境不匹配、云源码不匹配、旧二维码、CLI 假成功和中途源码变化均拒绝；正常路径可重现。测试只用临时 Git 仓库和假 CLI，不调用付费服务。
- 依赖：U3；真实云证据只在出码时读取，不在 CI 中使用账号。

## 验收与风险

先专项测试，再全量检查和代码审查；开发者工具实际执行保存及重新打开/历史恢复，测试文字通过正常流程撤回；对封面、纸边、书脊做视觉回归。GitHub 自动检查须确认真实运行结果；分支保护是否能启用取决于仓库权限/套餐，不能把工作流文件等同于禁止失败合并。运行时代码与云证据脚本不输出密钥。

文档审查：按仓库要求在主线程检查一致性、可实施性、数据安全和范围。明确保留“未知写入结果”状态；不在网络失败后盲目回滚云端，也不伪造成功快照；二维码核验不能替代实际手机验收。
