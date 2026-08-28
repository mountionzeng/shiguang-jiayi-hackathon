const assert = require("node:assert/strict");
const test = require("node:test");

const { main, _test } = require("../cloudfunctions/generateBiography/index.js");

test("the cloud boundary rejects empty and oversized source batches", () => {
  assert.throws(() => _test.validateMemories([]), /NO_CONFIRMED_MEMORIES/);
  assert.throws(
    () =>
      _test.validateMemories(
        Array.from({ length: 21 }, (_, index) => ({
          id: String(index),
          authorName: "家人",
          relation: "亲人",
          text: "一段已确认的回忆",
        })),
      ),
    /TOO_MANY_MEMORY_SOURCES/,
  );
  assert.throws(
    () =>
      _test.validateMemories([
        { id: "blank", authorName: "家人", relation: "亲人", text: "   " },
      ]),
    /INVALID_MEMORY_SOURCE/,
  );
});

test("a single-block model response uses a safe default title without duplicating it", () => {
  const result = _test.parseChapter("只有一段正文，没有单独标题。", 1);

  assert.equal(result.title, "第一章｜被记住的日常");
  assert.deepEqual(result.paragraphs, ["只有一段正文，没有单独标题。"]);
});

test("the cloud function rejects generation when model credentials are absent", async () => {
  const previousKey = process.env.AI_API_KEY;
  const previousModel = process.env.AI_MODEL;
  delete process.env.AI_API_KEY;
  delete process.env.AI_MODEL;

  try {
    await assert.rejects(
      () => main({ memories: [{ authorName: "家人", relation: "亲人", text: "回忆" }] }),
      /AI_NOT_CONFIGURED/,
    );
  } finally {
    if (previousKey === undefined) delete process.env.AI_API_KEY;
    else process.env.AI_API_KEY = previousKey;
    if (previousModel === undefined) delete process.env.AI_MODEL;
    else process.env.AI_MODEL = previousModel;
  }
});

test("the cloud function surfaces non-success model responses", async () => {
  const previousFetch = global.fetch;
  const previousKey = process.env.AI_API_KEY;
  const previousModel = process.env.AI_MODEL;
  process.env.AI_API_KEY = "test-key";
  process.env.AI_MODEL = "test-model";
  global.fetch = async () => ({ ok: false, status: 429 });

  try {
    await assert.rejects(
      () =>
        main({
          memories: [{ authorName: "家人", relation: "亲人", text: "一段回忆" }],
        }),
      /MODEL_REQUEST_FAILED_429/,
    );
  } finally {
    global.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.AI_API_KEY;
    else process.env.AI_API_KEY = previousKey;
    if (previousModel === undefined) delete process.env.AI_MODEL;
    else process.env.AI_MODEL = previousModel;
  }
});

test("the cloud function rejects an empty model chapter", async () => {
  const previousFetch = global.fetch;
  const previousKey = process.env.AI_API_KEY;
  const previousModel = process.env.AI_MODEL;
  process.env.AI_API_KEY = "test-key";
  process.env.AI_MODEL = "test-model";
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: "   " } }] }),
  });

  try {
    await assert.rejects(
      () =>
        main({
          memories: [{ authorName: "家人", relation: "亲人", text: "一段回忆" }],
        }),
      /EMPTY_MODEL_OUTPUT/,
    );
  } finally {
    global.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.AI_API_KEY;
    else process.env.AI_API_KEY = previousKey;
    if (previousModel === undefined) delete process.env.AI_MODEL;
    else process.env.AI_MODEL = previousModel;
  }
});

test("the cloud function returns a traceable chapter from the configured model", async () => {
  const previousFetch = global.fetch;
  const previousKey = process.env.AI_API_KEY;
  const previousModel = process.env.AI_MODEL;
  const previousBaseUrl = process.env.AI_BASE_URL;
  let requestBody;

  process.env.AI_API_KEY = "test-key";
  process.env.AI_MODEL = "test-model";
  process.env.AI_BASE_URL = "https://model.invalid/v1";
  global.fetch = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return {
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: "第一章｜雨天的巷口\n\n外公总会在雨天提前等外孙女放学。",
            },
          },
        ],
      }),
    };
  };

  try {
    const result = await main({
      protagonistName: "林致远",
      memories: [
        {
          id: "source-1",
          authorName: "林岚",
          relation: "外孙女",
          text: "外公每逢下雨都会提前站在巷口等我放学。",
        },
      ],
    });

    assert.equal(result.generationMode, "cloud-ai");
    assert.equal(result.sourceCount, 1);
    assert.equal(result.title, "第一章｜雨天的巷口");
    assert.match(requestBody.messages[1].content, /外公每逢下雨/);
    assert.doesNotMatch(JSON.stringify(requestBody), /test-key/);
  } finally {
    global.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.AI_API_KEY;
    else process.env.AI_API_KEY = previousKey;
    if (previousModel === undefined) delete process.env.AI_MODEL;
    else process.env.AI_MODEL = previousModel;
    if (previousBaseUrl === undefined) delete process.env.AI_BASE_URL;
    else process.env.AI_BASE_URL = previousBaseUrl;
  }
});
