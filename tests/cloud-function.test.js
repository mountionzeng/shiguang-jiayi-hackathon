const assert = require("node:assert/strict");
const test = require("node:test");

const { main, _test } = require("../cloudfunctions/generateBiography/index.js");
const {
  main: chatInterviewMain,
  _test: chatInterviewTest,
} = require("../cloudfunctions/chatInterview/index.js");
const {
  main: organizeMemoryMain,
  _test: organizeMemoryTest,
} = require("../cloudfunctions/organizeMemory/index.js");

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

test("the interview cloud function rejects missing credentials or empty answers", async () => {
  const previousKey = process.env.CHAT_AI_API_KEY;
  const previousModel = process.env.CHAT_AI_MODEL;
  const previousSharedKey = process.env.AI_API_KEY;
  const previousSharedModel = process.env.AI_MODEL;
  delete process.env.CHAT_AI_API_KEY;
  delete process.env.CHAT_AI_MODEL;
  delete process.env.AI_API_KEY;
  delete process.env.AI_MODEL;

  try {
    await assert.rejects(
      () => chatInterviewMain({ answer: "一段回忆" }),
      /AI_NOT_CONFIGURED/,
    );
  } finally {
    if (previousKey === undefined) delete process.env.CHAT_AI_API_KEY;
    else process.env.CHAT_AI_API_KEY = previousKey;
    if (previousModel === undefined) delete process.env.CHAT_AI_MODEL;
    else process.env.CHAT_AI_MODEL = previousModel;
    if (previousSharedKey === undefined) delete process.env.AI_API_KEY;
    else process.env.AI_API_KEY = previousSharedKey;
    if (previousSharedModel === undefined) delete process.env.AI_MODEL;
    else process.env.AI_MODEL = previousSharedModel;
  }
});

test("the interview cloud function returns one safe follow-up", async () => {
  const previousFetch = global.fetch;
  const previousKey = process.env.CHAT_AI_API_KEY;
  const previousModel = process.env.CHAT_AI_MODEL;
  const previousBaseUrl = process.env.CHAT_AI_BASE_URL;
  let requestBody;

  process.env.CHAT_AI_API_KEY = "test-chat-key";
  process.env.CHAT_AI_MODEL = "smart-chat-model";
  process.env.CHAT_AI_BASE_URL = "https://chat-model.invalid/v1";
  global.fetch = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return {
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                dimension: "feeling",
                text: "现在想起那天，你最清楚的感觉是什么？",
              }),
            },
          },
        ],
      }),
    };
  };

  try {
    const result = await chatInterviewMain({
      answer: "那年冬天我和外公在老屋门口等车。",
      askedDimensions: ["person", "time"],
      memberName: "林岚",
      storyTitle: "老屋门口",
      previousAnswers: ["那时候天很冷。"],
      memoryType: "memoir",
    });

    assert.equal(result.generationMode, "cloud-ai");
    assert.equal(result.dimension, "feeling");
    assert.equal(result.text, "现在想起那天，你最清楚的感觉是什么？");
    assert.equal(requestBody.model, "smart-chat-model");
    assert.match(requestBody.messages[1].content, /老屋门口/);
    assert.match(requestBody.messages[0].content, /传记访谈助手/);
    assert.match(requestBody.messages[1].content, /内容类型：回忆录/);
    assert.doesNotMatch(JSON.stringify(requestBody), /test-chat-key/);
  } finally {
    global.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.CHAT_AI_API_KEY;
    else process.env.CHAT_AI_API_KEY = previousKey;
    if (previousModel === undefined) delete process.env.CHAT_AI_MODEL;
    else process.env.CHAT_AI_MODEL = previousModel;
    if (previousBaseUrl === undefined) delete process.env.CHAT_AI_BASE_URL;
    else process.env.CHAT_AI_BASE_URL = previousBaseUrl;
  }
});

test("the interview cloud function separates note and memoir prompts", () => {
  const note = chatInterviewTest.interviewBrief("note");
  const memoir = chatInterviewTest.interviewBrief("memoir");

  assert.equal(chatInterviewTest.validateMemoryType("memoir"), "memoir");
  assert.equal(chatInterviewTest.validateMemoryType("unknown"), "note");
  assert.match(note.rule, /1 到 2 轮追问/);
  assert.match(note.rule, /不要引导成长意义/);
  assert.match(memoir.rule, /正式传记/);
  assert.match(memoir.rule, /后来影响/);
});

test("the interview cloud parser accepts plain text fallback", () => {
  const result = chatInterviewTest.parseInterviewPrompt(
    "追问：后来你又想起了哪个细节？",
    "event",
  );

  assert.equal(result.dimension, "event");
  assert.equal(result.text, "后来你又想起了哪个细节？");
});

