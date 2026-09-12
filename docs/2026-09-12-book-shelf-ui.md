# 人生之书书架与按钮图标改版说明

日期：2026-09-12

分支：`feat/book-shelf-ui`

基线：`feat/story-structure` 的 `4fe7e4a`

## 完成内容

「人生之书」列表由普通记忆卡片改为两列书架。每个故事是一册带书脊、书口和封面信息的书，四册循环使用玉石绿、湖水蓝、杏金和朱砂浅色。页面同时提供空故事、新故事、拖起、原位和落位提示的视觉状态；拖动排序的数据更新继续由故事结构会话接入。

故事详情页保留原有文案和行为，把“打开整理好的章节、继续讲这个故事、返回所有故事”从三枚大胶囊改为书签式操作区，并补充统一线条图标和简短说明。书稿页原有文字按钮也全部配上同一套 24 单位网格、圆角端点、1.7 单位线宽的图标。

新背景只用于「人生之书」列表及故事详情：中央阅读区接近纯纸白，极淡的玉石绿、湖水蓝、杏金水彩只留在边缘。底部导航的三张水彩图标按用户确认保持不变。

## 文件与素材

### 小程序代码

- `miniprogram/pages/stories/stories.wxml`：书架、空书、新故事占位和故事详情操作区。
- `miniprogram/pages/stories/stories.wxss`：四种书封、书脊与书口、拖动视觉、故事详情按钮与记忆卡片。
- `miniprogram/pages/book/book.wxml`：给书稿页现有文字按钮补图标，文字和事件不变。
- `miniprogram/pages/book/book.wxss`：导入图标表，并补小屏工具栏约束。
- `miniprogram/pages/book/action-icons.wxss`：18 个 SVG data URI 图标及浅色底、深色底两套颜色。

### 新增素材

| 文件 | 尺寸 | 体积 | 用途 |
|---|---:|---:|---|
| `miniprogram/assets/illustrations/story-paper.jpg` | 719×1556 | 77,529 B | 人生之书列表与故事详情背景 |
| `design-handoff/poster-rollup-2026-08-29/assets/masters/story-paper-master.png` | 853×1844 | 1,805,606 B | 未压缩生成母版，不进入主包 |
| `design-handoff/poster-rollup-2026-08-29/assets/app-optimized/story-paper.jpg` | 719×1556 | 77,529 B | 小程序用 JPEG 的交接副本 |
| `design-handoff/poster-rollup-2026-08-29/assets/app-optimized/story-paper.png` | 719×1556 | 1,355,101 B | 流水线保留的无损 PNG，不进入主包 |
| `design-handoff/poster-rollup-2026-08-29/references/book-shelf-before-2026-09-12.jpg` | 1260×2720 | 853,652 B | 用户提供的改版前书架参考 |
| `design-handoff/poster-rollup-2026-08-29/references/story-detail-before-2026-09-12.jpg` | 1260×2720 | 649,327 B | 用户提供的改版前详情参考 |

本次没有替换或删除既有位图。`story-tab-personal.png`、`story-tab-chat.png`、`story-tab-family.png` 保持原文件。新图由内置图像生成工具制作；提示词要求暖白宣纸、中央 80% 干净留白、边缘极淡的既有四色水彩，并排除鸟、树枝、书、文字、UI、Logo 和水印。

## 主包体积

使用同一方法统计 `miniprogram/` 下未压缩源文件：

| 版本 | 字节 | MiB |
|---|---:|---:|
| 改版前 `4fe7e4a` | 1,593,464 | 1.520 |
| 改版后 | 1,692,925 | 1.614 |
| 增量 | 99,461 | 0.095 |

新增主包位图只有 `story-paper.jpg`，为 77,529 B；其余增量来自 WXML/WXSS 与 SVG data URI。当前原始源文件仍低于 2 MiB。没有生成新的开发预览码，因为同一微信账号后生成的预览会覆盖问题四会话手上的预览；因此这里没有冒充微信开发者工具最终上传包的精确体积，合并前由协调会话在统一分支生成一次预览并记录最终数字。

