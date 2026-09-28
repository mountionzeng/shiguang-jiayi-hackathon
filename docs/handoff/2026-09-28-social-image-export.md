# 社交图片导出交接

日期：2026-09-28  
分支：`codex/social-image-export-20260928`

## 用户目标

用户在手机上进入社交分享时看到“图片导出尚未开放”。本次把已有导出能力正式接到书封面和章节底图：用户选择整本书、章节或一段原文，生成封面图与若干正文图，检查满意后保存全部图片，或逐张打开微信图片分享菜单。

## 最终行为

- `STORY_SHARE_CARD_ENABLED=true` 时，所有完成身份核验的书稿主人都能使用书稿图片导出；亲友阅读、公开卡片和其他发布能力仍保持原来的灰度范围。
- 每次预览、保存、直接分享前都重新读取权威书稿版本与权限；亲友获得的阅读或编辑授权不能变成主人导出权限。
- 服务端逐章读取 `backdropImageId`，只接受属于同一家庭、同一本书、同一章节、用途为 `backdrop`、审核通过且位于本书存储目录的图片。
- 临时底图链接只在导出材料中返回，链接、文件编号和图片变化都会让旧预览失效。
- 分页排版在章节边界换页，因此每张正文图只使用该章底图；没有底图时使用原纸张背景。长图包含多章时不应把某一章底图误当成整本书底图。
- 底图以低透明度铺满，并覆盖浅色纸层，正文仍保持清晰可读；页脚标明“AI 章节底图”。
- 每张成品图提供“发这张图片”，调用 `wx.showShareImageMenu`。调用前再次核对权限；旧微信不支持时提示先保存到相册。

## 文件

- `cloudfunctions/storyBooks/bookExports.js`
- `cloudfunctions/storyBooks/service.js`
- `miniprogram/services/bookExport.ts`
- `miniprogram/services/bookImageLayout.ts`
- `miniprogram/services/bookImageRenderer.ts`
- `miniprogram/packages/story-sharing/pages/social/index.ts`
- `miniprogram/packages/story-sharing/pages/social/index.wxml`
- `miniprogram/packages/story-sharing/pages/social/index.wxss`
- 对应 `tests/book-*.test.*`

## 图片资产

本次没有生成或新增静态图片文件。导出使用用户已选书封面、已选章节底图和现有纸张兜底图；动态姓名、标题和正文继续由 Canvas 绘制，没有写进静态素材。

## 验收状态

- 定向检查覆盖：非灰度主人开放、读者拒绝、封面/底图归属与审核、底图签名、章节分页、Canvas 底图叠加、直接微信分享、相册续存和权限撤销。
- 提供二维码前仍须按 `AGENTS.md`：在微信开发者工具用本次最终整合代码走完选择内容、生成全部图片、逐张检查、保存相册和直接分享；真机确认微信分享菜单与相册权限。
- 部署时只需更新 `storyBooks`；不得从本分支覆盖 `chatInterview`、`organizeMemory`、`personalMemory` 或图片生成函数。
