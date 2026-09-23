# 企业环境文字 AI 部署记录

环境：`cloud1-d5ghzk30ve609f544`；AppID：`wx86ae3e9d507ce52d`。
分支：`codex/ai-text-understanding-editing`；部署源码：`0a65825`。

## 已完成

- 已备份原有 chatInterview、organizeMemory、generateBiography、storyBooks，路径 `/private/tmp/shiguang-ai-deploy-20260922/backup`。
- 三个原有文字 AI 函数的备份源码与 ec42ffd 基线一致。storyBooks 线上版本较基线缺少 memberDelete/memberRestore/roomProfileUpdate；未发现新增线上改动。
- 微信开发者工具部署六个函数成功，最初 info 核验全部 Active（新增两函数的默认超时已在下文修正）：storyBooks（20秒）、chatInterview（60秒）、organizeMemory（60秒）、generateBiography（60秒）、recordAiConsent（3秒）、personalMemory（3秒）。
- 用户指定 DeepSeek-V4.1-Flash 原厂直供。TokenHub 详情与调用示例确认 model 为 `deepseek/deepseek-flash`，地址为 `https://tokenhub.tencentmaas.com/v1`。
- 控制台价格：闲时输入1元、输出4元、缓存命中0.02元/百万tokens；高峰分别2元、8元、0.04元。工作日高峰北京时间9–12、14–18，周末全天闲时。
- 用户明确确认接受该模型服务协议并授权一次无个人数据、费用上限0.01元的连通测试。
- 验证脚本增加 max_tokens=512 与脱敏错误诊断（请求号、供应商请求号、错误码/类型/说明，不保留原始响应）；三项针对性离线测试通过，包含失败不重试和密钥脱敏。唯一授权的真实请求已发送，返回 HTTP 400；错误正文未保留，原因未知，未重试。

## 2026-09-23 01:56 配置核验

- chatInterview、organizeMemory、generateBiography 的 AI_MODEL 已由 hy3 改为 deepseek/deepseek-flash，逐个保存后重新打开核验。保存时间分别为01:35:10、01:41:48、01:44:48。原服务地址、密钥、限流参数、企业AppID和关闭中的发布开关均保留。
- recordAiConsent 已保存超时10秒、WECHAT_APP_ID=wx86ae3e9d507ce52d；回读确认。
- personalMemory 已保存超时60秒、企业 WECHAT_APP_ID、PERSONAL_MEMORY_AI_MODEL=deepseek/deepseek-flash、PERSONAL_MEMORY_AI_BASE_URL=https://tokenhub.tencentmaas.com/v1、PERSONAL_MEMORY_ENABLED=false、AI_SERVER_RELEASE_READY=false；回读确认。尚未配置供应商密钥，不能启用提取。
- 官方 cloud_fn_info 再次核验六函数均 Active，超时依次为20/60/60/60/10/60秒。
- 五个 personal_memory_* 空集合已创建，官方任务结果均 success。02:19前逐项完成“所有用户不可读写”并在界面回读 Value=1；这仅限制客户端，服务端保留正常访问权限。五个集合均创建非唯一、非稀疏 user_id 索引，键顺序 userId升序、_id升序；官方 listIndexes 逐项确认。未写入个人内容，未执行记忆提取。
- CLIENT CLOUD_AI_RELEASE_READY 保持 false；未做真机、双账号和成功的真实供应商验收。
- 已阅读迁移任务最新交接：导入完成并释放共享UI；本任务不修改迁移函数、开关、数据或照片。

## 待完成

- 最新单次连通测试已成功，见下方更新。早先 HTTP400 的错误正文缺失，不能据此推断具体原因。
- 小程序客户端与服务端发布开关仍关闭，真机、双账号与应用完整流程验收尚未完成；供应商连通成功不代表小程序已正式启用 AI。
- 个人记忆供应商凭据尚未配置；只在权限、模型与独立授权验证全部通过后启用。

## 已保存的有效模型设置

- chatInterview: AI_MODEL=deepseek/deepseek-flash（不存在 CHAT_AI_MODEL 覆盖项）
- organizeMemory: AI_MODEL=deepseek/deepseek-flash（不存在 ORGANIZE_AI_MODEL/CHAT_AI_MODEL 覆盖项）
- generateBiography: AI_MODEL=deepseek/deepseek-flash
- personalMemory: PERSONAL_MEMORY_AI_MODEL=deepseek/deepseek-flash（无供应商密钥，功能关闭）

