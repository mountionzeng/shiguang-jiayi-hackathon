# 拾光家忆 ↔ Drinking Time 桥接口约定

| 项 | 值 |
|---|---|
| 约定版本 | **1.5.0** |
| 状态 | 本地实现，默认关闭，待双端真实验收 |
| 日期 | 2026-09-18 |
| 权威版本 | Drinking Time 仓库 `docs/integrations/shiguang-bridge-contract.md` |
| 副本 | 拾光家忆仓库 `docs/integrations/drinking-time-bridge-contract.md`（必须与权威版本同版本号） |
| 实现基线 | Drinking Time `9f7f9f4`（桥接口），拾光家忆 `d83f1ed`（云函数 `drinkingTimeBridge`） |

本约定只描述两端之间**传输的数据和可观察的行为**，不包含 Drinking Time 内部的表结构、故事内容结构、提示词或素材，可以原样放进拾光家忆仓库作为副本。

标注说明：

- 没有标注的条款 = **当前实现的真实行为**，契约测试以此为准。
- 【缺口】= 当前行为已知有问题，但还没修，对端不得依赖它会一直如此。
- 【提案 Pn】= 尚未生效的变更，见第 10 节，需要用户批准后才会升版本并实现。

---

## 0. 版本与变更流程

- 版本号采用 `主版本.次版本.修订号`：
  - **主版本**：线上格式不兼容（签名串、必填字段、字段含义变化）。
  - **次版本**：向后兼容的新增（新的可选字段、新的错误代码）。
  - **修订号**：只改文字说明，或服务端内部修复但线上行为不变。
- 变更顺序：先改权威版本并升版本号 → 通知对端会话 → 用户确认 → 两端各自改实现和契约测试 → 副本同步到同一版本号。
- 当前线上请求**不携带**版本号，服务端也不检查。版本字段的位置见【提案 P5】。

## 1. 参与方与信任边界

```
拾光家忆小程序页面 ──wx.cloud.callFunction──▶ 云函数 drinkingTimeBridge
                                               │  HTTPS + HMAC
                                               ▼
                                   Drinking Time 服务端 /api/shiguang
                                               │  签发一次性登录码
                                               ▼
电脑浏览器 ──POST /api/auth/pair/redeem──▶ Drinking Time 服务端 → 进入同一账号
```

- 共享密钥只存在于**云函数环境变量**和**服务端环境变量**两处，小程序页面、仓库、日志和聊天里都不得出现。
- 服务端无法验证主体（subject）是怎么算出来的，只能验证请求是否由持有密钥的一方签名。**密钥就是全部信任基础**，泄露密钥等于任何人都能为任意主体换取登录码。
- 小程序页面不直接访问 Drinking Time 服务端。

## 2. 环境与地址

| 项 | 测试站 | 正式站 |
|---|---|---|
| 云函数 `DRINKING_TIME_BRIDGE_BASE_URL` | `https://test.drinkingtime.top/api/shiguang` | `https://www.drinkingtime.top/api/shiguang` |
| 电脑登录页 | `https://test.drinkingtime.top/login` | `https://www.drinkingtime.top/login` |
| 桥接口部署状态 | 尚未部署 | 尚未部署 |

- 基础地址**必须带 `/api/shiguang` 前缀，末尾不带 `/`**；签名用的路径**不带**这个前缀（见 3.3）。云函数会去掉多余的末尾斜杠，但配置时不要依赖这一点。
- 【缺口】云函数只检查地址是否以 `https://` 开头，不检查有没有挂载点。**漏了 `/api/shiguang` 时，服务端不会返回 404**，而是按网页路由返回 `200` 和网站首页 HTML（2026-09-15 按正式环境的静态兜底逻辑复现）。云函数目前会把它当成功并返回空对象；小程序的 `transferResult` 逐项校验后拒绝，用户看到「电脑登录码返回异常」（小程序端 2026-09-15 实测）。所以现状是**提示不准确，不是假成功**。约定要求云函数和小程序都按 3.5 校验成功响应的形状。
- 只允许 HTTPS。云函数拒绝非 `https://` 的基础地址；正式环境服务端会把 HTTP 请求 308 跳转。
- 电脑登录页默认停在「邮箱登录」页签，用户需要点「微信登录」才能看到登录码输入框。直达链接见【提案 P6】。

环境变量（只写名称，值不得写进任何文件或聊天）：

| 所在位置 | 变量 | 要求 |
|---|---|---|
| 服务端 | `SHIGUANG_BRIDGE_ENABLED` | 必须等于字符串 `true` 才开启 |
| 服务端 | `SHIGUANG_BRIDGE_SECRET` | 至少 32 个字符，与云函数一致 |
| 服务端 | `OTP_DIGEST_SECRET`（可选 `OTP_DIGEST_SECRET_VERSION`） | 登录码摘要密钥；没配置时桥接口会返回 `not_configured` |
| 云函数 | `DRINKING_TIME_BRIDGE_BASE_URL` | 见上表 |
| 云函数 | `DRINKING_TIME_BRIDGE_SECRET` | 与 `SHIGUANG_BRIDGE_SECRET` 相同 |
| 云函数 | `STORY_DESKTOP_AUTHORITY_ENABLED` | 仅等于 `true` 时使用 1.1 权威故事绑定；默认关闭继续使用 1.0 快照 |

线上服务端由 PM2 托管，改 `.env` 后必须带上环境变量重新加载才会生效。

---

## 3. 接口：签发电脑登录码

### 3.1 请求行

```
POST {DRINKING_TIME_BRIDGE_BASE_URL}/desktop/pair/issue
```

