import { strict as assert } from "node:assert";
import { test } from "node:test";
import { deliveryResolutionAfterImport } from "../miniprogram/services/chapterDelivery";

test("an explicitly imported return resolves as adopted; ordinary deliveries follow the chosen target", () => {
  assert.equal(deliveryResolutionAfterImport("return", "new"), "adopted");
  assert.equal(deliveryResolutionAfterImport("return", "append"), "adopted");
  assert.equal(deliveryResolutionAfterImport("send", "new"), "kept");
  assert.equal(deliveryResolutionAfterImport("send", "append"), "appended");
});
