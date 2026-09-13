# 拾光Ai × Drinking Time 账号关联与故事导入交接

日期：2026-09-13

## 现在实现了什么

用户从拾光Ai的“我的 → 关联 Drinking Time”进入，输入自己在 Drinking Time 使用的邮箱并完成六位验证码验证。验证成功后，小程序只列出该邮箱账号拥有的故事；用户可以预览正文，并选择导入整篇或删减为一个不超过 500 字的片段。

导入是单向复制，不修改、覆盖或删除 Drinking Time 的原故事。导入到拾光Ai的每段内容均为 `personal + private + confirmed`，默认只有当前微信账号本人可见，不会自动进入“记忆之家”，也不会自动分享给任何亲友。相同来源重复导入使用稳定 ID，可安全重试而不会重复堆积；故事列表按 50 条轻量分页读取，不会为了显示标题先加载全部故事正文。

## 身份与隐私边界

- 拾光Ai AppID：`wx6be512f0fe129b62`。
- 微信身份只从云函数可信上下文读取，客户端不能提交或伪造 OPENID。
- 云函数把 `AppID + OPENID` 哈希成不透明 `shiguang:...` 身份；OPENID 不发送给 Drinking Time。
- 邮箱验证码由 Drinking Time 服务端发送并校验，客户端和拾光云函数都拿不到邮件服务密钥。
- Drinking Time 根据服务端解析出的账号 ID 查询故事；接口不接受客户端提供的 userId。
- 两边都已有 Drinking Time 侧内容或出现身份冲突时，自动关联会停止，不自动合并故事、余额或账号。
- 旧邮箱若没有标准邮箱身份，仍受既有逐邮箱人工批准名单保护；禁止启用全局自动认领。
- 故事正文最多导入 5 万字，超过时明确拒绝，不静默漏掉后半篇。

## 两端需要的配置

### Drinking Time 服务端

```text
SHIGUANG_BRIDGE_ENABLED=true
SHIGUANG_BRIDGE_SECRET=<至少 32 个随机字符>
```

同时需要原有账号与邮件基础设施正常：MySQL、`OTP_DIGEST_SECRET`、`RESEND_API_KEY`、`RESEND_FROM_EMAIL`。首次部署建议先保持 `SHIGUANG_BRIDGE_ENABLED=false`，部署代码并检查站点健康后，再写入强密钥并打开开关。

若目标邮箱属于旧数据且还没有标准邮箱身份，只能把本人已核对并明确批准的邮箱加入现有 `MINIGAME_EMAIL_LINK_LEGACY_ALLOWLIST`；不要配置宽泛规则，不要把真实邮箱写进仓库。

### 拾光Ai 云函数

给 `drinkingTimeBridge` 云函数配置：

```text
DRINKING_TIME_BRIDGE_BASE_URL=https://<Drinking Time HTTPS 域名>/api/shiguang
DRINKING_TIME_BRIDGE_SECRET=<与服务端完全相同的强密钥>
```

然后在微信开发者工具中上传并部署 `cloudfunctions/drinkingTimeBridge`，选择“云端安装依赖”。密钥只放云函数环境，不能写入 `miniprogram/`、Git、截图或前端日志。

这里是云函数服务端发出的 HTTPS 请求，不是小程序客户端 `wx.request`，通常不需要把 Drinking Time 域名加入小程序 request 合法域名；仍需在真实云环境验证云函数能访问该域名。域名证书必须有效，不能改用 HTTP。

## 安全启用顺序

1. 部署 Drinking Time 服务端代码，桥保持关闭；确认 `/healthz`、`/readyz` 和既有网页登录正常。
2. 在两端分别配置同一个新生成的强密钥，不通过聊天或 Git 传递。
3. 打开 Drinking Time 的 `SHIGUANG_BRIDGE_ENABLED` 并重启服务；未签名请求应返回拒绝。
4. 部署拾光Ai的 `drinkingTimeBridge` 云函数。
5. 上传拾光Ai体验版，再用两个不同微信账号做真机隔离验证。
6. 验证通过后才提交小程序审核或发布；代码合并本身不等于线上功能已生效。

## 真机验收清单

- 微信 A 验证邮箱 A 后，只看见邮箱 A 自己的故事；看不到邮箱 B 的标题和正文。
- 微信 B 验证邮箱 B 后，只看见邮箱 B 自己的故事；切换账号、退出重进后不残留 A 的列表。
- 错误、过期验证码不能关联；频繁请求会被限流，邮件内容明确写“拾光Ai微信小程序”。
- 两边已有内容的冲突账号得到保护提示，不发生自动合并。
- 导入整篇后只出现在 A 自己的“人生之书／记忆档案”数据中，不出现在“记忆之家”，亲友 B 看不到。
- 导入片段超过 500 字会被拒绝；整篇超过 5 万字会提示先在网页版拆分。
- 同一故事重复点击导入不会增加重复副本；中途网络失败后重试可以补齐。
- Drinking Time 原网页故事、正文、版本和余额完全不变。

## 当前明确不做

- 不做双向实时同步；这是一次性的用户主动导入。
- 不自动合并两个都有内容的账号。
- 不让被邀请亲友看到未定向分享的私人故事。
- 不上传拾光Ai本机照片到 Drinking Time。
- 暂无“解除关联”入口；需要产品规则与审计方案后再做。

服务端目前会拒绝五分钟之外的签名，并在单个服务进程内拒绝 nonce 重放；多进程之间尚未建立共享 nonce 仓库。所有请求仍使用 HTTPS、HMAC、主体限流和短时效签名，正式扩大流量前应补共享重放记录。

## 本地验证结果

- 拾光Ai：与 `origin/main@dc813b7` 对齐后 TypeScript 通过，275 项测试全部通过。
- Drinking Time：TypeScript 通过，账号、桥接、正文持久化等定向 81 项测试全部通过。
- Drinking Time 功能账本：42 张功能卡校验通过。

以上是本地自动化证据，不等于真实 MySQL、真实邮件、两部手机和线上云函数已经验收。
