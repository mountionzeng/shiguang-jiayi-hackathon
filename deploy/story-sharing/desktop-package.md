# 电脑端权威云函数的独立部署包

`storyDesktopAccess` 引用相邻 `storyBooks` 与 `drinkingTimeBridge` 的纯内核。微信按单个函数目录上传，因此不能直接上传源码目录。

在小程序仓库运行：

```sh
node scripts/package-story-desktop-access.mjs
node --test tests/story-desktop-package.test.js
```

第一条命令返回新建临时目录中的 `storyDesktopAccess` 路径和源码清单，不执行部署。将返回的函数目录作为开发者工具 CLI 的部署 `--paths`，在云端安装 `package.json` 中的依赖。

打包器保留相对目录结构，只包含入口可达的静态 CommonJS 源文件、根 package/config 和入口包装文件。不包含 `.env`、现有 `node_modules`、用户数据或未被引用的其他函数入口。缺失、越界、动态依赖和未声明的外部包会在生成目录前失败。

隔离测试使用 SDK stub 验证模块解析和默认关闭行为；这不是腾讯云 SDK/数据库/HTTP 路由验收。正式启用仍要求：私有规则验证、双方服务配置、持久 nonce 集合、受控测试身份、真实签名请求与撤权/冲突验证。不要因为打包测试通过就设置 `STORY_ACCESS_RULES_READY=true`。