test("the interview cloud function diagnoses its configured provider without leaking keys", async () => {
  const previousKey = process.env.CHAT_AI_API_KEY;
  const previousModel = process.env.CHAT_AI_MODEL;
  const previousBaseUrl = process.env.CHAT_AI_BASE_URL;
  process.env.CHAT_AI_API_KEY = "secret-chat-key";
  process.env.CHAT_AI_MODEL = "deepseek-chat";
  process.env.CHAT_AI_BASE_URL = "https://api.deepseek.com";

  try {
    const result = await chatInterviewMain({ __diagnose: true });

    assert.equal(result.diagnostic, true);
    assert.equal(result.provider, "deepseek");
    assert.equal(result.baseUrl, "https://api.deepseek.com");
    assert.equal(result.model, "deepseek-chat");
    assert.equal(result.hasApiKey, true);
    assert.doesNotMatch(JSON.stringify(result), /secret-chat-key/);
  } finally {
    if (previousKey === undefined) delete process.env.CHAT_AI_API_KEY;
    else process.env.CHAT_AI_API_KEY = previousKey;
    if (previousModel === undefined) delete process.env.CHAT_AI_MODEL;
    else process.env.CHAT_AI_MODEL = previousModel;
    if (previousBaseUrl === undefined) delete process.env.CHAT_AI_BASE_URL;
    else process.env.CHAT_AI_BASE_URL = previousBaseUrl;
  }
});

test("the organize cloud function rejects missing credentials or empty transcripts", async () => {
  const previousKey = process.env.ORGANIZE_AI_API_KEY;
  const previousModel = process.env.ORGANIZE_AI_MODEL;
  const previousChatKey = process.env.CHAT_AI_API_KEY;
  const previousChatModel = process.env.CHAT_AI_MODEL;
  const previousSharedKey = process.env.AI_API_KEY;
  const previousSharedModel = process.env.AI_MODEL;
  delete process.env.ORGANIZE_AI_API_KEY;
  delete process.env.ORGANIZE_AI_MODEL;
  delete process.env.CHAT_AI_API_KEY;
  delete process.env.CHAT_AI_MODEL;
  delete process.env.AI_API_KEY;
  delete process.env.AI_MODEL;

  try {
    await assert.rejects(
      () => organizeMemoryMain({ transcript: ["一段回忆"], memoryType: "note" }),
      /AI_NOT_CONFIGURED/,
    );
  } finally {
    if (previousKey === undefined) delete process.env.ORGANIZE_AI_API_KEY;
    else process.env.ORGANIZE_AI_API_KEY = previousKey;
    if (previousModel === undefined) delete process.env.ORGANIZE_AI_MODEL;
    else process.env.ORGANIZE_AI_MODEL = previousModel;
    if (previousChatKey === undefined) delete process.env.CHAT_AI_API_KEY;
    else process.env.CHAT_AI_API_KEY = previousChatKey;
    if (previousChatModel === undefined) delete process.env.CHAT_AI_MODEL;
    else process.env.CHAT_AI_MODEL = previousChatModel;
    if (previousSharedKey === undefined) delete process.env.AI_API_KEY;
    else process.env.AI_API_KEY = previousSharedKey;
    if (previousSharedModel === undefined) delete process.env.AI_MODEL;
    else process.env.AI_MODEL = previousSharedModel;
  }

  assert.throws(() => organizeMemoryTest.buildLocalCard([], "note"), /EMPTY_TRANSCRIPT/);
});

test("the organize cloud function returns a structured memory card", async () => {
  const previousFetch = global.fetch;
  const previousKey = process.env.ORGANIZE_AI_API_KEY;
  const previousModel = process.env.ORGANIZE_AI_MODEL;
  const previousBaseUrl = process.env.ORGANIZE_AI_BASE_URL;
  let requestBody;

  process.env.ORGANIZE_AI_API_KEY = "test-organize-key";
  process.env.ORGANIZE_AI_MODEL = "memory-card-model";
  process.env.ORGANIZE_AI_BASE_URL = "https://organize-model.invalid/v1";
  global.fetch = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return {
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                title: "外公护着我",
                summary: "外公在家里护着我",
                body: "小时候，父母责骂我时，外公会在屋里把我护在身后。",
                emotions: ["安心", "委屈"],
                people: ["外公", "父母"],
                places: ["屋里"],
              }),
            },
          },
        ],
      }),
    };
  };

  try {
    const result = await organizeMemoryMain({
      transcript: ["小时候爸妈骂我时，外公总会把我护在身后。", "是在屋里。"],
      memoryType: "note",
      memberName: "林岚",
    });

    assert.equal(result.generationMode, "cloud-ai");
    assert.equal(result.memoryType, "note");
    assert.equal(result.title, "外公护着我");
    assert.deepEqual(result.emotions, ["安心", "委屈"]);
    assert.match(requestBody.messages[1].content, /外公总会把我护在身后/);
    assert.match(requestBody.messages[0].content, /生活记忆编辑/);
    assert.match(requestBody.messages[1].content, /随手记：整理成近期记忆卡片/);
    assert.doesNotMatch(JSON.stringify(requestBody), /test-organize-key/);
  } finally {
    global.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.ORGANIZE_AI_API_KEY;
    else process.env.ORGANIZE_AI_API_KEY = previousKey;
    if (previousModel === undefined) delete process.env.ORGANIZE_AI_MODEL;
    else process.env.ORGANIZE_AI_MODEL = previousModel;
    if (previousBaseUrl === undefined) delete process.env.ORGANIZE_AI_BASE_URL;
    else process.env.ORGANIZE_AI_BASE_URL = previousBaseUrl;
  }
});

test("the organize cloud function separates note cards and memoir chapters", () => {
  const note = organizeMemoryTest.organizationBrief("note");
  const memoir = organizeMemoryTest.organizationBrief("memoir");

  assert.match(note.rule, /近期记忆卡片/);
  assert.match(note.rule, /不要升华成正式传记/);
  assert.match(memoir.rule, /正式传记章节素材/);
  assert.match(memoir.system, /传记编辑/);
});