`/api/shiguang` 下只有这一个接口。其他路径和方法不属于本约定，行为未定义，不得依赖。

### 3.2 请求头

| 头 | 格式 | 说明 |
|---|---|---|
| `Content-Type` | `application/json` | 必须。缺少时服务端读不到正文，结果是 `invalid_bridge_signature` |
| `x-shiguang-timestamp` | `^\d{13}$` | 发送时刻的 Unix 毫秒数，十进制字符串 |
| `x-shiguang-nonce` | `^[0-9A-Za-z_-]{16,64}$` | 每次请求都必须新生成。云函数目前用 18 个随机字节做 base64url 编码，得到 24 个字符 |
| `x-shiguang-signature` | `^[0-9a-f]{64}$` | HMAC-SHA256，小写十六进制 |

请求头名称不区分大小写。

### 3.3 签名

```
signature = lowercase_hex( HMAC_SHA256( key = 共享密钥(UTF-8),
                                         message = 签名串(UTF-8) ) )

签名串 = "POST" + "\n"
       + "/desktop/pair/issue" + "\n"      ← 相对路径，不带 /api/shiguang
       + timestamp + "\n"
       + nonce + "\n"
       + canonicalJson(正文)                ← 末尾没有换行
```

`\n` 是单个 LF 字节（0x0A）。

**canonicalJson 规则**（两端实现必须逐字节一致）：

1. `null`、字符串、数字、布尔值：直接用 `JSON.stringify` 的结果。
2. 数组：`[` + 各元素 canonicalJson 用 `,` 连接 + `]`，保持原顺序。**数组元素不得为 `undefined`**：当前两端实现会把 `[undefined]` 输出为 `[]`，而 JSON 传输后服务端得到的是 `[null]`，验签必然失败。发送端的规范化见【提案 P10】。
3. 对象：去掉值为 `undefined` 的键，其余键按 JavaScript 字符串比较（UTF-16 码元序）升序排列，输出 `{` + `JSON.stringify(键):canonicalJson(值)` 用 `,` 连接 + `}`。
4. 任何位置都不留空白。

**传输与验签**：实际发出的正文是普通的 `JSON.stringify(正文)`，键顺序不限。服务端**先把正文解析成对象，再对解析结果做 canonicalJson 后验签**（已核实，两个桥现共用 `server/_core/shiguangBridgeSignature.ts` 的 `hasValidBridgeSignature`，线上协议不变）。因此发送方不要在正文里放 JSON 往返后会变样的值，例如 `undefined`、`NaN`、超过 2^53 的数字；本约定的字段全是字符串和数组，没有这个问题。

签名比较使用恒定时间比较。

### 3.4 请求正文

```jsonc
{
  "subject": "shiguang:<64 位小写十六进制>",
  "story": { /* 故事快照，见第 5 节 */ }
}
```

1.1 也允许以下正文；`story` 与 `storyAccess` 必须且只能出现一个：

```jsonc
{
  "subject": "shiguang:<64 位小写十六进制>",
  "storyAccess": {
    "grantId": "desktop-grant-<64 位小写十六进制>",
    "familyId": "family_<稳定空间编号>",
    "storyId": "story-<稳定故事编号>",
    "revisionId": "revision-<当前修订编号>",
    "version": 7,
    "title": "那年的夏天"
  }
}
```

- `storyAccess` 由拾光服务端从微信上下文、稳定主体和当前故事读取后签发；小程序不能提交 userId、正文或自报来源。
- `grantId` 只是受信服务调用中的授权编号，不是浏览器令牌；浏览器不可读取。电脑端后续访问还必须使用服务端 HMAC 回到拾光权威库逐请求鉴权。
- 电脑端按 `userId + familyId + storyId` 更新同一绑定，不创建电脑 Story，也不把题名或修订当作所有权证据。`grantId` 全局只能绑定一次，不能换账号或换故事。

- `subject` 必须匹配 `^shiguang:[0-9a-f]{64}$`，推导方式见第 6 节。
- 顶层其他字段目前被服务端忽略，但会参与签名。
- **请求体上限：524,288 字节**（按原始正文的 UTF-8 字节数，即 512KB）。建议在**云函数**里检查，因为它手里有含 `subject` 的完整正文：`JSON.stringify({subject, story})` 的 UTF-8 字节数**超过 512,000 就不发送**，本地报 `payload_too_large`，小程序给用户看得懂的提示（【提案 P3】）。
- 【缺口】第 5 节的逐字段上限允许的快照体积远大于 512KB（例如 120 段、每段 2,000 个汉字的记忆约 728KB）。超限时服务端返回的是 HTML 而不是 JSON，见第 4 节。小程序端的实际上限见 5.4，真正起限制作用的是请求体上限。

### 3.5 成功响应

`200`，`Content-Type: application/json`，`Cache-Control: no-store`：

```json
{
  "code": "ABC234",
  "expiresAt": "2026-09-14T10:05:00.000Z",
  "storyId": 31,
  "imported": true
}
```

1.1 权威绑定成功响应改为以下互斥形状，登录码语义不变：

```json
{
  "code": "ABC234",
  "expiresAt": "2026-09-14T10:05:00.000Z",
  "storyAccessId": 42,
  "bound": true
}
```

接收方必须只接受一种成功形状；同时出现快照字段与权威绑定字段时按 `bridge_unavailable` 拒绝。

