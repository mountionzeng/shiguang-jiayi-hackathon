// 契约测试：docs/integrations/drinking-time-bridge-contract.md 第 11.1 节的测试向量 V1。
// 这组密钥、AppID、OpenID 是约定里的公开测试值，禁止配置到任何环境。
// 约定升版本且改动签名相关行为时，本文件应随之更新；否则测试失败即提示两端已经不同步。
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const core = require("../cloudfunctions/drinkingTimeBridge/core.js");

const CONTRACT_VERSION = "1.1.0";
const SECRET = "contract-vector-secret-public-do-not-deploy";
const APPID = "wx0000000000000000";
const OPENID = "o-contract-vector-openid";
const PATH = "/desktop/pair/issue";
const TIMESTAMP = "1789999200000";
const NONCE = "AAECAwQFBgcICQoLDA0ODxAR"; // 字节 0x00–0x11 的 base64url

const STORY = {
  title: "外婆的厨房",
  sourceRevision: "0123456789abcdef",
  sourceKey: "story:外婆的厨房",
  updatedAt: "2026-09-14T10:00:00.000Z",
  memories: [
    {
      text: "厨房里总有热气，\"咕嘟\"作响。",
      id: "memory-1",
      createdAt: "2026-09-13T10:00:00.000Z",
      people: ["外婆"],
      places: ["厨房"],
      emotions: ["温暖"],
    },
  ],
  manuscript: {
    title: "外婆的厨房",
    generatedAt: "2026-09-14T10:00:00.000Z",
    chapters: [
      {
        id: "chapter-1",
        title: "灶台边",
        memoryIds: ["memory-1"],
        content: [{ text: "第一章。" }, { photoId: "local-photo-1" }],
      },
    ],
  },
};

const EXPECTED_SUBJECT = "shiguang:8bf5716e65f591b83c18b8e37ce6e4d2ed2985fac96c3d1dac30f85ea04451c1";
const EXPECTED_SIGNATURE_STRING_BYTES = 706;
const EXPECTED_SIGNATURE_STRING_SHA256 = "a78077544889a56c5a664708c008c46b0129ba09101e73e259a9339dc364f9e2";
const EXPECTED_SIGNATURE = "56e7210914295e1cd56e6ec84d1ff7b47f9975fc97735c4e91e5ab8050ebd921";

test(`接口约定 ${CONTRACT_VERSION} 第 11.1 节：测试向量 V1 的 subject 与签名`, () => {
  const body = core.requestBody("issueDesktop", { story: STORY }, { APPID, OPENID });
  assert.equal(body.subject, EXPECTED_SUBJECT);

  const canonical = core.canonicalJson(body);
  const signatureString = `POST\n${PATH}\n${TIMESTAMP}\n${NONCE}\n${canonical}`;
  assert.equal(Buffer.byteLength(signatureString, "utf8"), EXPECTED_SIGNATURE_STRING_BYTES);
  assert.equal(crypto.createHash("sha256").update(signatureString).digest("hex"), EXPECTED_SIGNATURE_STRING_SHA256);

  const signature = core.signature(SECRET, PATH, TIMESTAMP, NONCE, body);
  assert.equal(signature, EXPECTED_SIGNATURE);
});
