# Story transport diagnostic

This is a temporary measurement fixture, not a production mini-program page.
It alternates six sequential `storyBooks.capabilities` / `storyBooks.state` calls.
It never issues content writes or AI calls and never exports response bodies.
The existing app lifecycle and cloud function identity logic still run normally.

## Install only into an isolated preview

1. Copy `page/index.{js,json,wxml,wxss}` and `story-transport-probe.js` into the preview's `miniprogram/pages/performance-diagnostic/`.
2. Add `pages/performance-diagnostic/index` to that preview's `miniprogram/app.json` pages list. Do not add it to the production app.
3. Recompile, open that route, and tap **开始测量**. Verify all six results and no runtime errors before sending a phone preview.
4. Keep the same AppID, cloud environment, account and client build for the comparison. Record any differences. Do not use remote debugging for the primary phone sample; it changes execution conditions.
5. Run once on the phone's Wi-Fi (preferably the same network as the computer), then once on mobile data. Keep the app foreground and avoid editing content or switching networks during a run. Copy results with the page button.
6. Match each request ID against platform Report duration. Confirm response byte counts and item counts match; otherwise the account/dataset comparison is not controlled.

The current staged preview is `/private/tmp/shiguang-performance-preview-pimj_o2v`.
Its original app manifest was copied to `/tmp/shiguang-performance-app-before-diagnostic.json`.
Phone comparison is still pending; `platform: devtools` is never a phone result even when `system` says iOS.

## Interpreting results

- `durationMs` stops immediately after `wx.cloud.callFunction` resolves. It excludes our later JSON sizing and page updates. It is not pure network time.
- `utf8Bytes` is the UTF-8 size of serialized JSON, not compressed bytes transferred over the network.
- `stringifyMs` / `parseMs` are a local serialization experiment, not measurements of the SDK's internal response decode.
- `analysisMs` shows diagnostic overhead after each response. Do not add it to call duration.
- `matchingCurrentCount` only counts revisions referenced by current story pointers; unreferenced revisions can still serve legacy drafts/history. Do not delete them based on this diagnostic.
- Only fixed field names, sizes, counts, booleans, UUID request IDs and environment information leave the probe. Raw SDK errors are omitted because they may contain sensitive data.
- SDK failure or invalid response stops the run. Leaving the page prevents subsequent calls; an already issued read can finish.
- A smaller response being faster does not isolate transfer time: the actions have different server work. A tiny response still taking seconds, with a millisecond server Report, demonstrates substantial time outside function execution.

Validation: `node --test tests/story-transport-probe.test.js`.
