---
title: WeChat media features require cross-layer verification
date: "2026-09-19"
category: integration-issues
module: story media
problem_type: integration_issue
component: development_workflow
symptoms:
  - "An independent story image page reports 档案信息不完整 even though the story exists"
  - "The custom voice page stays disabled with 自己的声音功能正在核验"
  - "Local tests pass while the device still runs stale or gated cloud behavior"
root_cause: missing_workflow_step
resolution_type: workflow_improvement
severity: high
related_components:
  - "WeChat mini-program"
  - "CloudBase cloud functions"
  - "Tencent Cloud TTS and VRS"
tags:
  - "wechat-miniprogram"
  - "cloudbase"
  - "story-images"
  - "story-audio"
  - "tencent-tts"
  - "voice-cloning"
  - "deployment"
  - "end-to-end-testing"
---

# WeChat media features require cross-layer verification

## Problem

The story-image and custom-voice pages looked like frontend failures, but they crossed four independently versioned layers: the mini-program bundle, a CloudBase function, that function's runtime configuration, and a Tencent Cloud product entitlement or quota. Checking only the page or only local tests made the investigation much longer than necessary.

Two concrete failures exposed the pattern:

- Independent stories opened the image page with a `storyId`, while an older deployed `storyImages` function still validated an empty `memberId` and returned “档案信息不完整”.
- The custom-voice page correctly disabled recording because the deployed capability response said enrollment was unavailable. The state machine and Tencent adapter existed locally, but the durable voice processor was not connected to the deployed cloud runtime, and the Tencent account had no one-sentence voice-cloning resource.

## Symptoms

- A valid book loads elsewhere, but its media-management page reports a legacy identity error.
- A control is disabled by a capability response, so tapping or changing page markup cannot make the backend path available.
- Unit tests and type checks pass, yet the device continues showing the old error.
- The cloud provider console is logged into a different account from the CloudBase environment, producing contradictory configuration evidence.
- A feature appears ready in code but still needs an external service entitlement, free pack, permission, or explicit billing decision.

## What Didn't Work

- **Treating screenshots as the primary diagnostic.** Screenshots proved the symptom but did not identify which layer produced it. Searching the exact error string and observing the cloud request contract was faster.
- **Assuming local code was deployed.** The local image service already sent `{ storyId }`, but the device still called an older cloud implementation. A local passing test did not prove cloud parity.
- **Incremental cloud deployment after cross-file changes.** Shared runtime changes can leave a cloud function with a mixture of old and new files. Full function deployment is safer for contract or dependency changes.
- **Unlocking the voice button in the frontend.** The disabled state was a deliberate fail-closed capability gate. Removing it would have allowed private recordings to upload into an incomplete or unentitled pipeline.
- **Equating a configured Tencent credential with product readiness.** Credentials can call TTS while VRS still has zero voice resources, zero synthesis characters, missing permissions, or an unaccepted billing policy.
- **Repeated manual clicking before instrumenting boundaries.** It risks duplicate paid image or speech requests and produces little new evidence. Idempotent request IDs and one controlled real request are safer.

## Solution

### 1. Model the four readiness planes explicitly

For every cloud media feature, verify these planes separately:

| Plane | Evidence to collect | Typical failure |
| --- | --- | --- |
| Mini-program | Page data and actual `wx.cloud.callFunction` payload | Old bundle or wrong identity field |
| Cloud function code | Deployed version and action contract | Local fix not deployed or mixed incremental deployment |
| Cloud runtime config | Boolean capability result, timeout, variable presence | Gate disabled, short timeout, missing worker |
| Provider account | Product entitlement, quota, IAM permission, billing mode | API credential exists but the product cannot accept work |

Do not collapse these into a single “configured” flag. A useful public capability response should expose safe booleans and reasons, never credentials.

### 2. Trace the exact error backward through the contract

The image error text came from server validation:

```js
function normalizeMemberInput(event) {
  const memberId = String(event?.memberId || "").trim();
  if (!ID_PATTERN.test(memberId)) {
    throw new StoryImageError("INVALID_MEMBER", "档案信息不完整");
  }
  return memberId;
}
```

An independent book must never reach that validator. The client and server now use an explicit scope:

```ts
const scope = bookId.startsWith("story-")
  ? { storyId: bookId }
  : { memberId: bookId };

await callStoryImages("list", scope);
```

```js
const storyId = String(event?.storyId || "").trim();
const memberId = storyId ? "" : normalizeMemberInput(event);

const images = storyId
  ? await repo.listStoryImages(familyId, normalizeStoryInput(event))
  : await repo.listImages(familyId, memberId);
```

