# 2026-09-25 Book Photo Menu Handoff

## Scope

- `照片` is now a dropdown on the book page.
- Main menu:
  - `图片导入`
  - `图片生成`
- `图片生成` opens:
  - `生成插图`
  - `生成底图`
  - `生成封面`
- Directory actions for import, illustration, and backdrop ask for a chapter first, then continue with that chapter.
- Chapter actions use the current chapter directly.
- Cover generation opens the whole-book cover workflow.
- The directory header no longer shows the small book-shell cover action. It displays the book title, chapter count, content introduction, and the current cover image as the background when available.

## Backend/service wiring

Validated against `origin/main` / `cc24aaa` and the image-generation task’s latest contract; book page owns only UI routing and does not call cloud functions directly.

- `图片导入` reaches the existing `addPhoto` path:
  `wx.chooseMedia -> saveLocalPhoto -> editorContext.insertImage -> editManuscript`.
- `生成插图` routes to:
  `/pages/story-images/story-images?storyId=...&chapterId=...&purpose=illustration`.
- `生成底图` routes to:
  `/pages/story-images/story-images?storyId=...&chapterId=...&purpose=backdrop`.
- `生成封面` routes to:
  `/pages/story-cover/story-cover?storyId=...`.
- The routed story image page already submits through `storyImageApi.submitChapterImage` with the selected purpose.
- The cover page already submits through `storyCoverApi.submit`.
- The book page does not hand-write cloud function calls.

## Verification

- `npm run check` passed: 938 tests.
- Added page tests for:
  - illustration, backdrop, and cover routes from the photo menu;
  - import waiting for the target chapter editor before opening the album;
  - save failure and protected-copy guards;
  - directory header replacing the old `制作封面` book-shell area.
- WeChat DevTools verification used story `story-mufqhldc-o9xfpzbq` / chapter `chapter-mufqih43-fsl6zef1`.
- Verified screenshots:
  - `/private/tmp/shiguang-photo-menu-preview-20260925-contents-display.png`
  - `/private/tmp/shiguang-photo-menu-preview-20260925-photo-menu-main.png`
  - `/private/tmp/shiguang-photo-menu-preview-20260925-photo-menu-generate.png`
  - `/private/tmp/shiguang-photo-menu-preview-20260925-photo-menu-chapters.png`
  - `/private/tmp/shiguang-photo-menu-preview-20260925-story-images-illustration.png`
  - `/private/tmp/shiguang-photo-menu-preview-20260925-story-images-backdrop.png`
  - `/private/tmp/shiguang-photo-menu-preview-20260925-story-cover.png`
  - `/private/tmp/shiguang-photo-menu-preview-20260925-final-clean.png`
- Runtime checks:
  - `生成插图` opened story-images with `purpose=illustration` and the target chapter id.
  - `生成底图` opened story-images with `purpose=backdrop` and the target chapter id.
  - `生成封面` opened story-cover with only the story id.
  - `图片导入` reached the chapter editor and set `pickingPhoto=true`, confirming it entered the existing album import path.
  - After cancelling by reloading the book page, `pickingPhoto=false` and the test chapter still had `photoCount=0`.
  - Simulator console had no `error` matches.

## Limits

- No real paid image generation was submitted in this round, per the image-task constraint.
- The local album picker did not expose a selectable desktop file through the simulator automation, so import was verified to the existing `wx.chooseMedia` waiting state and then cancelled without writing a photo.
