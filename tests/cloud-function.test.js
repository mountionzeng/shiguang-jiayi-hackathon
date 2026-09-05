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
const {
  CORE_COLLECTIONS,
  collectionAlreadyExists,
  ensureCollections,
  isAuthorizedBootstrap,
} = require("../cloudfunctions/ensureCloudCollections/bootstrap.js");

test("cloud collection bootstrap creates the text MVP collections in order", async () => {
  const created = [];
  const results = await ensureCollections({
    createCollection: async (name) => created.push(name),
  });

  assert.deepEqual(created, CORE_COLLECTIONS);
  assert.deepEqual(
    results,
    CORE_COLLECTIONS.map((name) => ({ name, status: "created" })),
  );
});

test("cloud collection bootstrap is idempotent and rejects unexpected failures", async () => {
  const existingDb = {
    createCollection: async () => {
      throw new Error("DATABASE_COLLECTION_EXIST: Collection already exists");
    },
  };

  assert.equal(collectionAlreadyExists(new Error("Table already exist")), true);
  assert.equal(
    collectionAlreadyExists(
      new Error("[ResourceUnavailable.ResourceExist] Table exist: DATABASE_COLLECTION_ALREADY_EXIST"),
    ),
    true,
  );
  assert.deepEqual(
    await ensureCollections(existingDb),
    CORE_COLLECTIONS.map((name) => ({ name, status: "existing" })),
  );

  await assert.rejects(
    () => ensureCollections({ createCollection: async () => { throw new Error("permission denied"); } }),
    /permission denied/,
  );
});

test("cloud collection bootstrap requires a deployment-only token", () => {
  const token = "deployment-only-token-123456789";
  assert.equal(isAuthorizedBootstrap({ bootstrapToken: token }, token), true);
  assert.equal(isAuthorizedBootstrap({ bootstrapToken: "wrong-token" }, token), false);
  assert.equal(isAuthorizedBootstrap({ bootstrapToken: token }, "short"), false);
  assert.equal(isAuthorizedBootstrap({}, token), false);
});

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
  const requests = [];

  process.env.CHAT_AI_API_KEY = "test-chat-key";
  process.env.CHAT_AI_MODEL = "smart-chat-model";
  process.env.CHAT_AI_BASE_URL = "https://chat-model.invalid/v1";
  global.fetch = async (_url, options) => {
    const requestBody = JSON.parse(options.body);
    requests.push(requestBody);
    const content = JSON.stringify({
      dimension: "feeling",
      text: "老屋门口等车这幕还挺清楚。现在想起那天，你最深的感觉是什么？",
    });

    return {
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content,
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
    assert.equal(
      result.text,
      "老屋门口等车这幕还挺清楚。现在想起那天，你最深的感觉是什么？",
    );
    assert.equal(requests.length, 1);
    assert.equal(requests[0].model, "smart-chat-model");
    assert.equal(requests[0].temperature, 0.65);
    assert.equal(requests[0].max_tokens, 160);
    assert.match(requests[0].messages[0].content, /记忆采访者/);
    assert.match(requests[0].messages[1].content, /老屋门口/);
    assert.match(requests[0].messages[1].content, /已追问方向：人物、时间/);
    assert.match(requests[0].messages[1].content, /内容类型：回忆录/);
    assert.doesNotMatch(JSON.stringify(requests), /test-chat-key/);
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

test("the interview cloud function keeps long answers on the model path", async () => {
  const previousFetch = global.fetch;
  const previousKey = process.env.CHAT_AI_API_KEY;
  const previousModel = process.env.CHAT_AI_MODEL;
  const requests = [];
  const longAnswer = Array.from(
    { length: 45 },
    (_, index) => `第${index + 1}句，我说起小时候跟家人在老屋里过年的细节。`,
  ).join("");

  process.env.CHAT_AI_API_KEY = "test-chat-key";
  process.env.CHAT_AI_MODEL = "smart-chat-model";
  global.fetch = async (_url, options) => {
    const requestBody = JSON.parse(options.body);
    requests.push(requestBody);
    return {
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                dimension: "feeling",
                text: "老屋过年的细节已经很满了。那一刻你最舍不得的是什么？",
              }),
            },
          },
        ],
      }),
    };
  };

  try {
    const result = await chatInterviewMain({
      answer: longAnswer,
      askedDimensions: ["place", "person"],
      memberName: "讲述者",
      previousAnswers: [longAnswer],
    });

    assert.equal(result.generationMode, "cloud-ai");
    assert.equal(result.dimension, "feeling");
    assert.equal(requests.length, 1);
    assert.match(requests[0].messages[1].content, /不要再按题库补地点\/人物/);
    assert.ok(requests[0].messages[1].content.length > 1200);
  } finally {
    global.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.CHAT_AI_API_KEY;
    else process.env.CHAT_AI_API_KEY = previousKey;
    if (previousModel === undefined) delete process.env.CHAT_AI_MODEL;
    else process.env.CHAT_AI_MODEL = previousModel;
  }
});

