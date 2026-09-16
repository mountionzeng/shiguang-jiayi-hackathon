# 第一轮样稿｜未通过素材验收

仅在 Codex 独立工作目录交付。BRIEF 所在分支、源母版和 miniprogram 均未修改。

## 文件
- drafts/bookmark-draft.png：A 玉石绿书签。
- drafts/closed-book-draft.png：B 合上的线装书，书顶不带丝带。
- drafts/book-ribbon-draft.png：独立丝带图，但透明背景未实现。
- drafts/book-spine-draft.png：C 书脊。
- preview/comparison-with-bird.png：象牙纸同框对照，使用生成器合成，鸟的像素并非原图无损粘贴。
- archive-do-not-use/：一次透明背景提取重试，仍不合格。

## 验证结果及缺口
- 四个单件初稿及重试均经 sips 检查：hasAlpha: no，棋盘格烘焙在像素中。不可作为透明母版使用。
- 单件长边均超过 1024 px，无文字。
- 画风仍有偏差：物件的纸纹较鸟更细密，书封多了枝叶装饰，书脊形体比 1:4.5 更细长。
- 未生成 app-optimized：应先解决透明及构图缺口，再压缩；不冒充满足体积规格的交付。
- 未进行小程序运行、40px 书签可读性或六字标题叠加验收。

## 生成方式及提示词摘要
使用内置 image_gen。以鸟、树枝、鸟窝及 personal/family 入口五张母版作风格参考；要求象牙宣纸、水彩彩铅颗粒、低饱和玉绿、左上光、无文字、真实透明；分别生成书签、简洁合书、书脊与独立丝带。透明背景失败后每件只执行一次 background-extraction 重试，结果仍失败，停止重试。

对照图提示：在象牙纸上按书签、合书、书脊、原鸟排列，去除棋盘背景，保留物件外观，无文字。
