# 对话智能：登录后的云端核查

日期：2026-09-27。以下为本次登录后实时读取的配置与源码，优先于早先交接中“尚未登录／云配置未核验”的描述。本轮未部署、未保存云配置、未发起模型请求。

## 实际云配置

环境 `cloud1-d5ghzk30ve609f544` 与 AppID `wx86ae3e9d507ce52d` 的仓库映射一致。

| 函数 | 服务端 AI 开关 | 个人记忆开关 | 模型凭据 | 模型 |
| --- | --- | --- | --- | --- |
| chatInterview | true | 未配置（代码默认关闭） | 已配置，只记录存在性 | deepseek/deepseek-flash |
| organizeMemory | true | 未配置（代码默认关闭） | 已配置，只记录存在性 | deepseek/deepseek-flash |
| personalMemory | false | false | 三种允许的凭据变量均未配置 | deepseek/deepseek-flash |

三者模型服务地址均为 `https://tokenhub.tencentmaas.com/v1`，运行时 Nodejs16.13，超时 60 秒；最终只读查询均为 Active。追问限流仍为每日 60 次、最短间隔 1000 毫秒。

## 数据与源码核查

- `personal_memory_controls`、`personal_memory_insights`、`personal_memory_evidence`、`personal_memory_suppressions`、`personal_memory_jobs` 五个集合均存在、当前记录数均为 0，各自具有 `user_id` 索引（`userId ASC, _id ASC`）。
- 数据库读取工具只返回结构与索引，没有返回访问规则。旧控制台要求转到新版，新版在此次内嵌浏览器中渲染为空白；因此本轮尚未重新核验客户端读写禁止规则。
- 三个函数业务源码已下载保存并逐文件比较。organizeMemory 与 personalMemory 的业务源码仍与功能起点 `937210a` 一致。
- chatInterview 在核查期间一度为 Updating，随后恢复 Active。下载的 `index.js` 与邀请功能提交 `681c481` 完全一致，较功能起点新增 `inviteCopy` 邀请短笺接口。已将该接口及其既有回归用例整合进本地对话智能分支，保留本轮提示词修改；未引入邀请任务的其他界面、家人接口改动。部署前仍须协调并重新核对云端是否又有变化；其余文件仍与功能起点一致。

## 本地接续

已在功能分支合入当时最新的 main `f805c15`，合并提交 `1861043`，无冲突。合并后类型检查与 984 项离线检查通过（失败、跳过均为 0）。原实现提交 `defc6e8` 保留。没有合并回 main。

整合邀请接口后，为避免标准部署默认附带其他云函数，给原部署脚本增加 `--only`：只允许已登记的 base/configured 函数，禁止与 `--include` 混用，拒绝重复、未知、迁移、诊断及危险维护函数；保留干净提交、main 祖先关系、AppID/环境匹配和逐函数 Active 核验。三函数部署预演只列出 `chatInterview`、`personalMemory`、`organizeMemory`。最终类型检查与 987 项离线检查通过（失败、跳过均为 0）；这不代表真实模型验收。

## 当前等待与下一步

1. 初次查询时「拾光 界面」「拾光 AI 图片生成：新想法与流程改造」「拾光发送功能：家人邀请与社交图文」均有活动任务；15:26 再读时只剩「拾光 界面」仍运行。已向用户请求允许发送协调消息，确认微信开发者工具与共享云环境的交接时机；在收到允许前不向其他任务发送消息。
2. **用户已明确允许**复用 chatInterview 现有 TokenHub 密钥到同一环境 personalMemory 的 `PERSONAL_MEMORY_AI_API_KEY`。此授权保留，不要重复索取。尚未执行保存，等待共享环境交接；不在聊天、源码或日志记录值。
3. 交接后重新检查干净提交、main 兼容性及云端源码，再用 `--only` 部署三个相应函数。核验访问规则、独立同意和模型额度后，按 20 条固定样本执行真实模型评价，并完成纠正、忘记与账号隔离流程。
4. 本轮仍没有真实模型或真机验收结果，不将配置存在、Active 状态或离线通过数计入产品成功率。
