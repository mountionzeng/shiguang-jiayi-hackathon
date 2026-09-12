# 书稿键盘空白与本机照片显示修复

## 症状与依据

用户 Android 真机截图：键盘弹出后标题仍可见，正文几乎完全消失，键盘上方留下大片空白；收起键盘后正文恢复，照片却显示“本机照片”编号。

- 布局使用 `calc(100vh - keyboardHeight)`。当微信随键盘缩小视口时，会从已经缩小的高度再扣键盘高度。改用 onLoad 捕获的实际窗口高度（px），键盘事件只扣一次；忽略同宽度的缩小 resize，兼容 resize 与键盘事件先后顺序。
- 图片通过 `FileSystemManager.saveFile`（未指定 filePath）保存为微信管理的本地缓存文件；旧读取器却只接受 USER_DATA_PATH 下的用户文件，将有效缓存路径拒绝。微信官方文档明确两类文件不同，且端侧协议不同，不能猜测完整路径。
- 旧测试只模拟了 `saveFile` 返回 USER_DATA_PATH 内路径，遗漏真实缓存文件场景。新增失败测试复现后修正。

## 修复与不变项

- 保持顶部四按钮、标题与正文、原生输入和既有纸色设计，不添加遮罩或改导航。
- 新照片显式保存到 USER_DATA_PATH，以独立照片 ID 命名，保留原扩展名，验证文件可访问后才返回成功。
- 旧照片读取支持缓存文件：通过微信 getSavedFileList 的真实名单核验，不硬编码平台路径、不允许外部 URL；原存储映射和文件均不删除、不迁移。
- 兼容旧正文中的照片编号标记，读取到原文件时重新插入真实 editor 图片。
- 异步图片读取在应用结果前检查本次加载序号和编辑状态，不能覆盖加载期间输入的新正文。历史图片预览也检查当前选中版本，避免旧请求覆盖新选择。
- 云端数据入口保持开启，不修改 AppID、环境、人物或权限规则。照片字节不上传；文字与不透明图片引用仍随书稿版本保存云端。
- 未清缓存、未删除或改写用户真实故事、未创建真实测试人物/故事。

## 验证与边界

- TypeScript 类型检查、127 项测试、book 官方 WXML 编译与 git diff --check 通过。
- 新测试覆盖缓存路径恢复、外链拒绝、新照片显式保存路径、键盘重复扣减、旧标记重开变图片、异步读取不覆盖输入。
- 微信开发者工具只读打开现有书稿并检查布局；模拟器点击正文没有调出手机软键盘，因此 Android 真机最终表现不能靠模拟器宣称已通过。
- 若照片已经被系统清理、换机或本机映射丢失，单凭云端 ID 无法恢复原图；保留引用，不伪造照片，不自动删除占位。
- 回归时用同一部手机和同一微信账号扫码：打开原稿确认原照片、点正文检查键盘上方可读可滚动，再用非隐私测试图检查插入/保存/重开。
- 最终构建的 GUI 检查被 Mac 锁屏阻止，尚无最终真机视觉验收。官方 CLI 开发预览已成功（1,474,651 字节），二维码位于工作区父目录 `shiguang-keyboard-photo-preview-20260911.png`。未发布、未上传体验版、未提交合并或 push。

## 参考

- [微信文件系统：本地缓存文件与本地用户文件](https://developers.weixin.qq.com/miniprogram/dev/framework/ability/file-system.html)
- [FileSystemManager.saveFile](https://developers.weixin.qq.com/miniprogram/dev/api/file/FileSystemManager.saveFile.html)
- [原生 editor](https://developers.weixin.qq.com/miniprogram/dev/component/editor.html)