Apply the same scope to submit, status, list, and delete. Fixing only the initial list call leaves later actions broken.

### 3. Put the voice worker inside a deployable runtime

The custom-voice state machine was implemented in a standalone worker directory that CloudBase did not package. The fix moved the reusable processor, WAV inspection, and voice repository into `cloudfunctions/storyAudio/`, then made the standalone worker re-export those modules.

The deployed runtime now wires:

1. Tencent training-text retrieval.
2. Private sample download and WAV inspection.
3. Provider quality detection.
4. Idempotent voice-task creation.
5. Training-status polling.
6. Ready voice publication and deletion states.

The page remains gated until all of these are true:

```text
credential ready
+ voice clone enabled
+ enrollment enabled
+ durable worker enabled
+ pricing version present
+ Tencent VRS resource and permission available
```

This is intentional. Code readiness and commercial readiness are different facts.

### 4. Use a verification ladder that stops cheap failures early

Run verification in this order:

1. **Pure contract tests** for identity scope, state transitions, idempotency, and fail-closed behavior.
2. **Full type and test suite** before deploying.
3. **Full cloud-function deployment** when runtime files, dependencies, or action contracts changed.
4. **Developer-tools automation** to open the exact real story and inspect page data.
5. **One real provider request** with a unique request ID, then poll the same job. Never submit blind retries.
6. **Device preview QR** generated from the exact merged commit.

For the image fix, the decisive end-to-end evidence was:

- Story `story-t-id5kpg1kqu352` loaded as book “壮”.
- Chapter `chapter-mu5cc26o-w9m1y96h` appeared without `INVALID_MEMBER`.
- One illustration job completed and stored a 177 KB private image.

For standard narration, readiness required playback progress, pause, sentence seeking, synchronized highlighting, and auto-scroll, not merely a `ready` database status.

### 5. Separate technical completion from actions that need user authority

Provider consoles can offer a free resource pack while automatically switching to postpaid after exhaustion. Do not treat “free now” as authorization for future billing.

Complete and deploy the fail-closed code first. Stop immediately before:

- accepting a new service agreement;
- enabling postpaid billing;
- purchasing a resource pack;
- widening IAM permissions;
- uploading a real biometric voice sample without consent.

Record the remaining external action precisely so the product does not falsely appear finished.

## Why This Works

The workflow replaces a vague “the feature is broken” diagnosis with observed boundaries. Each check answers one different question:

- Did the page send the right identity?
- Is that code actually deployed?
- Did the cloud runtime construct the processor?
- Is the capability intentionally gated?
- Can the selected Tencent account legally and financially accept the request?
- Did one real job reach a user-visible result without duplicate billing?

This prevents a common false-positive chain: local test passes, frontend button is enabled, a private sample uploads, and only then the provider rejects the task or starts charging unexpectedly.

## Prevention

### Contract and deployment guardrails

- Test both legacy `{ memberId }` and independent `{ storyId }` paths for every media action.
- Include a cloud-runtime startup test proving each advertised capability has a constructed processor.
- Keep capability defaults off when credentials, worker wiring, or pricing are not verified.
- Prefer a full cloud-function deployment after adding files or changing dependencies.
- Verify deployed timeouts for provider calls; repository `config.json` alone may not change runtime timeout settings.
- Never print the complete cloud environment configuration because it may contain credentials.

### Paid-operation guardrails

- Create the intent record before calling a paid provider.
- Use one stable request or session ID per user action.
- Distinguish definite rejection from unknown submission results.
- Never automatically retry an ambiguous create response.
- Poll or resume the existing task instead of creating another.
- Run only one controlled real-media test until its terminal state is known.

### Fast triage checklist

```text
1. Search the exact user-visible error string.
2. Identify whether it is client text, cloud response, or provider response.
3. Capture the actual request identity and capability result.
4. Compare local HEAD with the deployed cloud function.
5. Check runtime gates without exposing environment values.
6. Check the provider account, entitlement, quota, permission, and billing separately.
7. Deploy fully, then automate the exact real route.
8. Submit at most one real paid-capable job and follow it to completion.
9. Generate the preview QR only from the final merged commit.
```

## Related Issues

- [Audio story rollout](../../audio-story-rollout.md)
- [Audio platform feasibility](../../research/2026-09-18-audio-story-platform-feasibility.md)
- [Independent story books rollout](../../independent-story-books-rollout.md)
- [Audio story implementation plan](../../plans/2026-09-18-001-feat-audio-story-pages-plan.md)
