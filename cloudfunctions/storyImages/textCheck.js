/**
 * Thin wrapper over the shared contentSecurityCheck cloud function (problem three),
 * so every text check in the mini program goes through one place. Never throws:
 * a check that cannot run comes back as not ok and the caller withholds the draft.
 */
function createTextChecker({ callFunction, scene = 3 }) {
  async function check({ text, openid }) {
    if (!callFunction) return { ok: false, errorCode: "TEXT_CHECK_NOT_CONFIGURED" };
    let response;
    try {
      response = await callFunction({ name: "contentSecurityCheck", data: { content: text, scene, openid } });
    } catch (error) {
      return { ok: false, errorCode: String((error && (error.errCode || error.errMsg || error.message)) || "TEXT_CHECK_FAILED").slice(0, 40) };
    }
    const result = response && response.result;
    if (!result || typeof result !== "object") return { ok: false, errorCode: "TEXT_CHECK_UNREADABLE" };
    if (result.error) return { ok: false, errorCode: String(result.error.code || "TEXT_CHECK_FAILED").slice(0, 40) };
    if (result.ok === true) return { ok: true, suggest: result.suggest, label: result.label };
    // Anything that is not an explicit pass keeps the draft from the user.
    if (result.suggest === "risky" || result.suggest === "review") {
      return { ok: false, risky: true, errorCode: "TEXT_RISKY", suggest: result.suggest, label: result.label };
    }
    return { ok: false, errorCode: "TEXT_CHECK_FAILED", suggest: result.suggest };
  }
  return { check };
}

module.exports = { createTextChecker };
