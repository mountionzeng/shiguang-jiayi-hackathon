# 逐按钮验收清单与生成反馈

日期：2026-10-03。分支：`codex/restore-approved-ui-20260930`。

## 当前结论

生成反馈代码已完成，`npm run check` 的类型检查和 1061 项测试通过，0 失败。电脑仍锁屏，当前版本未编译验收、未截图、未实际逐按钮点击；以下项目均待实测，不能据此称为全部通过。

已接入：小忆三个编辑入口、对话回应、整理成片段、看照片写文字、正文预览生成、插图/底图/封面、朋友圈文字图排版、公开故事卡和邀请图片。文字用三个轻轻起伏的点；图片用呼吸图框。只使用 CSS，不增加网络请求、JS 计时器或虚构进度；系统支持时遵循减少动态效果偏好。任务结束后卸载动画。

图片任务每次状态返回都会更新行内文案；stored、failed、unknown 均停止动画，即使后续列表加载失败。封面列表失败仍保留重试，但不再把已完成任务显示为生成中。两项新增回归分别覆盖这三种结束状态。删掉旧对话圆点样式和书稿中两处因外层条件排除而永不显示的按钮。

## 按钮验收方法

先重开「临时图片测试簿」第一章核对原文基线，确认上轮 `虚构测试1002` 已移除。再按首页→记忆→书稿→图片→发送→家庭→我的顺序验收；每个入口记录点击时间、首次可见反馈、可操作结果时间、错误提示、页面/调用日志。慢项用 `ai.organize`、`ai.biography`、`image.submit`、`image.status`、`image.list` 日志区分传输等待与模型/存储阶段。网络传输完成不等于业务成功。

每个 handler 的 data-action/data-purpose 等分支分别点；列表重复行至少选一项，并覆盖空状态、禁用状态和可重试失败。原生选择器、弹窗的选项属于对应 handler 的补充验收，不能只打开弹窗就算完成。对文字和图片真实生成，要看到忙碌→结果/失败，再返回重开；写入后保存并重开，测试结束清理增量。

向真实亲友发消息、发布朋友圈、不可恢复删除、账号清空和扩大权限只验收入口/取消分支，不执行最终动作。语音输入法、手机相册、微信转发等需单独标注真机限制。当前没有因验收而修改 VPN、锁屏设置、功能开关或共享云端。

## 慢在哪里：已有证据与待测项

已有控制流证据：章节图片原来提交后重读整房与列表并固定等 3 秒，封面等 4 秒；前序修复已省去这些步骤。串行图片状态请求改为最多两路；云端单条记忆从整房扫描改为定向读取，HTTP 连接可复用，美观检查移到后台。详见 `2026-10-03-generation-performance.md`。这些不构成手机实测提速比例。

四个云函数修复尚未部署，部署确认仍待用户回复。真实图片/封面生成耗时、各页面首次响应、此次动画视觉表现均未测；不把自动化检查当成实际点击。云端 sweep 触发器仍需核实。

## 页面入口清单

从 24 个页面和 1 个共享导航组件提取 319 个交互绑定位置（含按钮、可点击图文和选择器）；动态列表仅列模板一次。此清单记录源码入口，不代表全部入口在当前账号可见。

| 页面 | 绑定位置数 | 本轮实测 |
| --- | ---: | --- |
| `pages/index/index` | 15 | 待解锁 |
| `pages/me/me` | 16 | 待解锁 |
| `pages/personal-memory/personal-memory` | 5 | 待解锁 |
| `pages/account-link/account-link` | 3 | 待解锁 |
| `pages/profiles/profiles` | 11 | 待解锁 |
| `pages/archive/archive` | 23 | 待解锁 |
| `pages/stories/stories` | 26 | 待解锁 |
| `pages/story-migration/story-migration` | 4 | 待解锁 |
| `pages/recall/recall` | 3 | 待解锁 |
| `pages/interview/interview` | 26 | 待解锁 |
| `pages/invite/invite` | 6 | 待解锁 |
| `pages/room/room` | 6 | 待解锁 |
| `pages/review/review` | 6 | 待解锁 |
| `pages/book/book` | 79 | 待解锁 |
| `pages/story-images/story-images` | 12 | 待解锁 |
| `pages/story-cover/story-cover` | 6 | 待解锁 |
| `packages/story-sharing/pages/invite/index` | 14 | 待解锁 |
| `packages/story-sharing/pages/read/index` | 7 | 待解锁 |
| `packages/story-sharing/pages/receive/index` | 4 | 待解锁 |
| `packages/story-sharing/pages/card/index` | 4 | 待解锁 |
| `packages/story-sharing/pages/social/index` | 18 | 待解锁 |
| `packages/audio/pages/create/create` | 4 | 待解锁 |
| `packages/audio/pages/voices/voices` | 6 | 待解锁 |
| `packages/audio/pages/player/player` | 5 | 待解锁 |
| `components/story-switcher/story-switcher` | 10 | 待解锁 |

## pages/index/index

