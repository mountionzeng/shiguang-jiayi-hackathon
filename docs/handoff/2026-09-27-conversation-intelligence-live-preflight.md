# 对话智能云端核验与交接

日期：2026-09-27。环境 cloud1-d5ghzk30ve609f544，AppID wx86ae3e9d507ce52d。

## 部署

| 函数 | 已核对的源提交 | 验证 |
| --- | --- | --- |
| chatInterview | a760eaf | 下载业务源码一致；最新提示复测被内容检查服务阻断 |
| organizeMemory | 01dd7a2 | 7 个 JS 与 package.json 一致；SDK 已安装；真实整理成功 |
| personalMemory | 26a0fd0 | 8 个 JS 与 package.json 一致；SDK 已安装；真实学习/纠正/忘记完成 |

客户端内容最近改于 2c88670；本次后端代码提交 a760eaf。隔离预览的 183 个前端文件与其一致，仅预览启用客户端 AI。仓库闸门仍为 false。分支已包含主线 f805c15，未推送、未合入 main。云端既有邀请接口 681c481 已保留。

## 密钥和开关

- 用户允许复用的 TokenHub 密钥已保存到 personalMemory，且在扫码后核对成功；未写入代码、交接文档或日志。
- 模型地址 https://tokenhub.tencentmaas.com/v1；模型 deepseek/deepseek-flash。
- 验收期间三个函数的 AI_SERVER_RELEASE_READY 和 PERSONAL_MEMORY_ENABLED 均为 true。
- 个人记忆的云端临时开关已恢复关闭。
- 恢复后 chatInterview / organizeMemory 保持原有 AI_SERVER_RELEASE_READY=true；personalMemory 恢复 AI_SERVER_RELEASE_READY=false；三个 PERSONAL_MEMORY_ENABLED=false。
- 当前测试账号已通过界面暂停个人记忆，理解列表为空。

## 数据与权限

- 五个集合存在，user_id 索引已核对。
- 实际客户端对每个集合进行读取、更新、创建，全部返回 -502003 permission denied；未创建或修改探针。
- 完整权限规则源码未取到，新控制台页面空白；此限制与真实客户端拒绝证据分别记录。
- 原始测试记忆在忘记后仍存在，随后通过正常可恢复删除清理；用户原章节、原照片和历史版本保留。

## 仍待验收

- 腾讯云内容检查服务恢复后，复测 a760eaf 的 10 条追问样例；最新版本尚无成功的线上复测回复。
- 20 条真实模型结果由人逐条评审；Codex 判断不能代替人工硬门禁。
- 真实手机复测基线原句；目前只在微信开发者工具模拟器完成。
- 至少 3 个不同风格的真实测试账号评估倾向准确性。
- 双账号、至少两台设备验证读取/纠正/忘记隔离。
- 持续观察个人记忆页面打开率和确认/纠正点击率。

[机器可读状态](../acceptance/2026-09-27-conversation-intelligence-cloud-preflight.json)