| 字段 | 类型 | 含义 |
|---|---|---|
| `code` | 字符串 | 6 位一次性电脑登录码，字母表 `23456789ABCDEFGHJKMNPQRSTUVWXYZ`，见第 7 节 |
| `expiresAt` | ISO 8601 UTC 字符串 | 登录码到期时刻，由服务端时钟决定。小程序应据此显示剩余时间，不要写死「五分钟」 |
| `storyId` | 正的安全整数 | 电脑端故事编号，只用于展示或排查，不要当作身份凭据 |
| `imported` | 布尔值 | `true`：这次请求新建了电脑端故事；`false`：同一账号已经导入过同一 `sourceKey` + `sourceRevision`，返回的是之前那份，见 5.3 |

- 接收方必须**忽略不认识的字段**，为以后新增字段留余地。
- 接收方（云函数和小程序）必须**校验成功响应的形状**：`Content-Type` 是 JSON；`code` 匹配 `^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$`；`expiresAt` 能被解析；`storyId` 是正整数；`imported` 是布尔值。任一不满足都按 `bridge_unavailable` 处理，不得显示为成功（原因见第 2 节地址缺口）。
- 响应小于 1KB，远低于云函数 64KB 的读取上限。
- 超时：云函数代码里的 12 秒是 HTTPS 请求的**空闲**超时，不是总时长。真正的上限是微信云函数自己的**执行超时**（在云开发控制台或函数的 `config.json` 里设置），**必须 ≥ 15 秒**。【缺口】拾光家忆仓库里的 `drinkingTimeBridge` 目前没有 `config.json`，线上设置待用户在控制台核对。如果云函数先被平台终止，小程序看到的是笼统失败，而不是 `bridge_timeout`。
- 无论哪种超时，服务端都可能其实已经处理成功：故事已导入、登录码已签发，只是用户没看到。**重试是安全的**：得到 `imported: false` 和一个新登录码；签发新码的同时，之前那个没看到的码立即作废（见 7.1）。

### 3.6 权威故事只读接口（1.2）

电脑端登录后只能由 Drinking Time 服务端请求拾光权威库；浏览器、小程序页面都不能取得共享密钥或 `grantId`。接口为 `POST /v1/story/read`，仅接受 HTTPS，签名串和 3.2 节完全相同，只把路径换为 `/v1/story/read`：

```json
{ "grantId": "desktop-grant-<64 位小写十六进制>" }
```

拾光端在每次读取时重新检查授权未过期、稳定主体有效、主体仍拥有该家庭空间、故事未删除，并读取故事的**当前修订**。扫码时的 `revisionId/version` 只是绑定记录，不会把电脑端固定在旧版本。成功返回：

```jsonc
{
  "story": {
    "familyId": "family_owner",
    "storyId": "story-summer",
    "revisionId": "revision-current",
    "version": 8,
    "title": "那年的夏天",
    "updatedAt": "2026-09-18T06:00:00.000Z",
    "provenanceVersion": 1,
    "chapters": [{
      "id": "chapter-one",
      "title": "第一章",
      "content": [{
        "text": "正文",
        "blockId": "block-<64 位小写十六进制>",
        "sourceIds": []
      }]
    }]
  }
}
```

- 每个内容块必须且只能有 `text` 或不透明的 `photoId`；不得返回永久照片 URL、OpenID、云存储凭据或服务密钥。
- 来源稿必须原样保留 `blockId`、`sourceIds` 和 `provenanceVersion`。旧的自有稿可在响应中确定性补齐空来源字段，但读取本身不得写回书稿。
- 未知来源协议、来源查看权撤销、账号/空间/授权撤销或故事删除都立即失败；电脑端不得回退到旧导入快照。
- 时间戳仍允许前后 300 秒。拾光端用 12 个循环分钟槽持久记录 nonce 摘要，每槽最多 500 个，因此跨实例防重放且记录总量有固定上限；相同签名请求只能使用一次。
- `STORY_DESKTOP_ACCESS_ENABLED` 与 `SHIGUANG_STORY_AUTHORITY_ENABLED` 默认关闭。双端地址、同一共享密钥、数据库集合和真实 HTTPS 路由配置完成前不得开启。
- 响应正文上限 600,000 字节；当前故事文档自身上限 512,000 字节。非 JSON、越界字段、额外字段、来源协议不匹配或 family/story 与绑定不一致都按无效响应关闭处理。

只读接口错误为 JSON：验签或重放返回 `401`，分钟槽超限返回 `429`，授权/主体/故事失效返回 `404`，文档协议错误返回 `422`。电脑路由对登录用户只暴露“故事不可用”或“暂时无法读取”，不泄露其他账号的题名、内部授权编号或具体撤销原因。

### 3.7 权威故事区块写入接口（1.3）

电脑服务使用同一服务凭据调用 `POST /v1/story/write`。浏览器只提交电脑端内部 `accessId`、当前读取到的 `revisionId/version`、稳定请求号及受限区块操作；电脑服务按当前登录 `userId + accessId` 取出隐藏的 `grantId` 后签名。请求正文：

```jsonc
{
  "grantId": "desktop-grant-<64 位小写十六进制>",
  "revisionId": "revision-current",
  "expectedVersion": 8,
  "requestId": "desktop-request-1",
  "edits": [
    { "action": "edit", "blockId": "block-<64 位小写十六进制>", "text": "修改后的正文" },
    { "action": "merge", "blockIds": ["block-...", "block-..."], "text": "合并后的正文" },
    { "action": "appendOwn", "chapterId": "chapter-one", "text": "我自己的补充" }
  ]
}
```

