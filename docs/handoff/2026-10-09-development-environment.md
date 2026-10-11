# 开发环境交接：从已交付独立记忆版本继续

更新：2026-10-09。用途：后续打开任务时确认开发入口，避免旧工作树或旧二维码混用。

## 当前入口

| 用途 | 位置 / 状态 |
|---|---|
| 统一仓库入口 | `/Users/yuandai/Documents/New project/shiguang-jiayi-hackathon`；main，235932e，整理前干净 |
| 本任务继续开发 | `/Users/yuandai/Documents/New project/shiguang-jiayi-hackathon/.worktrees/codex/conversation-experience-20261008` |
| 开发分支 | `codex/conversation-experience-20261008`；包含main；尚未合main |
| 已交付代码 | `c6b3cac4e3c57035a0bc8e528eaec7a36b829685`；其后的环境整理提交只改文档 |
| 微信项目 | AppID `wx86ae3e9d507ce52d`，云环境 `cloud1-d5ghzk30ve609f544` |
| 材料目录 | `/Users/yuandai/Documents/ChatGPT/DK—小程序`，不存源码 |
| 网页参考项目 | `/Users/yuandai/Documents/New project/drinking-time-local`，独立项目，不视为小程序部署目录 |

本轮仅整理当前开发线文档和外部交接/备份，未切换主仓库分支、未合并其他开发线、未更新远端引用、未部署业务代码或改变开关。

## 开发与验证

```sh
cd '/Users/yuandai/Documents/New project/shiguang-jiayi-hackathon/.worktrees/codex/conversation-experience-20261008'
git status --short
git branch --show-current
npm run workspace:check
```

- 先读 AGENTS.md 和 docs/WORKSPACE.md。当前运行时Node v24.18.0、npm 11.16.0；云运行时此前记录为Nodejs16.13，后续部署须核对兼容性。
- TypeScript和tsx从主仓库node_modules解析；没有单独复制或重新安装依赖。改锁文件和依赖前考虑其他工作树。
- workspace:check对照9月26日静态快照，存在差异属历史比较，不表示刚交付云代码不一致。实时证据以真实下载比对为准。
- 已交付版本完整1184项与类型检查通过。本次环境整理不改业务代码，不重复执行测试。
- 局部测试入口：`npm run test:files -- tests/具体文件.test.ts`。完整检查：`npm run check`。新二维码仍必须实际桌面验收并走`npm run preview:wechat`。
- 源码正式文字AI开关`CLOUD_AI_RELEASE_READY=false`；develop/trial可用。不能为了预览把正式开关改成true。
- 同一时间只有一个任务操作微信开发者工具和共享云环境。当前开发者工具打开本工作树；后续先核对窗口的projectpath。

## 可恢复交付点与证据

外部工作目录：`/Users/yuandai/Documents/Codex/2026-09-27/shiguang-conversation-intelligence/work/`。

- `environment-20261009/delivered-c6b3cac.bundle`：已交付分支完整Git历史，已用git bundle verify核对。用于需要时恢复到新目录，不能覆盖现有工作树。
- `environment-20261009/`：本次工作树清单与环境整理摘要；它是时间点快照，不是持续实时状态。
- `deployment-20261009-independent/`：验收、云源码比对、进展、门禁、预览日志。
- `preview-20261009-independent-final/preview-c6b3cac-2yssXE/`：已交付二维码、manifest、图片保留例外。
- 证据有效期24小时。下一次改动代码或相关编译配置后，旧二维码和旧通过记录不能替代新版本验收。

恢复示例（实际恢复前选定不存在的新目录）：先`git bundle verify <bundle>`，再`git clone <bundle> <新目录>`；不要对当前仓库执行reset --hard或清理未提交内容。

## 其他开发线

- `codex/send-two-pages-qr-20261007`：6455d81，核对时干净，未合main；涉及发送菜单、分页和排版。本次没有整合这条线，后续涉及发送功能先查看差异和交接。
- 两个`.claude/worktrees`当前均干净，提交已是main祖先；保留供其他任务追溯。
- 24个2026-09-26归档工作树保持locked，不开发、不部署、不删除。
- 主仓库main和本地origin/main均为235932e；未联网fetch，不能据此声称远端此刻没有更新。

## 数据与尚需用户判断

- 测试文字和临时故事通过正常软删除/恢复清理，原57字文章及底图已重开核对，记忆库13条。
- 用户明确保留3张示例图：228KB底图、316KB插图、约201KB项目示意图（已解除记忆引用）。原有照片和版本历史保持。以后不要把这3张误当待删垃圾。
- 自然度、启发性、写作是否像本人，以及真机相册权限和实际微信送达，仍由用户体验判断，详见外部门禁表。
- 当前没有擅自选定下一项新功能；在本开发线接收用户接下来的反馈后继续。
