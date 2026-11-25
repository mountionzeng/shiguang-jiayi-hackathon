const test = require("node:test"),
  assert = require("node:assert/strict");
const {
  mailboxBody,
  runMailbox,
} = require("../cloudfunctions/drinkingTimeBridge/mailbox");
const { subjectFor } = require("../cloudfunctions/drinkingTimeBridge/core");
const context = { APPID: "wxExample", OPENID: "owner" },
  id = "12345678-1234-1234-1234-123456789abc";
test("identity always comes from the verified context and no client fingerprint or subject is forwarded", () => {
  const b = mailboxBody(
    {
      action: "mailboxConfirm",
      code: "A".repeat(28),
      subject: "forged",
      userId: 99,
    },
    context,
  );
  assert.deepEqual(b, {
    subject: subjectFor(context.APPID, context.OPENID),
    action: "confirm",
    code: "A".repeat(28),
  });
  assert.throws(() =>
    mailboxBody({ action: "mailboxList" }, { APPID: "wxExample" }),
  );
});
test("sharing reads the owned immutable version and checks its exact text before publishing", async () => {
  const calls = [],
    checks = [];
  const result = await runMailbox(
    { action: "mailboxShare", id, fingerprint: "forged" },
    context,
    {
      post: async (path, body) => {
        calls.push(body);
        return body.action === "read"
          ? {
              document: {
                mine: true,
                title: "Paper boat",
                chapters: [{ title: "Chapter", text: "Chosen prose" }],
              },
              fingerprint: "a".repeat(64),
            }
          : { token: "link" };
      },
      moderate: async (text, openid) => {
        checks.push([text, openid]);
        return true;
      },
    },
  );
  assert.equal(result.token, "link");
  assert.equal(calls[1].fingerprint, "a".repeat(64));
  assert.deepEqual(checks, [["Paper boat\nChapter\nChosen prose", "owner"]]);
});
test("failed moderation and another person’s story never produce a friend link", async () => {
  for (const mine of [true, false]) {
    const calls = [];
    await assert.rejects(
      runMailbox({ action: "mailboxShare", id }, context, {
        post: async (_p, b) => {
          calls.push(b);
          return {
            document: { mine, title: "Title", chapters: [] },
            fingerprint: "a".repeat(64),
          };
        },
        moderate: async () => false,
      }),
    );
    assert.equal(calls.length, 1);
  }
});

test("malformed successful bridge responses do not masquerade as receipt or playable content", () => {
  const { shape } = require("../cloudfunctions/drinkingTimeBridge/mailbox");
  assert.equal(shape("confirm")("application/json", {}), "bridge_unavailable");
  assert.equal(
    shape("confirm")("text/html", { id, repeated: false }),
    "bridge_unavailable",
  );
  assert.equal(
    shape("confirm")("application/json", { id, repeated: false }),
    null,
  );
  const document = {
    id,
    title: "Story",
    mine: false,
    shared: true,
    chapters: [],
    images: [],
    media: [{ kind: "video", label: "Film", url: "javascript:bad" }],
  };
  assert.equal(
    shape("read")("application/json", { document }),
    "bridge_unavailable",
  );
  document.media[0].url = "https://www.drinkingtime.top/video.mp4";
  assert.equal(shape("read")("application/json", { document }), null);
});
