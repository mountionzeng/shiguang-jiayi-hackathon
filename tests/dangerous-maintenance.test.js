const assert = require("node:assert/strict");
const test = require("node:test");

const { authorizeDangerousDelete, CONFIRM_TEXT } = require("../cloudfunctions/deleteDemoFamilyOnce/authorization");

const secret = "delete-demo-family-token-123456";

test("dangerous delete rejects a missing or short configured secret", () => {
  const event={confirm:CONFIRM_TEXT,operatorToken:secret};
  assert.throws(() => authorizeDangerousDelete(event, undefined), /^Error: DELETE_AUTH_NOT_CONFIGURED$/);
  assert.throws(() => authorizeDangerousDelete(event, "too-short"), /^Error: DELETE_AUTH_NOT_CONFIGURED$/);
});

test("dangerous delete rejects missing, short, and mismatched operator tokens without leaking them", () => {
  assert.throws(() => authorizeDangerousDelete({confirm:CONFIRM_TEXT}, secret), /^Error: DELETE_AUTH_INVALID$/);
  assert.throws(() => authorizeDangerousDelete({confirm:CONFIRM_TEXT,operatorToken:"too-short"}, secret), /^Error: DELETE_AUTH_INVALID$/);
  const supplied = "wrong-operator-token-12345678";
  assert.throws(
    () => authorizeDangerousDelete({confirm:CONFIRM_TEXT,operatorToken:supplied}, secret),
    (error) => error instanceof Error && error.message === "DELETE_AUTH_INVALID" && !error.message.includes(supplied) && !error.message.includes(secret),
  );
});

test("dangerous delete accepts an exact operator token", () => {
  assert.throws(()=>authorizeDangerousDelete({confirm:"WRONG",operatorToken:secret},secret),/^Error: DELETE_CONFIRMATION_REQUIRED$/);
  assert.doesNotThrow(() => authorizeDangerousDelete({confirm:CONFIRM_TEXT,operatorToken:secret}, secret));
});