test("the interview cloud function retries one empty provider response", async () => {
  const previousFetch = global.fetch;
  const previousKey = process.env.CHAT_AI_API_KEY;
  const previousModel = process.env.CHAT_AI_MODEL;
  let calls = 0;
  process.env.CHAT_AI_API_KEY = "test-chat-key";
  process.env.CHAT_AI_MODEL = "smart-chat-model";
  global.fetch = async () => {
    calls += 1;
    const content = calls === 1
      ? ""
      : JSON.stringify({ dimension: "place", text: "那时大家是在院子的什么位置乘凉？" });
    return { ok: true, json: async () => ({ choices: [{ message: { content } }] }) };
  };

  try {
    const result = await chatInterviewMain({
      answer: "小时候夏天会和家人乘凉。",
      memoryType: "note",
    });
    assert.equal(calls, 2);
    assert.equal(result.dimension, "place");
    assert.match(result.text, /院子/);
  } finally {
    global.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.CHAT_AI_API_KEY;
    else process.env.CHAT_AI_API_KEY = previousKey;
    if (previousModel === undefined) delete process.env.CHAT_AI_MODEL;
    else process.env.CHAT_AI_MODEL = previousModel;
  }
});

test("the interview cloud function rejects two empty provider responses", async () => {
  const previousFetch = global.fetch;
  const previousKey = process.env.CHAT_AI_API_KEY;
  const previousModel = process.env.CHAT_AI_MODEL;
  let calls = 0;
  process.env.CHAT_AI_API_KEY = "test-chat-key";
  process.env.CHAT_AI_MODEL = "smart-chat-model";
  global.fetch = async () => {
    calls += 1;
    return { ok: true, json: async () => ({ choices: [{ message: { content: "" } }] }) };
  };

  try {
    await assert.rejects(
      () => chatInterviewMain({ answer: "小时候夏天会和家人乘凉。", memoryType: "note" }),
      /EMPTY_MODEL_OUTPUT/,
    );
    assert.equal(calls, 2);
  } finally {
    global.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.CHAT_AI_API_KEY;
    else process.env.CHAT_AI_API_KEY = previousKey;
    if (previousModel === undefined) delete process.env.CHAT_AI_MODEL;
    else process.env.CHAT_AI_MODEL = previousModel;
  }
});

test("the interview cloud function covers every direction before repeating", () => {
  const asked = [];
  for (const expected of ["person", "time", "place", "event", "feeling"]) {
    const next = chatInterviewTest.localFallbackDimension(asked);
    assert.equal(next, expected);
    asked.push(next);
  }
  assert.notEqual(chatInterviewTest.localFallbackDimension(asked), asked.at(-1));
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

test("the interview strategy reacts to emotion and off-track replies", () => {
  const highEmotion = chatInterviewTest.decideStrategy({
    inputType: "情感信号",
    emotionIntensity: "高",
    missingInfo: ["地点", "时间"],
    keyDetail: "很想外公",
  }, []);
  assert.equal(highEmotion.dimension, "feeling");
  assert.match(highEmotion.instruction, /回应情绪/);

  const offTrack = chatInterviewTest.decideStrategy({
    inputType: "反问跑题",
    emotionIntensity: "中",
    missingInfo: ["时间", "地点"],
    keyDetail: "用户把 AI 当成记忆里的人",
  }, []);
  assert.equal(offTrack.dimension, "person");
  assert.match(offTrack.instruction, /接住用户的话/);
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
    assert.equal(requestBody.temperature, undefined);
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

test("the organize cloud function falls back when the provider times out", async () => {
  const previousFetch = global.fetch;
  const previousKey = process.env.ORGANIZE_AI_API_KEY;
  const previousModel = process.env.ORGANIZE_AI_MODEL;
  process.env.ORGANIZE_AI_API_KEY = "test-organize-key";
  process.env.ORGANIZE_AI_MODEL = "memory-card-model";
  global.fetch = async () => {
    const error = new Error("request timed out");
    error.name = "AbortError";
    throw error;
  };

  try {
    const result = await organizeMemoryMain({
      transcript: ["小时候每到夏天，我都会和家人在院子里乘凉。"],
      memoryType: "note",
    });
    assert.equal(result.generationMode, "local-demo");
    assert.match(result.body, /院子里乘凉/);
  } finally {
    global.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.ORGANIZE_AI_API_KEY;
    else process.env.ORGANIZE_AI_API_KEY = previousKey;
    if (previousModel === undefined) delete process.env.ORGANIZE_AI_MODEL;
    else process.env.ORGANIZE_AI_MODEL = previousModel;
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