- 客户端不能提交 `userId`、family/story、`sourceIds`、`provenanceVersion`、照片地址或整本替换稿。`edit` 保留目标来源；`merge` 取所有目标来源并集；`appendOwn` 创建空来源的本人新增块。照片、章节顺序和未涉及区块保持不变。
- `revisionId + expectedVersion` 必须同时等于权威库当前值。提交前在同一事务内再次检查授权、主体、家庭、故事、当前修订和来源查看权；冲突返回 `409 version_conflict`，不创建修订或回执。
- 成功生成新的不可变 `revision-desktop-*` 修订，故事版本加一并进入来源协议保护。旧修订不修改，旧有损写入口不能去掉新修订的来源字段。
- `requestId` 为 8–100 位字母、数字或连字符。同一授权与请求号保存持久操作回执：完全相同的重试返回原结果和 `replayed: true`；同号不同正文返回冲突。签名请求本身每次重试仍须使用新的时间戳和 nonce。
- 一次最多 128 个操作，修改文字总量最多 20,000 个 UTF-16 码元，请求正文最多 600,000 字节。空操作、无实际变化、未知区块、跨章合并、伪造来源或未知来源协议均拒绝。

成功响应严格为：

```json
{
  "result": {
    "ok": true,
    "storyId": "story-summer",
    "revisionId": "revision-desktop-0123456789abcdef0123456789abcdef",
    "version": 9,
    "replayed": false
  }
}
```

电脑端必须核对回执 `storyId` 与绑定一致。授权失效返回 `404`，版本/请求号冲突返回 `409`，验签/重放返回 `401`，其他协议错误返回 `422`；任何失败都不得回退到电脑快照写入或显示为保存成功。

### 3.8 权威故事照片短期读取接口（1.4）

电脑服务使用同一服务凭据调用 `POST /v1/story/media`。浏览器只提交电脑端内部 `accessId` 与当前已读取文档里的修订、章节和不透明照片编号；电脑服务按当前登录 `userId + accessId` 取隐藏 `grantId` 后签名：

```json
{
  "grantId": "desktop-grant-<64 位小写十六进制>",
  "revisionId": "revision-current",
  "chapterId": "chapter-one",
  "photoId": "photo-kept"
}
```

- 拾光端先声明并持久消费 nonce，再重新检查授权、主体、家庭空间、故事当前修订和来源查看权。`revisionId` 必须仍是当前修订，照片必须仍存在于指定章节；不能用旧页面坐标读取新版本、其他章节或同家庭其他照片。
- 只允许审核通过且属于原上传者的原照片，或具有独立 active 绑定及可查看来源许可的已复制照片。AI 图、底图、删除/审核失败/来源异常素材和客户端伪造文件路径全部拒绝。
- 云存储签发发生在事务外，因此释放地址前必须再次执行同一描述检查；签发期间授权、修订、照片或来源变化时丢弃地址并失败关闭。
- 成功只返回照片编号、HTTPS 临时地址和固定 `expiresInSeconds: 300`，不返回 `fileID`、永久地址、OpenID、来源凭据或共享密钥。电脑端严格校验 HTTPS、无用户名密码、照片编号一致及 300 秒时效。
- 网页图片使用 `referrerPolicy=no-referrer`。生产环境还需把真实腾讯云临时地址的**精确 HTTPS origin** 加入现有 `CSP_MEDIA_ORIGINS`；禁止使用通配符。未完成真实域名、TTL 和过期后不可读验证前不得开启灰度。
- 授权/照片/版本失效返回 `404` 或 `409`，验签/重放返回 `401`，分钟槽超限返回 `429`，其他协议错误返回 `422`。失败不返回旧快照图片或本地缓存地址，文字编辑可继续但照片显示明确占位。

## 4. 错误

失败时返回非 2xx 状态码，正文为 `{"error": "<错误代码>"}`（例外见表中【缺口】行）。服务端按下表**从上到下**依次检查，命中第一条就返回：

| 序 | 条件 | HTTP | `error` |
|---|---|---|---|
| 1 | 请求体超过 524,288 字节 | 413 | 【缺口】返回 HTML，没有 `error` 字段，云函数只能报 `bridge_unavailable`（【提案 P3】） |
| 1 | 正文不是合法 JSON | 400 | 【缺口】同上，返回 HTML |
| 2 | `SHIGUANG_BRIDGE_ENABLED` 不是 `true`，或密钥不足 32 个字符 | 503 | `bridge_not_configured` |
| 3 | 时间戳格式不对、与服务端时钟偏差超过 300,000 毫秒、nonce 格式不对、签名格式不对或不匹配 | 401 | `invalid_bridge_signature` |
| 4 | 本进程已经收到过相同的 `timestamp` + `nonce` | 401 | `replayed_request` |
| 5 | `subject` 格式不对，或 `story` 未通过第 5 节校验 | 400 | `invalid_input` |
| 6 | 同一 `subject` 60 秒内超过 10 次 | 429 | `rate_limited` |
| 7 | 数据库不可用 | 503 | `unavailable` |
| 8 | 账号解析或故事导入过程中出现任何异常 | 503 | `unavailable` |
| 9 | 签发登录码时，同一账号 600 秒内签发已超过 10 次 | 429 | `rate_limited` |
| 9 | 服务端未配置 `OTP_DIGEST_SECRET` | 503 | `not_configured` |

补充说明：

- 时间戳偏差和签名不匹配**共用** `invalid_bridge_signature`，对端无法区分。
- nonce 在签名通过后、格式校验之前就被记录。所以即使请求因 `invalid_input` 或 `rate_limited` 失败，**重试也必须换新的 nonce 和时间戳**，否则会得到 `replayed_request`。云函数每次调用都会重新生成，符合要求。
- 第 9 行失败时，**故事已经导入**，只是没有签发登录码；重试会得到 `imported: false`。
- 桥接口的 `429` 目前不带 `retryAfterMs`（【提案 P7】）。
- 错误代码只供程序判断，不要原样展示给用户。