对应 BASE_URL 为 TokenHub 地址。仅在真实模型测试、独立授权与隔离验证全部通过后启用 PERSONAL_MEMORY_ENABLED 和发布开关；当前不应生成“AI已启用”的预览说明。

已执行请求编号为 `shiguang-deepseek-v41-20260923-001`。后续新测试须另获授权并使用新编号；只输出脱敏诊断、状态、用量和请求编号；不得记录密钥或个人原文。若请求结果未知，先核对服务端用量，不自动重试。

## 两任务复用经验

- 迁移记录以根目录 docs/handoff/2026-09-22-old-data-migration-to-enterprise.md 的“2026-09-23 01:27”为准；不要重复导入或覆盖已恢复的照片路径。
- 迁移任务01a0c836-d0b9-7d42-8c9e-8bf60aee770a已释放共享UI；本任务只维护自身工作树和六函数。以后使用共享窗口前先在两任务间交接。
- 官方 wechatide 可查询数据库并管理集合/索引；旧 MacOS/cli 的功能限制不代表新版CLI不支持。每次显式传企业AppID和环境ID。
- 写结构命令返回pending不是成功：单次确认后用原taskId查询最终结果，再回读结构。此次全部完成，没有未决写入任务。
- 索引 update-options 对应腾讯云 CreateIndexes/MgoKeySchema/MgoIndexKeys 结构，字段 Name/Direction；不要把数据库查询 projection 的布尔值与数值规则混用。
- 环境变量页面有明文凭据，只输出脱敏AX状态，不截取密钥表单；保存后重新打开核验，列表时间可能短暂缓存。
- 当前原生云控制台坐标点击出现约40像素纵向偏移，优先使用AX索引；无法独立定位的数据权限页签通过观察偏移后打开。不能把坐标经验用于不同窗口而不重新观察。
- HTTP400原因尚不明确，不推断为密钥范围或请求参数错误；测试脚本已补脱敏诊断并通过离线测试。第二次单次授权现已执行成功，两个测试编号均已消耗，不得自动重试。

## 2026-09-23 正确账号与第二次测试成功

- 用户切换到正确腾讯云账号后，确认 DeepSeek 原厂直供模型此前未启用，生产密钥也没有该模型权限。用户随后自行完成模型启用；控制台显示 `deepseek/deepseek-flash` 运行中、免费额度可用。
- 按用户在操作时明确确认的授权，仅给“拾光AI企业小程序生产”追加该模型权限，保存后可访问范围由 3 项变为 4 项；官方 API 调用列表已包含 DeepSeek-V4.1-Flash。其余权限、限额和 IP 设置保留。
- 用户另行批准的单次不含个人数据、费用上限 0.01 元测试已执行：`shiguang-deepseek-v41-20260923-002`。使用当前账号的生产密钥、既有验证脚本、固定 JSON 提示及 `max_tokens=512`，无自动重试。
- 结果：HTTP 200，返回内容通过 `{"ok":true}` 校验；耗时 3835ms。输入 46 tokens、输出 46 tokens（含推理 40），共 92；缓存命中 0。
- 按页面高峰单价计算为 `(46×2 + 46×8) / 1000000 = 0.00046` 元，低于授权上限。账户有免费额度，但未核对最终账单，不将估算记为实际扣费。
- 测试通过仅本机可访问的临时表单将密钥交给一次性验证进程，凭据未写入文件或工具输出；只保存脱敏结果与防重复标记。测试页面和进程已关闭。
- 脱敏结果：`/private/tmp/shiguang-ai-deploy-20260922/shiguang-deepseek-v41-20260923-002.result.json`。两次已授权测试均已消耗，后续请求需新的明确额度授权。
- 本轮未修改业务代码、云函数或发布开关。`CLOUD_AI_RELEASE_READY=false`、`AI_SERVER_RELEASE_READY=false`；个人记忆仍关闭且尚未配置供应商密钥。已将成功结果同步给迁移/集成任务，避免重复测试。
