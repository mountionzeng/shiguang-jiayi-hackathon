const crypto = require("node:crypto");

const MIN_TOKEN_LENGTH = 24;
const CONFIRM_TEXT = "DELETE_DEMO_FAMILY";

function fail(code) {
  throw new Error(code);
}

function digest(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest();
}

/** Authorize the one-off destructive operation without ever returning secret material. */
function authorizeDangerousDelete(event = {}, configuredToken) {
  if (event.confirm !== CONFIRM_TEXT) fail("DELETE_CONFIRMATION_REQUIRED");
  const operatorToken = event.operatorToken;
  if (typeof configuredToken !== "string" || configuredToken.length < MIN_TOKEN_LENGTH) {
    fail("DELETE_AUTH_NOT_CONFIGURED");
  }
  if (typeof operatorToken !== "string" || operatorToken.length < MIN_TOKEN_LENGTH) {
    fail("DELETE_AUTH_INVALID");
  }
  if (!crypto.timingSafeEqual(digest(operatorToken), digest(configuredToken))) {
    fail("DELETE_AUTH_INVALID");
  }
}

module.exports = { authorizeDangerousDelete, CONFIRM_TEXT, MIN_TOKEN_LENGTH };
