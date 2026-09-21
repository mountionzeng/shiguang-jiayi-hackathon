const assert = require("node:assert/strict");
const http = require("node:http");
const { after, before, test } = require("node:test");

const clients = [
  require("../cloudfunctions/chatInterview/httpFetch.js"),
  require("../cloudfunctions/generateBiography/httpFetch.js"),
  require("../cloudfunctions/organizeMemory/httpFetch.js"),
];
const chatInterview = require("../cloudfunctions/chatInterview/index.js");
const generateBiography = require("../cloudfunctions/generateBiography/index.js");
const organizeMemory = require("../cloudfunctions/organizeMemory/index.js");

let server;
let baseUrl;

before(async () => {
  server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", chunk => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      if (request.url === "/chat/completions") {
        const payload = JSON.parse(body);
        const system = payload.messages?.[0]?.content || "";
        const content = system.includes('"dimension"')
          ? '{"dimension":"event","text":"那天最清楚的一个细节是什么？"}'
          : system.includes('"emotions"')
            ? '{"title":"一次散步","summary":"记下一次散步","body":"我和家人在傍晚散步。","emotions":[],"people":["家人"],"places":[]}'
            : "散步\n\n我和家人在傍晚散步。";
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ choices: [{ message: { content } }] }));
        return;
      }
      response.writeHead(201, { "content-type": "application/json", "x-runtime": "node16" });
      response.end(JSON.stringify({ method: request.method, body }));
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

test("text AI cloud functions use node:http when Node 16 has no global fetch", async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = undefined;
  try {
    for (const { defaultFetch } of clients) {
      const response = await defaultFetch(`${baseUrl}/echo`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "test-model" }),
      });
      assert.equal(response.ok, true);
      assert.equal(response.status, 201);
      assert.equal(response.headers.get("x-runtime"), "node16");
      assert.deepEqual(await response.json(), { method: "POST", body: '{"model":"test-model"}' });
    }
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("all three text AI entry points work without global fetch", async () => {
  const previousFetch = globalThis.fetch;
  const previousEnv = {
    AI_API_KEY: process.env.AI_API_KEY,
    AI_MODEL: process.env.AI_MODEL,
    AI_BASE_URL: process.env.AI_BASE_URL,
  };
  globalThis.fetch = undefined;
  process.env.AI_API_KEY = "test-key";
  process.env.AI_MODEL = "test-model";
  process.env.AI_BASE_URL = baseUrl;
  try {
    const interview = await chatInterview.main({ answer: "我记得一次散步。" }, { skipGuard: true });
    assert.equal(interview.dimension, "event");

    const biography = await generateBiography.main({
      memories: [{ text: "我和家人在傍晚散步。", authorName: "讲述者", relation: "本人" }],
    }, { skipGuard: true });
    assert.equal(biography.title, "散步");

    const organized = await organizeMemory.main({ transcript: ["我和家人在傍晚散步。"] }, { skipGuard: true });
    assert.equal(organized.title, "一次散步");
  } finally {
    globalThis.fetch = previousFetch;
    for (const [name, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("text AI cloud functions preserve fetch stubs installed after require", async () => {
  const previousFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (...args) => {
    calls.push(args);
    return { ok: true, status: 200 };
  };
  try {
    for (const { defaultFetch } of clients) await defaultFetch("https://example.test/model", { method: "POST" });
    assert.equal(calls.length, clients.length);
  } finally {
    globalThis.fetch = previousFetch;
  }
});
