import assert from "node:assert/strict";
import test from "node:test";

import {
  INVITE_CARD_STYLES,
  invitationCopyOptions,
  nextInvitationCopy,
  validInvitationHeadline,
  validInvitationMessage,
  wrapInvitationMessage,
} from "../miniprogram/services/inviteCard";

test("邀请卡提供三种拾光插图风格", () => {
  assert.deepEqual(INVITE_CARD_STYLES.map(style => style.id), ["branch", "book", "nest"]);
  assert.ok(INVITE_CARD_STYLES.every(style => style.art.startsWith("/assets/illustrations/")));
});

test("邀请短笺会结合称呼和关系生成并可连续换一版", () => {
  const options = invitationCopyOptions(" 妈 ", "母女");
  assert.equal(options.length, 4);
  assert.match(options[0].message, /妈/);
  assert.match(options[3].headline, /母女/);
  assert.ok(options.every(option => Array.from(option.headline).length <= 16));
  assert.ok(options.every(option => Array.from(option.message).length <= 48));
  assert.notEqual(nextInvitationCopy("妈", "母女", 0).message, nextInvitationCopy("妈", "母女", 1).message);
});

test("邀请标题和正文都保持简短，正文稳定排成最多三行", () => {
  assert.equal(validInvitationHeadline("一起写故事"), true);
  assert.equal(validInvitationHeadline("忆".repeat(17)), false);
  assert.equal(validInvitationMessage("一起写故事"), true);
  assert.equal(validInvitationMessage("短"), false);
  assert.equal(validInvitationMessage("忆".repeat(49)), false);
  const lines = wrapInvitationMessage("有些记忆因为你也在场，才显得完整。一起写下来吧。", 12, 3);
  assert.ok(lines.length <= 3);
  assert.ok(lines.every(line => line.length > 0));
});
