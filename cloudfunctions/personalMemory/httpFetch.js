const http = require("node:http");
const https = require("node:https");

function nodeFetch(url, { method = "GET", headers = {}, body, signal } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const transport = target.protocol === "http:" ? http : https;
    const request = transport.request(target, { method, headers }, response => {
      const chunks = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("error", reject);
      response.on("end", () => {
        const buffer = Buffer.concat(chunks);
        const status = response.statusCode || 0;
        resolve({
          ok: status >= 200 && status < 300,
          status,
          headers: {
            get(name) {
              const value = response.headers[String(name).toLowerCase()];
              if (Array.isArray(value)) return value.join(", ");
              return value === undefined ? null : value;
            },
          },
          json: async () => JSON.parse(buffer.toString("utf8")),
          text: async () => buffer.toString("utf8"),
        });
      });
    });
    const abort = () => {
      const error = new Error("The operation was aborted");
      error.name = "AbortError";
      request.destroy(error);
    };
    request.on("error", reject);
    if (signal) {
      if (signal.aborted) {
        abort();
        return;
      }
      signal.addEventListener("abort", abort, { once: true });
    }
    if (body !== undefined) request.write(body);
    request.end();
  });
}

function defaultFetch(...args) {
  if (typeof globalThis.fetch === "function") return globalThis.fetch(...args);
  return nodeFetch(...args);
}

module.exports = { defaultFetch, nodeFetch };