**云函数本地错误**（不是服务端返回的，列在这里是为了小程序做提示时有完整清单）：
`bridge_not_configured`（云函数自己的环境变量缺失时也用这个名字）、`bridge_timeout`、`bridge_unavailable`（网络错误，或非 2xx 且正文不是带 `error` 的 JSON）、`bridge_response_too_large`、`bridge_response_aborted`、`invalid_bridge_path`、`invalid_input`、`OPENID_NOT_AVAILABLE`、`UNKNOWN_BRIDGE_ACTION`；以及【提案 P3】`payload_too_large`（发送前正文超过 512,000 字节）。

---

## 5. 故事快照

### 5.1 字段与校验

「长度」指 JavaScript 字符串的 `.length`，即 UTF-16 码元数，一个 emoji 可能算 2。任何一项不满足，整个请求返回 `invalid_input`。

**story**

| 字段 | 必填 | 规则 |
|---|---|---|
| `sourceKey` | 是 | 字符串，长度 1–180。**不透明**，见 5.2 |
| `sourceRevision` | 是 | `^[0-9a-f]{16}$`。**不透明**，见 5.2 |
| `title` | 是 | 字符串，去掉首尾空白后至少 1 个字符，原始长度不超过 120 |
| `updatedAt` | 是 | 能被 `Date.parse` 解析的时间字符串，约定使用 ISO 8601 UTC |
| `memories` | 是 | 数组，0–500 项 |
| `manuscript` | 否 | 对象，见下 |

**memories[i]**

| 字段 | 必填 | 规则 |
|---|---|---|
| `id` | 是 | 字符串，长度 1–160 |
| `text` | 是 | 字符串，长度 0–2,000 |
| `createdAt` | 是 | 能被 `Date.parse` 解析，约定 ISO 8601 UTC |
| `title` | 否 | 字符串，长度不超过 120 |
| `summary` | 否 | 字符串，长度不超过 1,000 |
| `storyTitle` | 否 | 字符串，长度不超过 120 |
| `emotions` | 否 | 字符串数组，最多 20 项，每项不超过 40 |
| `people` | 否 | 字符串数组，最多 40 项，每项不超过 80 |
| `places` | 否 | 字符串数组，最多 40 项，每项不超过 120 |

**manuscript**

| 字段 | 必填 | 规则 |
|---|---|---|
| `title` | 是 | 字符串（目前没有长度上限，发送方应自行控制在 120 以内） |
| `generatedAt` | 是 | 能被 `Date.parse` 解析，约定 ISO 8601 UTC |
| `chapters` | 是 | 数组，0–100 项 |

**manuscript.chapters[i]**

| 字段 | 必填 | 规则 |
|---|---|---|
| `id` | 是 | 字符串，长度不超过 160 |
| `title` | 是 | 字符串，长度不超过 120 |
| `memoryIds` | 是 | 字符串数组，最多 500 项，每项不超过 160 |
| `content` | 是 | 数组，最多 1,000 项。每项是 `{ "text": 字符串（长度不超过 50,000） }` 或 `{ "photoId": 字符串（长度不超过 240） }` 二选一 |

- 可选字段不需要时**直接省略**，不要发 `null`。发 `null` 会被判为 `invalid_input`。
- 服务端会**原样保存整份快照**，包括未约定的字段。发送方不得添加本约定之外的字段，尤其不得放入 OPENID、手机号、照片字节等敏感内容。

### 5.2 sourceKey 与 sourceRevision

- 两者对服务端都是**不透明字符串**：服务端只做相等比较，不会从中解析标题或任何含义。电脑端故事标题只取 `story.title`。
- `sourceKey` 标识「拾光家忆里的哪一个故事」，同一个故事在它的整个生命周期里应保持不变。【缺口】现状做不到，见本节末尾。
- `sourceRevision` 标识「这个故事的哪一版内容」，由小程序生成，内容相同就必须得到相同的值。算法不属于本约定，服务端只要求符合 `^[0-9a-f]{16}$`，**不复算，也不拿它防篡改**（防篡改靠第 3.3 节的签名）。
- `updatedAt` 在内容没变时也可能变化（例如重新保存章节），**不参与去重**。
- 参考信息（非约定，以拾光家忆 `d83f1ed` 为准，由小程序端提供）：
  - 修订号是两路 32 位乘法哈希并行得到的 16 位十六进制，逐个处理 UTF-16 码元，输入是 `JSON.stringify({key, memories, manuscript})`。其中 `key`（`story:{标题}` 形式时本身就含标题）、`memories[].storyTitle` 和 `manuscript.title` 都在输入里；只有顶层 `title` 和 `updatedAt` 不在，而顶层 `title` 总是从 `key` 或 `manuscript.title` 推出来的。所以**标题变化一定会体现为 `sourceKey` 或修订号的变化**。
  - `sourceKey` 目前有两种形式，改标题的效果不同：
    - `story:{故事标题}`：按记忆里的故事标题归并。改标题等于 `sourceKey` 变了，电脑端会出现**一个新故事**，而不是原故事的新修订。
    - `manuscript:{档案 id}`：没有同名记忆故事的书稿。标题取自 `manuscript.title`，在指纹输入里，所以改标题会成为**同一 `sourceKey` 下的新修订**，同样导入为新的一份。
