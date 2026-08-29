import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const envFile = resolve(process.cwd(), ".env.local");
if (existsSync(envFile)) {
  const lines = readFileSync(envFile, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    const value = rawValue.replace(/^['"]|['"]$/g, "");
    if (!(key in process.env)) process.env[key] = value;
  }
}

const baseUrl = (process.env.KIMI_BASE_URL || process.env.CHAT_AI_BASE_URL || "https://api.moonshot.cn/v1")
  .replace(/\/$/, "");
const model = process.env.KIMI_MODEL || process.env.CHAT_AI_MODEL || "kimi-k2.6";
const apiKey = process.env.KIMI_API_KEY || process.env.MOONSHOT_API_KEY || process.env.CHAT_AI_API_KEY;

if (!apiKey) {
  console.error("Missing API key. Set KIMI_API_KEY, MOONSHOT_API_KEY, or CHAT_AI_API_KEY.");
  process.exit(1);
}

const response = await fetch(`${baseUrl}/chat/completions`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    model,
    temperature: 1,
    messages: [
      {
        role: "system",
        content: "你是一个中文记忆访谈助手。只输出一句自然的追问。",
      },
      {
        role: "user",
        content: "小时候爸妈骂我的时候，外公总会把我护在身后。请追问一个具体问题。",
      },
    ],
  }),
});

const text = await response.text();
let payload;
try {
  payload = JSON.parse(text);
} catch {
  payload = text;
}

console.log("Kimi connection test");
console.log(`baseUrl: ${baseUrl}`);
console.log(`model: ${model}`);
console.log(`status: ${response.status} ${response.statusText}`);
console.log(`requestId: ${response.headers.get("x-request-id") || response.headers.get("x-moonshot-request-id") || "n/a"}`);

if (!response.ok) {
  console.log("error:");
  console.dir(payload, { depth: 6 });
  process.exit(1);
}

const content = payload?.choices?.[0]?.message?.content;
console.log("assistant:");
console.log(content || payload);
