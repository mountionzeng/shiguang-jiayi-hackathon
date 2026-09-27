import assert from "node:assert/strict";
import test from "node:test";

import {
  INVITE_CARD_STYLES,
  invitationCopyOptions,
  nextInvitationCopy,
  validInvitationMessage,
  wrapInvitationMessage,
} from "../miniprogram/services/inviteCard";

test("邀请卡提供三种拾光插图风格", () => {
  assert.deepEqual(INVITE_CARD_STYLES.map(style => style.id), ["branch", "book", "nest"]);
  assert.ok(INVITE_CARD_STYLES.every(style => style.art.startsWith("/assets/illustrations/")));
});

test("邀请语会结合称呼和关系生成并可连续换一段", () => {
  const options = invitationCopyOptions(" 妈 ", "母女");
  assert.equal(options.length, 4);
  assert.match(options[0], /妈/);
  assert.match(options[3], /母女/);
  assert.notEqual(nextInvitationCopy("妈", "母女", 0).message, nextInvitationCopy("妈", "母女", 1).message);
});

test("邀请语限制长度并稳定排成最多四行", () => {
  assert.equal(validInvitationMessage("一起写故事"), true);
  assert.equal(validInvitationMessage("短"), false);
  assert.equal(validInvitationMessage("忆".repeat(91)), false);
  const lines = wrapInvitationMessage("有些记忆因为你也在场，才显得完整。想邀请你来这里，一起把故事慢慢写下来。", 12, 4);
  assert.ok(lines.length <= 4);
  assert.ok(lines.every(line => line.length > 0));
});