- 【缺口】现状无法保证 `sourceKey` 在故事生命周期内不变：只有书稿的 `manuscript:{档案 id}` 故事一旦出现同名记忆，就会并入 `story:{标题}`（拾光家忆 storyShelf 的归并逻辑），`sourceKey` 跳变，电脑端再多出一份。要等「问题四」的稳定故事 id 解决。
- **sourceKey 格式变更须知**：拾光家忆「问题四」正在把 `sourceKey` 从 `story:标题` 改成稳定 id。服务端没有旧格式到新格式的映射，改完之后每个故事在下一次传输时都会被当作新故事**再导入一份**。上线前需要双方确认是否接受，或者另提迁移方案。

### 5.3 幂等与不覆盖

- 幂等键：（`subject` 对应的账号，`sourceKey`，`sourceRevision`）。
- 三者都相同 → 不新建故事，返回 `imported: false` 和之前那份的 `storyId`，**仍然签发新登录码**。
- `sourceRevision` 不同（或 `sourceKey` 不同）→ 新建一份故事，返回 `imported: true`。**永远不会覆盖**电脑端已有的故事，包括用户在电脑上改过的那份。
- 【缺口】同一幂等键的并发保护只在单个服务进程内有效；多进程部署时，极短时间内的并发请求仍可能各建一份（【提案 P8】）。
- 【缺口】**用户在电脑端正常保存过导入的故事之后，服务端就认不出它是哪个快照导入的了**。此后再传同一修订会新建一份重复故事，而不是返回 `imported: false`（2026-09-15 进程内复现，【提案 P1】）。

### 5.4 小程序端实际上限（参考，非约定）

由小程序端 2026-09-15 提供，以拾光家忆代码为准：

| 内容 | 小程序端上限 |
|---|---|
| 每段记忆正文 | 500 |
| 记忆摘要 `summary` | 60 |
| 人物、地点 | 各不超过 8 个，每个不超过 12 字 |
| 情绪 | 不超过 4 个 |
| 记忆标题 | 40 |
| 故事名 | 30（因此 `story:` 类 `sourceKey` 不超过 36） |
| 章节数 | 30 |
| 章节标题 | 40 |
| 全书正文 | 20,000 |
| 每个故事的记忆条数 | **无上限** |
| AI 生成的书名 | **无上限** |

- 除记忆条数外，小程序端上限都远小于 5.1 的服务端上限。**真正起限制作用的是 512KB 请求体上限**：小程序端估算，大约 250 段写满 500 字的记忆就会超过。
- 【缺口】AI 生成的书名（取正文第一行）可能超过 120，一旦超过，`story.title` 会被判为 `invalid_input`。小程序端会在发送前截断，服务端上限不为此放宽。

## 6. 身份映射

```
subject = "shiguang:" + lowercase_hex( SHA256( UTF-8( APPID + ":" + OPENID ) ) )
```

- 在云函数内用 `cloud.getWXContext()` 提供的 `APPID` 和 `OPENID` 计算。**OPENID 和 APPID 不出云函数**，服务端只见到 `subject`。
- `APPID` 必须是拾光家忆小程序自己的 AppID。【缺口】云函数在上下文拿不到 `APPID` 时会回退到代码里写死的值，换 AppID 时要同步修改。
- 服务端第一次见到某个 `subject` 时，为它创建一个**独立的 Drinking Time 账号**，并一次性赠送 10 算力（按主体幂等，重复调用不会重复赠送）。之后同一 `subject` 永远落到同一账号。
- 这个账号**不会**与邮箱账号合并，也**不会**与 Drinking Time 微信小游戏的账号合并。小游戏是另一个 AppID，openid 不同，主体格式也不同。同一个微信用户在两边会是两个账号。
- 请求里任何名为 userId 的字段都会被忽略，账号只由 `subject` 决定。
- **待用户决定 D1**：主体基于 openid 还是 unionid，见第 9 节。

## 7. 电脑登录码

### 7.1 签发（由第 3 节接口触发）

- 6 位，字符取自 `23456789ABCDEFGHJKMNPQRSTUVWXYZ`（31 个字符，均匀随机），共约 8.9 亿种组合。
- 有效期 300 秒，从服务端签发时刻算起，以响应里的 `expiresAt` 为准。
- 服务端只保存登录码的带密钥摘要，不保存明文。
- 同一账号 600 秒内最多签发 10 次（与该账号其他签发途径共用额度）。
- 每次调用都签发新码，并在同一事务里**立即作废**该账号之前签发、尚未兑换的所有码（包括其他签发途径签发的）。因此小程序只应展示最新一次拿到的码：用户连点两次时，第一次拿到的码已经失效。

### 7.2 兑换（电脑浏览器调用，不经过云函数）

```
POST /api/auth/pair/redeem
Content-Type: application/json

{ "code": "abc-234" }
```

- 规范化：去掉首尾空白，转成大写，删除空格和连字符，之后必须正好 6 位。
- **只能兑换一次**：兑换时原子标记为已使用，两个请求同时兑换只有一个成功。

| 条件 | HTTP | 正文 |
|---|---|---|
| 缺少 `code` | 400 | `{"error":"invalid_request"}` |
| 同一来源 IP 600 秒内超过 10 次（长度不对的码不计数） | 429 | `{"error":"rate_limited","retryAfterMs":<毫秒>}` |
| 服务端未配置 `OTP_DIGEST_SECRET` | 503 | `{"error":"not_configured"}` |
| 码不存在、已过期、已使用、长度不对 | 401 | `{"error":"invalid_code"}`（刻意不区分具体原因） |
| 成功 | 200 | `{"ok":true}`，同时写入该账号的登录会话 Cookie |

兑换成功后，电脑进入第 6 节那个账号，导入的故事出现在故事库里。

## 8. 照片引用

