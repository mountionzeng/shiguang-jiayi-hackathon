const http = require("node:http");
const https = require("node:https");

/**
 * Cloud functions created with the Node 16 runtime have no global fetch.
 * This covers what storyImages needs: a method, headers, a string body,
 * abort through a signal, and a response with json / text / arrayBuffer.
 */
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
          arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
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

const defaultFetch = typeof globalThis.fetch === "function" ? globalThis.fetch.bind(globalThis) : nodeFetch;

module.exports = { defaultFetch, nodeFetch };
