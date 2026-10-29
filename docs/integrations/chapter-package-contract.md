# 章节包契约 v1

版本：1.0.0（2026-10-22）。权威版本在网页仓库 `docs/integrations/chapter-package-contract.md`，小程序仓库放同版本副本。改动先改权威版本，再同步副本；规则沿用 `shiguang-bridge-contract.md`（主.次.修订）。

实现：网页 `shared/chapterPackage.ts`，小程序 `miniprogram/domain/chapterPackage.ts`。共用样例在两个仓库的 `tests/fixtures/chapter-package/`，内容逐字节一致，`SHA256SUMS` 由测试校验。

## 原则

1. **一行是一个文字模块的默认单位；排版可以把一个模块放在任意位置，但不能把两行合成一个模块。** 文字块的 `text` 不含换行，也不为空。
2. 字只存一份，在正文块里。文字模块用 `bind` 指向块，自己不存字。
3. 包里没有任何账号或内部标识；来源信息只留在发送方。
4. AI 标记原样保留：`containsAiText`、`assets[].aiGenerated`。
5. 图片单独传，包里只有 `assetId` 和校验信息。
6. 纯函数，无随机数，同样输入得到同样的 id。

## 结构

```
{ kind:"chapter-package", version:1, packageId:"cp_…", lineage:{rootPackageId,parentPackageId|null},
  createdAt:"…Z", sender:{platform:"web"|"miniprogram", displayName}, storyTitle,
  chapters:[{ chapterId:"chapter-…", title, containsAiText, cover:{assetId}|null,
    blocks:[ {blockId,type:"text",text} | {blockId,type:"image",assetId,caption?} ],
    layout:null | { canvas:{900,1200}, flowVersion?:1,
      settings:{fontId,style,texture,textureSeed,includeCover,bodyTextureAssetId|null},
      pages:[{label, modules:[ text:{id,kind,bind:{blockId}|{chapterTitle:true},rect,fontSize,contentWidth,contentHeight,alignment,emphasis?,backdrop?,positioned?}
                              | image:{id,kind,assetId,rect,crop,positioned?} ]}] } }],
  assets:[{assetId,mime,bytes,sha256,width,height,aiGenerated}] }
```

格式：`packageId` 为 `cp_`+8–64 位字母数字或连字符；`chapterId` 为 `chapter-[a-z0-9-]{1,60}`；`blockId` 为 `block-`+64 位十六进制；`assetId` 为 `asset-`+32 位十六进制。

## 编号规则

- 没有 blockId 的块：`block-` + sha256(JSON.stringify(["chapter-package-v1", chapterId, 块序号, "text"|"image", 文字或assetId]))。
- 一段文字拆成多行时：第一行沿用原 blockId，后面各行用 sha256(JSON.stringify(["chapter-package-v1-split", 原blockId, 行号])) 生成。
- 图片：`asset-` + sha256(JSON.stringify(["chapter-package-v1-asset", 本端图片键])).slice(0,32)。本端图片键（photoId、数据库编号、网址）不进包，对应关系由转换器单独返回。
- 网页模块 id 沿用 `cover-title`、`paragraph-N`（N 是文字行序号）、`image-N`、`cover-image`。

## 转换规则

- 网页 → 包：每个非空行一个文字块。有排版时，只有被模块引用的块进包，未引用的省略并警告；没有排版时全部进包。模块里被改过的文字优先，并警告。
- 小程序 → 包：按单个 `\n` 切分，跳过空行；照片块保持位置；已有服务端 blockId 随包带出。
- 包 → 小程序：每个文字块变成 `{ text: 行 + "\n" }`，返回 `{chapter, layout, blockIds}`，**不把 blockId 写回章节**。
- 包 → 网页：行用 `\n` 连接成正文；排版里没被覆盖的块接在最后自动排版。
- 排版里指向不存在的块：校验失败（MISSING_BLOCK_REF）。不单独丢弃。
- 不打包：`backdropImageId`。
- 03/04 在收下副本时应保存包里的 blockId，因为 id 由内容推出，内容一改就变。

## 错误码

UNSUPPORTED_VERSION（主版本不认识）、INVALID_SHAPE、MISSING_BLOCK_REF、MISSING_ASSET_REF、LIMIT_EXCEEDED、FORBIDDEN_IDENTIFIER（任何层级出现 openid、unionid、accountId、familyId、userId、memoryId(s)、sourceId(s)、grantId，忽略大小写与 `_`、`-`）、ASSET_INFO_MISSING（仅发送端：缺图片信息）。

## 警告（不阻止转换）

MODULE_TEXT_WINS、TITLE_MODULE_MISMATCH、MULTILINE_MODULE_SPLIT、UNREFERENCED_BLOCK_OMITTED、ILLUSTRATION_ANCHOR_UNRESOLVED、UNPLACED_BLOCKS、EMPTY_TEXT_MODULE_DROPPED。

## 上限

30 章；文字合计 20000 字；不含图片的 JSON 240 KB；每章 9 页；每页 300 个模块；图片 12 张，单张 2 MB，合计 8 MB。

## 版本规则

主版本不认识就拒收。同一主版本下不认识的字段读取时忽略，写回时不保留。