- 快照只携带 `photoId`（`manuscript.chapters[i].content[j].photoId`），**不携带照片字节**。照片文件只保存在手机本机。
- `photoId` 对服务端是不透明字符串：服务端原样保存，**不会去获取照片，不会等待照片，也不会因为缺照片而拒绝请求或延迟签发登录码**。
- 电脑端目前只使用章节里的文字段落，照片位置还没有显示占位（【提案 P9】）。
- 以后如果要把照片传到电脑，必须另起一份需要用户确认、带鉴权、可中断的上传约定，并升版本号。

---

## 9. 待用户决定

### D1：主体用 openid 还是 unionid

**现状**

- `subject` 基于 AppID 作用域的 openid（第 6 节）。
- Drinking Time 网页端目前**没有**基于 unionid 的微信登录，电脑上的「微信登录」只是兑换第 7 节的登录码。
- Drinking Time 小游戏同样使用 AppID 作用域的 openid，代码里明确不用 UnionID 推断账号归属。
- 所以现在网页端没有可以对齐的 unionid 身份。

**风险**：小程序迁到公司名下时，如果 **AppID 变了**，所有 openid 都会变，所有 `subject` 随之变化，用户会落到新的空账号。迁移主体时 AppID 和 openid 是否保持不变，**需要以微信官方文档为准核实，本约定不作结论**。

**选项**

| 选项 | 做法 | 代价 |
|---|---|---|
| A. 维持 openid（现状） | 不改 | AppID 若变化，需要另做一次「旧主体 → 新主体」的迁移，由用户确认后执行 |
| B. 改用 unionid | 小程序绑定微信开放平台账号，`subject` 改为基于 unionid 推导 | 需要开放平台账号；同一开放平台下的拾光家忆、Drinking Time 小游戏、未来的网站扫码登录可以打通同一个人；但这等于改变「微信账号互相独立」的既有决定，而且拿不到 unionid 的用户需要回退方案；属于主版本变更 |
| C. 过渡双主体 | 云函数同时发 openid 主体和 unionid 主体（都经过哈希），服务端优先按 unionid 查找，找不到再按 openid 查找并补登记 | 实现最复杂；属于次版本新增 + 服务端账号逻辑改动 |

在用户决定之前，两端都按选项 A（现状）实现，不做任何改动。

## 10. 变更提案（均未生效）

| 编号 | 内容 | 影响版本 | 哪一端要改 |
|---|---|---|---|
| P1 | 修复：电脑端保存故事后仍能识别导入来源，恢复 5.3 的幂等 | 修订号（线上格式不变） | 服务端 |
| P2 | 防重放记录改为按 `max(收到时间, 请求时间戳) + 300 秒` 保留，并存到多进程共享、重启不丢的存储里。修复前，带未来时间戳的已签名请求在记录被清理后可以重放，并拿到新的登录码（2026-09-15 进程内复现；前提是请求被完整截获） | 修订号 | 服务端 |
| P3 | 超过请求体上限返回 `413 {"error":"payload_too_large"}`，JSON 损坏返回 `400 {"error":"invalid_json"}` ；云函数发送前先检查正文 UTF-8 字节数，超过 512,000 就在本地报同名的 `payload_too_large` | 次版本 | 服务端；云函数加本地检查；小程序增加两条提示 |
| P4 | 让第 5 节的字段上限与请求体上限对齐（降低字段上限，或提高请求体上限）。小程序端实际上限见 5.4：除记忆条数外都远小于服务端上限。具体数字由用户决定 | 次版本 | 双方 |
| P5 | 版本字段放在**正文顶层** `"contractVersion": 1`（整数，只表示主版本）。放在正文里会自动被签名覆盖，不需要改签名串；当前服务端忽略顶层多余字段，技术上可以先发，但小程序端决定等用户批准 P5 之后再发。服务端之后校验：缺省按 1 处理，不认识的主版本返回 `400 {"error":"unsupported_contract_version"}`，成功响应也回带 `contractVersion` | 次版本 | 双方 |
| P6 | 成功响应增加 `loginUrl`（服务端按环境给出电脑登录地址），电脑登录页支持 `/login?method=wechat` 直接打开「微信登录」页签；小程序不再写死地址，并且只展示 `https://` 开头、域名为 drinkingtime.top 的 `loginUrl` | 次版本 | 双方 |
| P7 | 桥接口 `429` 带上 `retryAfterMs` | 次版本 | 服务端；小程序可显示等待时间 |
| P8 | 用数据库唯一约束保证同一幂等键只导入一份，覆盖多进程部署 | 修订号 | 服务端 |
| P9 | 电脑端在章节里显示「照片在手机上」的占位 | 不涉及线上格式 | 服务端/网页 |
| P10 | 发送端的 canonicalJson 把数组里的 `undefined` 按 `null` 规范化，和 JSON 传输结果一致 | 修订号（合法请求的线上格式不变） | 云函数 |

## 11. 契约测试

用户确认本约定后，两端各自加测试，使用**同一组**测试向量：

- Drinking Time：对 `canonicalJson`、`bridgeSignature`、快照校验、第 4 节错误表、5.3 幂等和 7.2 兑换结果逐条断言。
- 拾光家忆：对 `core.js` 的 `canonicalJson`、`signature`、`subjectFor` 使用同一向量断言，并对小程序生成的快照按第 5 节规则做校验。
- 任何一端改动约定内的行为而没有先升版本，契约测试都应该失败。

### 11.1 签名测试向量 V1

> 下面的密钥、AppID、OpenID 都是**公开测试值**，禁止配置到任何环境。

