const { subjectFor } = require("./core");
const actions = {
  mailboxPreview: "preview",
  mailboxConfirm: "confirm",
  mailboxList: "list",
  mailboxRead: "read",
  mailboxShare: "share",
  mailboxRevoke: "revoke",
};
const PATH = "/mailbox";
function mailboxBody(event, context) {
  const action = actions[event.action];
  if (!action || !context.OPENID || !context.APPID)
    throw new Error("invalid_input");
  const subject = subjectFor(context.APPID, context.OPENID),
    body = { subject, action };
  if (["preview", "confirm"].includes(action)) {
    if (!/^[A-F0-9]{28}$/.test(event.code || ""))
      throw new Error("invalid_input");
    body.code = event.code;
  }
  if (["read", "share", "revoke"].includes(action)) {
    if (!/^[a-f0-9-]{36}$/.test(event.id || ""))
      throw new Error("invalid_input");
    body.id = event.id;
  }
  if (action === "read" && event.token !== undefined) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(event.token))
      throw new Error("invalid_input");
    body.token = event.token;
  }
  return body;
}
const uuid = (v) => typeof v === "string" && /^[a-f0-9-]{36}$/.test(v);
const httpsUrl = (v) => {
  try {
    const u = new URL(v);
    return u.protocol === "https:" && !u.username && !u.password;
  } catch {
    return false;
  }
};
function shape(action) {
  return (contentType, data) => {
    if (
      !/^application\/json\b/i.test(contentType || "") ||
      !data ||
      typeof data !== "object" ||
      Array.isArray(data) ||
      data.error
    )
      return "bridge_unavailable";
    const doc = data.document;
    const valid = {
      preview: () =>
        uuid(data.id) &&
        typeof data.title === "string" &&
        data.inventory &&
        typeof data.inventory === "object",
      confirm: () => uuid(data.id) && typeof data.repeated === "boolean",
      list: () =>
        Array.isArray(data.stories) &&
        data.stories.length <= 200 &&
        data.stories.every((s) => uuid(s.id) && typeof s.title === "string"),
      read: () =>
        doc &&
        uuid(doc.id) &&
        typeof doc.title === "string" &&
        typeof doc.mine === "boolean" &&
        typeof doc.shared === "boolean" &&
        Array.isArray(doc.chapters) &&
        doc.chapters.every(
          (c) => typeof c.title === "string" && typeof c.text === "string",
        ) &&
        Array.isArray(doc.images) &&
        doc.images.every(httpsUrl) &&
        Array.isArray(doc.media) &&
        doc.media.every(
          (m) =>
            ["video", "audio"].includes(m.kind) &&
            typeof m.label === "string" &&
            httpsUrl(m.url),
        ) &&
        (!doc.mine || /^[a-f0-9]{64}$/.test(data.fingerprint || "")),
      share: () =>
        typeof data.token === "string" &&
        /^[A-Za-z0-9_-]{43}$/.test(data.token),
      revoke: () => data.token === null,
    }[action];
    return valid && valid() ? null : "bridge_unavailable";
  };
}
async function runMailbox(event, context, { post, moderate }) {
  const body = mailboxBody(event, context);
  if (body.action === "share") {
    const result = await post(
      PATH,
      { subject: body.subject, action: "read", id: body.id },
      shape("read"),
    );
    const doc = result.document;
    if (
      !doc?.mine ||
      !Array.isArray(doc.chapters) ||
      !/^[a-f0-9]{64}$/.test(result.fingerprint || "")
    )
      throw new Error("mailbox_unavailable");
    const text = [
      doc.title,
      ...doc.chapters.flatMap((c) => [c.title, c.text]),
    ].join("\n");
    if (
      (await moderate(text, context.OPENID, "分享网页故事", context)) !== true
    )
      throw new Error("CONTENT_REJECTED");
    body.fingerprint = result.fingerprint;
  }
  return post(PATH, body, shape(body.action));
}
module.exports = { actions, mailboxBody, runMailbox, shape };
