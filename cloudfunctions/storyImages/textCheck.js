const MAX_LENGTH = 2500;
const VALID_SCENES = new Set([1, 2, 3, 4]);

function cleanInput({ text, scene }) {
  return {
    content: Array.from(String(text || "").trim()).slice(0, MAX_LENGTH).join(""),
    scene: VALID_SCENES.has(Number(scene)) ? Number(scene) : 3,
  };
}

function interpretResult(result) {
  if (!result || typeof result !== "object") return { ok: false, errorCode: "TEXT_CHECK_UNREADABLE" };
  if (result.error) return { ok: false, errorCode: String(result.error.code || "TEXT_CHECK_FAILED").slice(0, 40) };
  if (result.ok === true) return { ok: true, suggest: result.suggest, label: result.label };
  if (result.suggest === "risky" || result.suggest === "review") {
    return { ok: false, risky: true, errorCode: "TEXT_RISKY", suggest: result.suggest, label: result.label };
  }
  return { ok: false, errorCode: "TEXT_CHECK_FAILED", suggest: result.suggest };
}

/**
 * User-provided art directions and generated captions are checked before any
 * paid image work is queued. Prefer the direct WeChat content-safety API here:
 * cloud-to-cloud calls to the shared checker do not reliably carry the active
 * user's OPENID in DevTools, while storyImages already has it from its caller.
 * The fallback keeps unit tests and older deployments fail-closed.
 */
function createTextChecker({ callFunction, msgSecCheck, scene = 3 }) {
  async function check({ text, openid }) {
    const input = cleanInput({ text, scene });
    if (!input.content) return { ok: true, suggest: "pass" };
    if (msgSecCheck) {
      try {
        const response = await msgSecCheck({ content: input.content, version: 2, scene: input.scene, openid });
        const result = response && response.result;
        return interpretResult({
          ok: result && result.suggest === "pass",
          suggest: (result && result.suggest) || "review",
          label: result && result.label,
        });
      } catch (error) {
        return { ok: false, errorCode: String((error && (error.errCode || error.errMsg || error.message)) || "TEXT_CHECK_FAILED").slice(0, 40) };
      }
    }
    if (!callFunction) return { ok: false, errorCode: "TEXT_CHECK_NOT_CONFIGURED" };
    try {
      const response = await callFunction({ name: "contentSecurityCheck", data: { content: input.content, scene: input.scene, openid } });
      return interpretResult(response && response.result);
    } catch (error) {
      return { ok: false, errorCode: String((error && (error.errCode || error.errMsg || error.message)) || "TEXT_CHECK_FAILED").slice(0, 40) };
    }
  }
  return { check };
}

module.exports = { createTextChecker };