| 输入 | 值 |
|---|---|
| 密钥 | `contract-vector-secret-public-do-not-deploy` |
| APPID | `wx0000000000000000` |
| OPENID | `o-contract-vector-openid` |
| 路径 | `/desktop/pair/issue` |
| timestamp | `1789999200000` |
| nonce | `AAECAwQFBgcICQoLDA0ODxAR`（字节 0x00–0x11 的 base64url） |

正文（传输时键顺序任意）：

```json
{
  "subject": "shiguang:8bf5716e65f591b83c18b8e37ce6e4d2ed2985fac96c3d1dac30f85ea04451c1",
  "story": {
    "title": "外婆的厨房",
    "sourceRevision": "0123456789abcdef",
    "sourceKey": "story:外婆的厨房",
    "updatedAt": "2026-09-14T10:00:00.000Z",
    "memories": [
      {
        "text": "厨房里总有热气，\"咕嘟\"作响。",
        "id": "memory-1",
        "createdAt": "2026-09-13T10:00:00.000Z",
        "people": ["外婆"],
        "places": ["厨房"],
        "emotions": ["温暖"]
      }
    ],
    "manuscript": {
      "title": "外婆的厨房",
      "generatedAt": "2026-09-14T10:00:00.000Z",
      "chapters": [
        {
          "id": "chapter-1",
          "title": "灶台边",
          "memoryIds": ["memory-1"],
          "content": [{ "text": "第一章。" }, { "photoId": "local-photo-1" }]
        }
      ]
    }
  }
}
```

期望输出：

| 输出 | 值 |
|---|---|
| subject | `shiguang:8bf5716e65f591b83c18b8e37ce6e4d2ed2985fac96c3d1dac30f85ea04451c1` |
| 签名串 UTF-8 字节数 | `706` |
| 签名串 SHA-256 | `a78077544889a56c5a664708c008c46b0129ba09101e73e259a9339dc364f9e2` |
| signature | `56e7210914295e1cd56e6ec84d1ff7b47f9975fc97735c4e91e5ab8050ebd921` |

canonicalJson(正文)，单行，没有末尾换行：

```text
{"story":{"manuscript":{"chapters":[{"content":[{"text":"第一章。"},{"photoId":"local-photo-1"}],"id":"chapter-1","memoryIds":["memory-1"],"title":"灶台边"}],"generatedAt":"2026-09-14T10:00:00.000Z","title":"外婆的厨房"},"memories":[{"createdAt":"2026-09-13T10:00:00.000Z","emotions":["温暖"],"id":"memory-1","people":["外婆"],"places":["厨房"],"text":"厨房里总有热气，\"咕嘟\"作响。"}],"sourceKey":"story:外婆的厨房","sourceRevision":"0123456789abcdef","title":"外婆的厨房","updatedAt":"2026-09-14T10:00:00.000Z"},"subject":"shiguang:8bf5716e65f591b83c18b8e37ce6e4d2ed2985fac96c3d1dac30f85ea04451c1"}
```

2026-09-15 已核对：Drinking Time `server/_core/shiguangDesktopBridge.ts` 和拾光家忆 `cloudfunctions/drinkingTimeBridge/core.js` 对这组输入算出的 subject、canonicalJson、signature 完全一致，服务端快照校验通过。

## 1.5 授权故事卡片（默认关闭）

- 新增 HMAC `POST /v1/story/card`，使用与权威读写相同的时间戳、路径签名和持久 nonce 防重放。
- 请求只接受服务端绑定的 `grantId`、`operation`；`source` 返回可选择的章节和最多 180 字预览。`preview` / `export` 还需当前 `revisionId`、`chapterId`、`blockIds`（1–12 个）及 `photoIds`（0–4 个）。不接受正文或客户端身份字段。
- `preview` 返回 `{card:{descriptor}}`；描述包含确定性 `id`、协议 `version:1`、故事与修订坐标、标题、署名、选中文字和不透明照片编号。文字总长最多 1200 字符，每张照片占用 100 字符预算。
- `export` 必须携带预览的 `descriptorId`，返回 `{card:{descriptor,media}}`；媒体仅为选中照片的 HTTPS 临时 URL，`requestedMaxAgeSeconds:300`。拒绝带用户名/密码的 URL、未知字段、错章节、错版本和不匹配图片。
- 权威端复用小程序卡片生成器，每阶段重查当前绑定、阅读及发布许可、来源链 `view/publish/export`，执行内容审核，并在签发照片后重新核验。浏览器保存前再次请求导出；窗口关闭、选择改变或故事切换时清空旧预览。
- 开关为权威端 `STORY_DESKTOP_ACCESS_ENABLED`、`STORY_SHARE_CARD_ENABLED` 和电脑端 `SHIGUANG_STORY_AUTHORITY_ENABLED`；密钥仅在服务端。云函数需 `security.msgSecCheck` 权限。
- 本地测试与构建通过不代表部署完成。腾讯云账号/私有规则、HTTPS 路由、照片 CORS/TTL、两账号与真机验收仍是开放门槛。合法导出的图片无法远程追回。

## 变更记录

| 版本 | 日期 | 说明 |
|---|---|---|
| 1.0.0 | 2026-09-15 | 首版草案：如实记录 Drinking Time `9f7f9f4` 与拾光家忆 `d83f1ed` 的现有行为、已知缺口、待决定事项 D1 和提案 P1–P10；并入小程序端两轮核对：服务地址与挂载点、漏挂载点返回 200 首页及成功响应校验、标题与修订号的关系、`sourceKey` 跳变缺口、数组 `undefined`、云函数执行超时、云函数本地体积检查、小程序端实际上限 |