## WXML / WXSS 用法

背景直接作为页面底层图片：

```xml
<image class="archive-paper" src="/assets/illustrations/story-paper.jpg" mode="scaleToFill" aria-hidden="true" />
```

书封依靠顺序循环换色，动态故事名、摘要与数量仍由 WXML 渲染，没有烘焙进图片：

```xml
<button class="story-book" wx:for="{{stories}}" wx:key="key">
  <view class="book-spine"></view>
  <view class="book-cover">
    <view class="book-name serif">{{item.title}}</view>
    <view class="book-meta">{{item.label}}</view>
  </view>
</button>
```

```css
.story-book:nth-child(4n+2) { background: #e2eaf0; }
.story-book:nth-child(4n+3) { background: #f1e7d3; }
.story-book:nth-child(4n+4) { background: #f1e0d9; }
.story-book.is-dragging { transform: translateY(-18rpx) rotate(-3deg) scale(1.03); }
.story-book.is-drop-target { outline: 3rpx dashed var(--jade); }
```

图标以 WXSS SVG data URI 使用。浅色背景默认是玉石绿，深色背景追加 `icon-on-dark`：

```xml
<view class="action-icon icon-save" aria-hidden="true"></view>
<view class="action-icon icon-record icon-on-dark" aria-hidden="true"></view>
```

要换色，在 `action-icons.wxss` 中修改对应 SVG 的 `stroke` 后重新进行 base64 编码。当前图标名为：`back`、`photo`、`save`、`more`、`undo`、`memories`、`up`、`down`、`delete`、`history`、`ai`、`new`、`version`、`record`、`insert`、`remove`、`restore`。

## 验证结果

- `tsc --noEmit`：通过。
- `npm run check`：类型检查通过；测试阶段因当前 Codex 沙箱禁止 `tsx` CLI 创建本地 IPC socket，以 `listen EPERM` 退出。该失败不是测试断言失败。
- 等价测试命令 `node --import tsx --test tests/*.test.ts tests/*.test.js`：166 项通过，0 失败。
- 微信官方 `wcc`：11 个 WXML 文件编译通过。
- 微信官方 `wcsc`：13 个 WXSS 文件编译通过。
- `git diff --check`：通过。
- 浏览器代理渲染：390 px 书架与故事详情通过一次视觉检查；320 px 故事详情未出现文字截断或按钮挤压。预览图保存在本次 Codex 任务的 `outputs/` 目录，不作为微信真机通过的证据。

## 尚未验证

- 未生成微信预览，未做真机触摸、滚动和长标题验收。
- 未验证系统深色模式；页面当前仍按现有小程序的浅色纸张主题设计。
- 未在 320 px 真机验证。320 px 浏览器代理渲染可读，WXSS 也已加入 340 px 以下工具栏图标缩小规则，但仍需实机检查微信字体度量和中文是否拥挤。
- 未验证键盘弹出时的书稿页布局；本次只为原按钮补图标，没有改键盘高度或编辑器逻辑。
- 未接入真实拖动排序逻辑；已提供 `is-dragging`、`is-drag-origin`、`is-drop-target`、`is-sorting` 状态样式。
- 故事数据目前没有稳定的人物数字段；WXML 已预留 `peopleCount` 展示位，等故事结构会话提供字段后显示。

## 遗留问题与建议

1. 故事结构会话合并时，把拖动事件接到现有书封节点，并持久化排序；不要只做可拖动但重开页面恢复旧顺序的假交互。
2. `capture-note-paper.png` 与 `capture-memoir-book.png` 仍被底部记录方式弹层引用。待“随手记 / 回忆录”二选一完全取消后再删，当前不能提前删除。
3. `memory-bird.png`、`memory-branch.png`、`memory-nest.png` 在当前代码中无人引用，合计约 266 KB。确认底部导航和后续海报不再从主包读取它们后，可另开一次纯素材清理提交。
4. 最终合并后使用指定的 Stable ARM64 微信开发者工具生成一次统一预览，记录真实上传包大小，并在 320 px、小屏安卓、iPhone 刘海屏和长故事名下各看一次。