| 行 | 操作/文案 | 绑定与分支 | 结果 |
| ---: | --- | --- | --- |
| 11 | 打开我的 | bindtap=openMyHome | 待实测 |
| 25 | 换一个故事聊，现在是{{currentStoryLabel}} | bindtap=toggleStoryChooser | 待实测 |
| 40 | 拾 光 录 {{item.title}} {{item.subtitle}} {{item.memoryCount}} 段记忆 {{item.chapterCount}} 章节 {{item.p… | bindchange=onBookSlideChange | 待实测 |
| 51 | 打开故事 {{item.title}} | bindtap=openMemoryArchive | 待实测 |
| 81 | 这本书里的记忆 | catchtap=openStoryMemories | 待实测 |
| 90 | 这本书整理好的章节 | catchtap=openStoryChapters | 待实测 |
| 99 | 这本书里的人物，在记忆之家查看 | catchtap=openPeople | 待实测 |
| 129 | 写下我的名字 | bindtap=createFirstProfile | 待实测 |
| 141 | 换一个推荐问题 | bindtap=changeRecommendedQuestion | 待实测 |
| 148 | 回答每日一问 | bindtap=continueRecommendedQuestion | 待实测 |
| 160 | 回答每日一问：{{currentStoryLabel}} | bindtap=startCurrentStory | 待实测 |
| 180 | {{part}} {{item.title}} {{item.excerpt}} {{item.countLabel}} 继续聊 | bindtap=continueStory; data-id={{item.id}}; data-title={{item.storyTitle}} | 待实测 |
| 213 | 换到{{item.title}} | bindtap=chooseStory; data-title={{item.title}}; data-key={{item.key}} | 待实测 |
| 230 | 先随便聊聊，不选故事 | bindtap=chooseNoStory | 待实测 |
| 243 | 开一个新故事 | bindtap=startNewStory | 待实测 |

## pages/me/me

| 行 | 操作/文案 | 绑定与分支 | 结果 |
| ---: | --- | --- | --- |
| 63 | {{item.avatarText}} {{item.roomName}} 以“{{item.memberName}}”的身份加入 · {{item.relation}} › | bindtap=openJoinedRoom; data-id={{item.familyId}} | 待实测 |
| 77 | 家 {{roomName &#124;&#124; "我的拾光房间"}} {{protagonistName ? "主人公 " + protagonistName : "还没有写主人公的名字"}} › | bindtap=startEditRoom | 待实测 |
| 85 | 忆 所有记忆 写没写进书的都在这里 › | bindtap=openArchive | 待实测 |
| 93 | 人 家人和朋友 拉人进来，每个人的权限写在名字旁边 › | bindtap=openProfiles | 待实测 |
| 101 | 家 记忆之家 查看亲友共享的记忆 › | bindtap=openFamilyHome | 待实测 |
| 109 | 照 云端照片 {{cloudPhotoCount}} 张 · {{cloudPhotoBytes}} 还有 {{pendingPhotoCount}} 张没存到云端 {{checkingPhot… | bindtap=deleteCloudPhotos | 待实测 |
| 123 | 铃 家人生日提醒 后续版本接入 › | bindtap=notYet | 待实测 |
| 135 | 屏 在电脑上继续 选择微信故事，生成一次性电脑登录码 › | bindtap=openAccountLink | 待实测 |
| 136 | 称 修改个人信息 称呼与一个字头像 › | bindtap=editAccountProfile | 待实测 |
| 141 | 忆 小忆记住的事 查看、暂停或让小忆忘记 › | bindtap=openPersonalMemory | 待实测 |
| 142 | 私 在线 AI 授权 本次允许或关闭文字处理；看照片会另外询问 › | bindtap=configureAiPrivacy | 待实测 |
| 147 | 清 清空当前账号云端档案 删除人物、记忆、书稿和云端照片，无法撤销 › | bindtap=clearCurrentAccountData | 待实测 |
| 164 | 取消 | bindtap=cancelEditRoom | 待实测 |
| 165 | 保存 | bindtap=saveRoomProfile | 待实测 |
| 179 | 取消 | bindtap=cancelAccountProfile | 待实测 |
| 180 | 保存 | bindtap=saveAccountProfile | 待实测 |

## pages/personal-memory/personal-memory

| 行 | 操作/文案 | 绑定与分支 | 结果 |
| ---: | --- | --- | --- |
| 6 | 重新读取 | bindtap=refresh | 待实测 |
| 10 | {{enabled ? '暂停' : '开启'}} | bindtap=toggleEnabled | 待实测 |
| 25 | 说得对 | bindtap=confirmInsight; data-key={{item.lineageKey}} | 待实测 |
| 26 | 不对 | bindtap=correct; data-key={{item.lineageKey}} | 待实测 |
| 27 | 忘掉 | bindtap=forget; data-key={{item.lineageKey}} | 待实测 |

## pages/account-link/account-link

| 行 | 操作/文案 | 绑定与分支 | 结果 |
| ---: | --- | --- | --- |
| 7 | 复制登录码 | bindtap=copyCode | 待实测 |
| 11 | {{item.title}} {{item.detail}} {{item.excerpt}} 生成电脑码 › | bindtap=choose; data-key={{item.key}}; data-title={{item.title}} | 待实测 |
| 14 | {{loadError}} | bindtap=refresh | 待实测 |

## pages/profiles/profiles

| 行 | 操作/文案 | 绑定与分支 | 结果 |
| ---: | --- | --- | --- |
| 13 | 重新加载 | bindtap=retryLoad | 待实测 |
| 18 | 创建并切换到这本书 | bindtap=createBook | 待实测 |
| 26 | 重新加载 | bindtap=retryLoad | 待实测 |
| 32 | 加进来 | bindtap=addPerson | 待实测 |
| 60 | 保存 | bindtap=saveEdit | 待实测 |
| 61 | 取消 | bindtap=cancelEdit | 待实测 |
| 64 | 编辑{{item.name}} | bindtap=startEdit; data-id={{item.id}} | 待实测 |
| 65 | 删除{{item.name}} | bindtap=removeMember; data-id={{item.id}} | 待实测 |
| 83 | 最近删除 · {{trash.length}} {{trashOpen ? '收起' : '展开'}} | bindtap=toggleTrash | 待实测 |
| 93 | 恢复 | bindtap=restoreMember; data-id={{item.id}} | 待实测 |
| 99 | 清空当前账号数据 | bindtap=clearCurrentFamilyData | 待实测 |

## pages/archive/archive

| 行 | 操作/文案 | 绑定与分支 | 结果 |
| ---: | --- | --- | --- |
| 9 | 重新加载 | bindtap=retryLoad | 待实测 |
| 11 | 查看《{{item.bookTitle}}》· {{item.chapter}} | bindtap=openPlacement; data-member={{item.memberId}}; data-chapter={{item.chapterId}} | 待实测 |
| 18 | 小忆 | bindtap=openXiaoyi | 待实测 |
| 28 | 关掉 | bindtap=closeXiaoyi | 待实测 |
| 31 | 问我一个问题 | bindtap=askXiaoyiQuestion; data-mode=ask | 待实测 |
| 32 | 帮我写一下 | bindtap=askXiaoyiQuestion; data-mode=write | 待实测 |
| 44 | 就用我的原话 | bindtap=useXiaoyiOriginal | 待实测 |
| 45 | {{xiaoyiLoading ? '小忆正在处理…' : '请小忆整理'}} | bindtap=organizeXiaoyiAnswer | 待实测 |
| 50 | 接到记忆后面 | bindtap=useXiaoyiDraft | 待实测 |
| 54 | {{showOriginal ? '收起原话' : '查看原话'}} | bindtap=toggleOriginal | 待实测 |
| 55 | 撤回到原话 | bindtap=revertToSpoken | 待实测 |
| 56 | {{showHistory ? '收起修改历史' : '查看修改历史'}} | bindtap=toggleHistory | 待实测 |
| 68 | 暂不归类{{!editStory ? '，已选中' : ''}} | bindtap=chooseEditStory; data-title= | 待实测 |
| 72 | {{item}}{{editStory === item ? '，已选中' : ''}} | bindtap=chooseEditStory; data-title={{item}} | 待实测 |
| 78 | {{savingEdit ? '正在保存' : '保存修改'}} | bindtap=saveEdit | 待实测 |
| 79 | 整理进书，预览后写入 | bindtap=organizeIntoBook | 待实测 |
| 86 | 返回记忆列表 | bindtap=closeEditor | 待实测 |
| 90 | 选择记忆，整理进书 | bindtap=organizeIntoBook | 待实测 |
| 95 | 删除{{item.title}} | bindtap=deleteMemory; data-id={{item.id}}; data-title={{item.title}} | 待实测 |
| 96 | 编辑{{item.title}} | bindtouchstart=onNoteTouchStart; bindtouchend=onNoteTouchEnd; bindtap=openMemory; data-id={{item.id}} | 待实测 |
| 110 | 删除{{item.title}} | bindtap=deleteMemory; data-id={{item.id}}; data-title={{item.title}} | 待实测 |
| 111 | 编辑{{item.title}} | bindtouchstart=onNoteTouchStart; bindtouchend=onNoteTouchEnd; bindtap=openMemory; data-id={{item.id}} | 待实测 |
| 124 | 记录一段记忆 | bindtap=startRecording | 待实测 |

## pages/stories/stories

| 行 | 操作/文案 | 绑定与分支 | 结果 |
| ---: | --- | --- | --- |
| 7 | 重新加载 | bindtap=retryLoad | 待实测 |
| 10 | 打开整理好的章节 翻开目录，继续读写 › | bindtap=openSelectedManuscript | 待实测 |
| 15 | 继续讲这个故事 从新的记忆接着说 › | bindtap=continueStory | 待实测 |
| 20 | 返回所有故事 回到人生之书 | bindtap=backToStories | 待实测 |
| 24 | 删除这个故事 | bindtap=deleteSelectedStory | 待实测 |
| 27 | {{item.title &#124;&#124; '一段记忆'}} {{item.aiLabel}} {{item.text}} 点开编辑或调整归类 | bindtap=editMemory; data-id={{item.id}} | 待实测 |
| 37 | 打开故事：{{item.title}}，{{item.label}} | bindtap=openStory; data-key={{item.key}} | 待实测 |
| 45 | 创建新故事书 | bindtap=openCreate | 待实测 |
| 50 | 整理记忆，{{ungroupedCount}} 段还没放进故事 | bindtap=openMemories | 待实测 |
| 58 | 新建一本故事书 | bindtap=openCreate | 待实测 |
| 59 | 待确认的旧内容 {{pendingMigrationCount}} 项需要确认去向 › | bindtap=openMigration | 待实测 |
| 63 | 最近删除{{deletedItems.length ? ' · ' + deletedItems.length : ''}} | bindtap=openTrash | 待实测 |
| 68 | view | bindtap=closeCreate | 待实测 |
| 69 | 新建一本故事书 | bindtap=closeCreate | 待实测 |
| 70 | 新建一本故事书 客观记录 AI 共创 可以空白开始，也可选记忆作为这本书的素材。 {{item.title &#124;&#124; item.text}} 创建并打开 取消 | catchtap=keepCreateOpen | 待实测 |
| 73 | 客观记录 AI 共创 | bindchange=onCreateMode | 待实测 |
| 79 | {{item.title &#124;&#124; item.text}} | bindchange=onCreateMemories | 待实测 |
| 86 | 创建并打开 | bindtap=createBook | 待实测 |
| 87 | 取消 | bindtap=closeCreate | 待实测 |
| 91 | view | bindtap=closeTrash | 待实测 |
| 92 | 最近删除，点空白处关闭 | bindtap=closeTrash | 待实测 |
| 93 | 最近删除 删掉的故事和记忆都在这里，恢复后原样回来。永久删除后就找不回来了。 {{item.title}} {{item.deletedLabel}} 永久删除 恢复 这里是空的。 清空已删除的… | catchtap=keepTrashOpen | 待实测 |
| 102 | 永久删除 | bindtap=purgeItem; data-id={{item.id}}; data-title={{item.title}} | 待实测 |
| 103 | 恢复 | bindtap=restoreItem; data-type={{item.type}}; data-id={{item.id}} | 待实测 |
| 107 | 清空已删除的记忆 · {{deletedMemoryCount}} | bindtap=purgeAll | 待实测 |
| 108 | 关闭 | bindtap=closeTrash | 待实测 |

## pages/story-migration/story-migration

| 行 | 操作/文案 | 绑定与分支 | 结果 |
| ---: | --- | --- | --- |
| 11 | 《{{story.bookTitle &#124;&#124; story.title}}》 · {{story.writingMode === 'creative' ? 'AI 共创' : '… | bindtap=assign; data-pending={{item.id}}; data-story={{story.id}} | 待实测 |
| 16 | 新建客观记录故事并放入 | bindtap=createNew; data-pending={{item.id}} | 待实测 |
| 24 | 《{{story.bookTitle &#124;&#124; story.title}}》 · {{story.writingMode === 'creative' ? 'AI 共创' : '… | bindtap=assignAsset; data-pending={{asset.id}}; data-story={{story.id}} | 待实测 |
| 29 | 新建客观记录故事并放入 | bindtap=createNewAsset; data-pending={{asset.id}} | 待实测 |

## pages/recall/recall

| 行 | 操作/文案 | 绑定与分支 | 结果 |
| ---: | --- | --- | --- |
| 9 | 重新加载 | bindtap=retryLoad | 待实测 |
| 13 | 接着聊{{item.title}} | bindtap=continueMemory; data-id={{item.id}}; data-title={{item.storyTitle}}; data-story={{item.storyId}}; data-choice={{item.needsStoryChoice}} | 待实测 |
| 37 | 随手记一段 | bindtap=startQuickNote | 待实测 |

## pages/interview/interview

| 行 | 操作/文案 | 绑定与分支 | 结果 |
| ---: | --- | --- | --- |
| 37 | 选择随手记，先留下几句话 | bindtap=chooseType; data-type=note | 待实测 |
| 55 | 选择回忆录，和小忆多聊几轮 | bindtap=chooseType; data-type=memoir | 待实测 |
| 74 | {{memoryType === 'note' ? '开始随手记' : '开始聊回忆'}} → | bindtap=beginInterview | 待实测 |
| 147 | {{asking ? '小忆正在回应' : '发送'}} | bindtap=send | 待实测 |
| 154 | {{importing ? '正在导入…' : '导入'}} | bindtap=importMemory | 待实测 |
| 156 | {{organizing ? '正在整理…' : asking ? '小忆正在回应…' : '整理成片段'}} | bindtap=finish | 待实测 |
| 178 | {{importAiLoading ? '正在看…' : '让 AI 看看照片'}} | bindtap=generateImportCaption | 待实测 |
| 181 | 取消 | bindtap=cancelPhotoImport | 待实测 |
| 182 | {{importing ? '正在保存…' : (importCaption ? '保存' : '跳过并保存')}} | bindtap=savePhotoImport | 待实测 |
| 194 | 继续选择章节 | bindtap=continueToChapter | 待实测 |
| 195 | 查看这段记忆 | bindtap=viewSavedMemory | 待实测 |
| 196 | 返回 | bindtap=leaveSavedMemory | 待实测 |
| 246 | 小忆 | bindtap=openXiaoyi | 待实测 |
| 260 | 关掉 | bindtap=closeXiaoyi | 待实测 |
| 263 | 问我一个问题 | bindtap=askXiaoyiQuestion; data-mode=ask | 待实测 |
| 264 | 帮我写一下 | bindtap=askXiaoyiQuestion; data-mode=write | 待实测 |
| 276 | 就用我的原话 | bindtap=useXiaoyiOriginal | 待实测 |
| 277 | {{xiaoyiLoading ? '小忆正在处理…' : '请小忆整理'}} | bindtap=organizeXiaoyiAnswer | 待实测 |
| 282 | 接到草稿后面 | bindtap=useXiaoyiDraft | 待实测 |
| 290 | 片 先存为未整理片段 以后想清楚了，再把它放进某个故事 {{storyTitle === '' ? '✓' : ''}} | bindtap=chooseFragment | 待实测 |
| 303 | {{item.title}} · {{item.chapterCount ? item.chapterCount + '章 · ' : ''}}{{item.count}}段记忆 | bindtap=chooseStory; data-key={{item.key}} | 待实测 |
| 326 | {{item.avatarText}} {{item.name}} {{item.relation}} {{item.selected ? '✓' : ''}} | bindtap=toggleRelatedMember; data-id={{item.id}} | 待实测 |
| 347 | 私 仅自己 暂时不分享给任何人 {{audienceMemberIds.length === 0 ? '✓' : ''}} | bindtap=choosePrivate | 待实测 |
| 360 | {{item.avatarText}} {{item.name}} {{item.relation}} · 可阅读 {{item.selected ? '✓' : ''}} | bindtap=toggleAudienceMember; data-id={{item.id}} | 待实测 |
| 384 | 继续编辑 | bindtap=backToChat | 待实测 |
| 385 | {{saving ? '正在保存…' : (sharedFamilyId ? '提交给主人确认' : selectedStoryKey ? '保存并选择章节' : '保存这段记忆')}} | bindtap=save | 待实测 |

## pages/invite/invite

| 行 | 操作/文案 | 绑定与分支 | 结果 |
| ---: | --- | --- | --- |
| 44 | 生成邀请图片 | bindtap=createInvitation | 待实测 |
| 50 | image | bindtap=previewPoster | 待实测 |
| 52 | 发送邀请图片 | bindtap=sharePoster | 待实测 |
| 53 | {{albumSaving ? '保存中…' : '保存邀请图片到相册'}} | bindtap=savePoster | 待实测 |
| 54 | 也可以直接转发小程序 | open-type=share | 待实测 |
| 75 | {{invitation.acceptedByMe ? '进入记忆之家' : '接受邀请，一起写'}} | bindtap=acceptInvitation | 待实测 |

## pages/room/room

| 行 | 操作/文案 | 绑定与分支 | 结果 |
| ---: | --- | --- | --- |
| 4 | 人员管理 · 可删除 | bindtap=openPeople | 待实测 |
| 5 | ＋ 邀请亲友一起写 生成一张邀请图片，发给微信好友 › | bindtap=inviteFamilyMember | 待实测 |
| 13 | 重新加载 | bindtap=retryLoad | 待实测 |
| 18 | 看和{{item.name}}有关的记忆 | bindtap=choosePerson; data-id={{item.id}} | 待实测 |
| 38 | {{part}} {{item.title}} {{item.text}} {{item.aiLabel}} 故 {{item.storyLabel}} {{item.placeLabel}} | bindtap=openMemory; data-id={{item.id}} | 待实测 |
| 63 | 开始聊聊 | bindtap=startInterview | 待实测 |

## pages/review/review

| 行 | 操作/文案 | 绑定与分支 | 结果 |
| ---: | --- | --- | --- |
| 12 | 回到记忆之家 | bindtap=goBack | 待实测 |
| 46 | {{focus.confirmLabel}} | bindtap=reviewMemory; data-status=confirmed | 待实测 |
| 49 | 大致是，但有出入 | bindtap=reviewMemory; data-status=conflict | 待实测 |
| 52 | 不是这样 | bindtap=reviewMemory; data-status=rejected | 待实测 |
| 85 | 回记忆之家看看 | bindtap=goToMemoryHome | 待实测 |
| 86 | 先回去 | bindtap=goBack | 待实测 |

## pages/book/book

| 行 | 操作/文案 | 绑定与分支 | 结果 |
| ---: | --- | --- | --- |
| 3 | {{view === 'chapter' ? '目录' : '返回'}} | bindtap=onBack | 待实测 |
| 4 | {{pickingPhoto ? '添加中' : '照片'}} ⌄ | bindtap=togglePhotoMenu | 待实测 |
| 5 | {{refreshingStoryImage ? '准备插图' : '插入插图'}} | catchtouchstart=placeSelectedStoryImage | 待实测 |
| 6 | {{preparingSend ? '准备中' : '发送'}} ⌄ | bindtap=toggleSend | 待实测 |
| 7 | 发给家人 | catchtouchstart=openShareSelection | 待实测 |
| 8 | 补充经历 | bindtap=openAppendOwn | 待实测 |
| 9 | {{returningOwn ? '发送中' : '发回原作者'}} | bindtap=returnOwnExperience | 待实测 |
| 10 | {{saving ? '保存中' : '保存'}} | bindtap=saveEdits | 待实测 |
| 11 | 更多 | bindtap=showMore | 待实测 |
| 13 | 收起照片菜单 | bindtap=closePhotoMenu | 待实测 |
| 16 | 图片导入 › | bindtap=choosePhotoAction; data-action=import | 待实测 |
| 17 | 图片生成 › | bindtap=showPhotoGeneration | 待实测 |
| 20 | ‹ 返回照片菜单 | bindtap=togglePhotoMenu | 待实测 |
| 21 | 生成插图 › | bindtap=choosePhotoAction; data-action=illustration | 待实测 |
| 22 | 生成底图 › | bindtap=choosePhotoAction; data-action=backdrop | 待实测 |
| 23 | 生成封面 › | bindtap=choosePhotoAction; data-action=cover | 待实测 |
| 28 | {{item.label}} · {{item.title &#124;&#124; '还没起名字'}} › | bindtap=choosePhotoChapter; data-id={{item.id}} | 待实测 |
| 33 | 收起发送菜单 | bindtap=closeSend | 待实测 |
| 35 | 发送给家人 › | bindtap=chooseSend; data-destination=family | 待实测 |
| 36 | 发送到社交媒体 › | bindtap=chooseSend; data-destination=social | 待实测 |
| 39 | 亲友阅读与权限 | bindtap=selectTool; data-action=invite | 待实测 |
| 40 | 制作公开故事卡 | bindtap=selectTool; data-action=share-card | 待实测 |
| 41 | 历史版本 | bindtap=selectTool; data-action=history | 待实测 |
| 42 | 复制当前正文 | bindtap=selectTool; data-action=copy-draft | 待实测 |
| 43 | 放弃修改 | bindtap=selectTool; data-action=discard | 待实测 |
| 45 | 本章记忆 | bindtap=selectTool; data-action=memories | 待实测 |
| 46 | 上移本章 | bindtap=selectTool; data-action=up | 待实测 |
| 47 | 下移本章 | bindtap=selectTool; data-action=down | 待实测 |
| 48 | 删除本章 | bindtap=selectTool; data-action=delete-chapter | 待实测 |
| 49 | 历史版本 | bindtap=selectTool; data-action=history | 待实测 |
| 50 | AI 整理 | bindtap=selectTool; data-action=generate | 待实测 |
| 51 | 给本章配图 | bindtap=selectTool; data-action=images | 待实测 |
| 52 | 制作有声书 | bindtap=selectTool; data-action=audio | 待实测 |
| 55 | 切换写作模式 | bindtap=selectTool; data-action=mode | 待实测 |
| 56 | 新开一章 | bindtap=selectTool; data-action=new-chapter | 待实测 |
| 57 | 历史版本 | bindtap=selectTool; data-action=history | 待实测 |
| 58 | 命名存档 | bindtap=selectTool; data-action=version | 待实测 |
| 59 | AI 整理 | bindtap=selectTool; data-action=generate | 待实测 |
| 60 | 原始记忆 | bindtap=selectTool; data-action=sources | 待实测 |
| 61 | 这本书的图 | bindtap=selectTool; data-action=images | 待实测 |
| 62 | 记录经历 | bindtap=selectTool; data-action=record | 待实测 |
| 67 | 重新加载 | bindtap=retryLoad | 待实测 |
| 69 | 撤回这次整理 | bindtap=undoOrganize | 待实测 |
| 72 | {{view === 'chapter' ? '回到正文' : '回到目录'}} | bindtap=closePanel | 待实测 |
| 73 | 恢复此版 | bindtap=restoreVersion | 待实测 |
| 74 | 存为版本 | bindtap=saveVersion | 待实测 |
| 75 | {{sharingExcerpt ? '发送中…' : '确认发送'}} | bindtap=sendExcerpt | 待实测 |
| 76 | {{appendingOwn ? '保存中…' : '保存我的补充'}} | bindtap=appendOwnExperience | 待实测 |
| 94 | {{item.label}} {{item.title &#124;&#124; '还没起名字'}} {{item.memoryCount}} 段记忆 · {{item.photoCount}}… | bindtap=openChapter; data-id={{item.id}} | 待实测 |
| 102 | 新开一章 | bindtap=selectTool; data-action=new-chapter | 待实测 |
| 112 | 放进哪一章 › | bindtap=chooseChapterFor; data-id={{item.id}} | 待实测 |
| 135 | 小忆 | catchtouchstart=openXiaoyi | 待实测 |
| 145 | 收下 | bindtap=decidePendingEdit; data-id={{item.id}}; data-decision=accept | 待实测 |
| 146 | 不要 | bindtap=decidePendingEdit; data-id={{item.id}}; data-decision=reject | 待实测 |
| 149 | 把已收下的写入正文 | bindtap=finishPendingEdits | 待实测 |
| 157 | 关掉 | bindtap=closeXiaoyi | 待实测 |
| 160 | 问我一个问题 | bindtap=askXiaoyiQuestion; data-mode=ask | 待实测 |
| 161 | 帮我写一下 | bindtap=askXiaoyiQuestion; data-mode=write | 待实测 |
| 162 | 看看这一章的记忆 | bindtap=openXiaoyiMemories | 待实测 |
| 174 | 就用我的原话 | bindtap=useXiaoyiOriginal | 待实测 |
| 175 | {{xiaoyiLoading ? '小忆正在处理…' : '请小忆整理'}} | bindtap=organizeXiaoyiAnswer | 待实测 |
| 180 | 把这段放进正文待确认 | bindtap=useXiaoyiDraft | 待实测 |
| 195 | {{item.name}} {{item.relation}} | bindchange=onShareRecipients | 待实测 |
| 212 | {{item.label}} {{item.savedAt}} | bindtap=previewHistory; data-id={{item.id}} | 待实测 |
| 227 | {{item.title}} {{item.detail}} | bindchange=onOrganizeBook | 待实测 |
| 230 | {{item.text}} {{item.where}} | bindchange=onOrganizeMemories | 待实测 |
| 239 | {{item.label}}{{item.title ? ' ' + item.title : ''}} 新开一章 | bindchange=onOrganizeTarget | 待实测 |
| 253 | 保留原文，插入这段记忆 让 AI 结合本章重新衔接 | bindchange=onOrganizeMethod | 待实测 |
| 257 | 插入位置：{{insertionPoints[insertionIndex].label}} ⌄ | bindchange=onInsertionPoint | 待实测 |
| 285 | 空白的一章 自己写，或之后把记忆放进来 | bindtap=createChapter; data-story= | 待实测 |
| 288 | 用故事「{{item.title}}」开一章 这个故事的 {{item.count}} 条记忆原文会加入正文 | bindtap=createChapter; data-story={{item.title}} | 待实测 |
| 294 | {{item.label}}{{item.title ? ' ' + item.title : ''}} | bindtap=assignTo; data-id={{item.id}} | 待实测 |
| 297 | 新开一章放它 | bindtap=assignTo; data-id=new | 待实测 |
| 308 | 移出 | bindtap=removeFromChapter; data-id={{item.id}} | 待实测 |
| 317 | 放进本章 | bindtap=addToChapter; data-id={{item.id}} | 待实测 |
| 327 | 新开第一章 | bindtap=selectTool; data-action=new-chapter | 待实测 |
| 332 | 暂不整理 | bindtap=closePanel | 待实测 |
| 333 | {{switchingBook ? '正在切换…' : generating ? '正在整理…' : '下一步：预览正文'}} | bindtap=runOrganize | 待实测 |
| 334 | {{saving ? '正在写入…' : '确认写入正文'}} | bindtap=confirmOrganize | 待实测 |

## pages/story-images/story-images

| 行 | 操作/文案 | 绑定与分支 | 结果 |
| ---: | --- | --- | --- |
| 10 | 重新加载 | bindtap=retryLoad | 待实测 |
| 21 | {{submitting === group.id + ':illustration' ? '提交中' : '配一张插图'}} | bindtap=generate; data-id={{group.id}}; data-purpose=illustration | 待实测 |
| 24 | {{submitting === group.id + ':backdrop' ? '提交中' : '配一张底图'}} | bindtap=generate; data-id={{group.id}}; data-purpose=backdrop | 待实测 |
| 32 | 不用了 | bindtap=setBackdrop; data-chapter={{group.id}}; data-image= | 待实测 |
| 42 | 查看大图 | bindtap=previewImage; data-url={{image.url}} | 待实测 |
| 51 | {{submitting === group.id + ':illustration:' + image.imageId ? '提交中' : '参考这张再画'}} | bindtap=generate; data-id={{group.id}}; data-purpose=illustration; data-reference={{image.imageId}} | 待实测 |
| 54 | {{image.inText ? '已在正文中' : '选用这张插图'}} | bindtap=insertIntoBook; data-id={{image.imageId}}; data-chapter={{group.id}}; data-url={{image.url}} | 待实测 |
| 57 | 设为本章底图 | bindtap=setBackdrop; data-chapter={{group.id}}; data-image={{image.imageId}} | 待实测 |
| 60 | 不用了 | bindtap=setBackdrop; data-chapter={{group.id}}; data-image= | 待实测 |
| 63 | 删除 | bindtap=remove; data-id={{image.imageId}} | 待实测 |
| 76 | 查看大图 | bindtap=previewImage; data-url={{image.url}} | 待实测 |
| 83 | 删除 | bindtap=remove; data-id={{image.imageId}} | 待实测 |

## pages/story-cover/story-cover

| 行 | 操作/文案 | 绑定与分支 | 结果 |
| ---: | --- | --- | --- |
| 6 | 重新加载 | bindtap=retry | 待实测 |
| 12 | {{item.selected ? '取消选择' : '选择'}}{{item.kind === 'photo' ? '照片' : '插图'}}作为封面参考 | bindtap=toggleReference; data-id={{item.id}} | 待实测 |
| 21 | {{submitting ? '正在构思封面' : '生成一张封面'}} | bindtap=generate | 待实测 |
| 31 | 查看封面大图 | bindtap=preview; data-url={{item.url}} | 待实测 |
| 34 | {{item.selected ? '已是封面' : (!item.ready ? '等待审核' : '设为封面')}} | bindtap=choose; data-id={{item.imageId}} | 待实测 |
| 37 | 恢复纸本封面 | bindtap=choose; data-id= | 待实测 |

## packages/story-sharing/pages/invite/index

| 行 | 操作/文案 | 绑定与分支 | 结果 |
| ---: | --- | --- | --- |
| 11 | {{item.title &#124;&#124; '未命名章节'}} | bindchange=chooseChapters | 待实测 |
| 17 | switch | bindchange=chooseEdit | 待实测 |
| 19 | switch | bindchange=chooseCopy | 待实测 |
| 20 | switch | bindchange=chooseForward | 待实测 |
| 23 | 生成阅读邀请 | bindtap=create | 待实测 |
| 24 | 把邀请发给亲友 | open-type=share | 待实测 |
| 31 | 不收 | bindtap=decideReturn; data-return-id={{memory.returnId}}; data-decision=reject | 待实测 |
| 32 | 收进原故事 | bindtap=decideReturn; data-return-id={{memory.returnId}}; data-decision=accept | 待实测 |
| 38 | 撤销 | bindtap=revoke; data-invitation-id={{inv.invitationId}} | 待实测 |
| 44 | 拒绝 | bindtap=decide; data-invitation-id={{inv.invitationId}}; data-applicant-id={{person.applicantId}}; data-decision=reject | 待实测 |
| 45 | 核对并允许 | bindtap=decide; data-invitation-id={{inv.invitationId}}; data-applicant-id={{person.applicantId}}; data-decision=approve | 待实测 |
| 52 | 申请阅读 | bindtap=apply | 待实测 |
| 54 | 阅读获准的章节 | bindtap=openStory | 待实测 |
| 56 | {{loading ? '正在刷新…' : '刷新状态'}} | bindtap=refresh | 待实测 |

## packages/story-sharing/pages/read/index

| 行 | 操作/文案 | 绑定与分支 | 结果 |
| ---: | --- | --- | --- |
| 11 | 稍后再写 | bindtap=cancelEdit | 待实测 |
| 11 | 保存修改 | bindtap=saveEdit | 待实测 |
| 16 | 编辑这一章 | bindtap=beginEdit; data-id={{chapter.id}} | 待实测 |
| 19 | 放进我的故事里 | bindtap=receiveCopy | 待实测 |
| 20 | 申请再邀请一位亲友 | bindtap=createInvitation | 待实测 |
| 21 | 发送新的阅读邀请 | open-type=share | 待实测 |
| 22 | 重新核对并刷新 | bindtap=refresh | 待实测 |

## packages/story-sharing/pages/receive/index

| 行 | 操作/文案 | 绑定与分支 | 结果 |
| ---: | --- | --- | --- |
| 10 | {{item.title &#124;&#124; '未命名章节'}} | bindchange=chooseChapters | 待实测 |
| 14 | 新建一本自己的故事 加入已有故事 | bindchange=chooseMode | 待实测 |
| 19 | {{selectedTargetTitle &#124;&#124; '选择已有故事'}} › | bindchange=chooseTarget | 待实测 |
| 21 | 确认放进我的故事 | bindtap=receive | 待实测 |

## packages/story-sharing/pages/card/index

| 行 | 操作/文案 | 绑定与分支 | 结果 |
| ---: | --- | --- | --- |
| 6 | {{item.title &#124;&#124; '未命名章节'}} | bindchange=chooseChapter | 待实测 |
| 9 | {{block.preview}} 照片 没有公开发布许可 | bindchange=chooseBlocks | 待实测 |
| 15 | {{busy ? '正在生成…' : '预览故事卡'}} | bindtap=preview | 待实测 |
| 18 | 重新核对并保存到相册 | bindtap=save | 待实测 |

## packages/story-sharing/pages/social/index

| 行 | 操作/文案 | 绑定与分支 | 结果 |
| ---: | --- | --- | --- |
| 14 | 整本书 | bindtap=chooseScope; data-scope=book | 待实测 |
| 15 | 选择章节 | bindtap=chooseScope; data-scope=chapters | 待实测 |
| 16 | 选择文字 | bindtap=chooseScope; data-scope=text | 待实测 |
| 19 | {{item.title}} {{item.characterCount}} 字 | bindchange=chooseChapters | 待实测 |
| 23 | {{chapters[textChapterIndex].title &#124;&#124; '暂无章节'}} ⌄ | bindchange=chooseTextChapter | 待实测 |
| 26 | 使用选中文字 | catchtouchstart=captureSelection | 待实测 |
| 30 | {{checking ? '正在核对书稿' : '预览所选内容'}} | bindtap=previewSelection | 待实测 |
| 33 | 重新选择 | bindtap=backToSelection | 待实测 |
| 37 | 先制作 AI 封面 | bindtap=makeCover | 待实测 |
| 40 | 分页图片 | bindtap=chooseLayout; data-layout=pages | 待实测 |
| 40 | 一张长图 | bindtap=chooseLayout; data-layout=long | 待实测 |
| 41 | 字号：{{fontSize === 28 ? '紧凑' : fontSize === 32 ? '标准' : '大字'}} ⌄ | bindchange=chooseFont | 待实测 |
| 44 | {{exportBusy ? renderProgress : imagePaths.length ? '重新生成图片' : '生成图片预览'}} | bindtap=generateImages | 待实测 |
| 51 | 发这张图片 | bindtap=shareImage; data-index={{index}} | 待实测 |
| 53 | {{savedIndices.length === imagePaths.length ? '已全部保存' : savedIndices.length ? '继续保存剩余图片' : '保存全部图… | bindtap=saveImages | 待实测 |
| 58 | 重新选择内容 | bindtap=backToSelection | 待实测 |
| 62 | 重新加载 | bindtap=refresh | 待实测 |
| 63 | 回到书稿 | bindtap=goBack | 待实测 |

## packages/audio/pages/create/create

| 行 | 操作/文案 | 绑定与分支 | 结果 |
| ---: | --- | --- | --- |
| 8 | 重新确认 | bindtap=refreshCapabilities | 待实测 |
| 13 | {{item.label}} | bindtap=chooseOfficial; data-id={{item.id}}; data-label={{item.label}} | 待实测 |
| 13 | {{selectedVoice ? '更换声音' : '选择我的声音'}} | bindtap=openVoices | 待实测 |
| 18 | {{creating ? '正在提交…' : canCreate ? '开始制作' : '真实制作暂未开放'}} | bindtap=startCreate | 待实测 |

## packages/audio/pages/voices/voices

| 行 | 操作/文案 | 绑定与分支 | 结果 |
| ---: | --- | --- | --- |
| 1 | 声音类型（腾讯云创建音色必填） 男声 女声 | bindchange=chooseGender | 待实测 |
| 1 | 使用这个声音朗读 | bindtap=useVoice | 待实测 |
| 1 | 结束录音 | bindtap=stopRecording | 待实测 |
| 1 | {{uploading ? '正在上传…' : available ? '阅读授权文字并录音' : '暂未开放录音'}} | bindtap=beginRecording | 待实测 |
| 1 | 停用这个声音 | bindtap=disableVoice | 待实测 |
| 1 | 删除声音与样本 | bindtap=deleteVoice | 待实测 |

## packages/audio/pages/player/player

| 行 | 操作/文案 | 绑定与分支 | 结果 |
| ---: | --- | --- | --- |
| 5 | {{item.text}} | bindtap=seekLine; data-index={{item.cueIndex}} | 待实测 |
| 11 | A− | bindtap=changeTextSize; data-delta=-0.08 | 待实测 |
| 11 | {{waiting ? '缓冲中' : playing ? '暂停' : '播放'}} | bindtap=togglePlayback | 待实测 |
| 11 | A+ | bindtap=changeTextSize; data-delta=0.08 | 待实测 |
| 11 | {{savingVideo ? '保存中…' : '保存视频到相册'}} | bindtap=saveVideo | 待实测 |

## components/story-switcher/story-switcher

| 行 | 操作/文案 | 绑定与分支 | 结果 |
| ---: | --- | --- | --- |
| 9 | 切换到人生之书，我的故事 | bindtap=openPersonal | 待实测 |
| 29 | 记下此刻，记录一段故事 | bindtap=startInterview | 待实测 |
| 49 | 切换到记忆之家，我和亲友的故事 | bindtap=openFamily | 待实测 |
| 70 | 关闭记录方式选择 | bindtap=closeChooser | 待实测 |
| 77 | 选择记录方式，点空白处关闭 | bindtap=closeChooser | 待实测 |
| 91 | 接着聊{{item.title}} | catchtap=continueMemory; data-id={{item.id}}; data-title={{item.storyTitle}} | 待实测 |
| 120 | 从全部回忆里挑一段 | catchtap=openAllMemories | 待实测 |
| 133 | 随手记 回忆录 | catchtap=keepChooserOpen | 待实测 |
| 134 | 随手记，直接开一段新的 | bindtap=startQuickNote | 待实测 |
| 151 | 回忆录，挑一段接着聊 | bindtap=openMemoir | 待实测 |
