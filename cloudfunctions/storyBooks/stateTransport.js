const { createHash } = require('crypto');
// Even JSON's worst-case escaping (six bytes per code unit) stays below 1 MiB.
const CHUNK_CHARS = 128 * 1024;
function encodeStateResponse(state, event) {
  if (event.stateTransport !== 1) return state;
  const json = JSON.stringify(state);
  if (event.stateOffset === undefined && Buffer.byteLength(json) < 512 * 1024) return state;
  const offset = event.stateOffset === undefined ? 0 : event.stateOffset;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset >= json.length || offset % CHUNK_CHARS !== 0) {
    throw Object.assign(new Error('无效的故事数据分段'), {code:'INVALID_INPUT'});
  }
  const digest = createHash('sha256').update(json).digest('hex');
  if (offset > 0 && event.stateDigest !== digest) {
    throw Object.assign(new Error('内容已有更新，请重新加载'), {code:'VERSION_CONFLICT'});
  }
  const text = json.slice(offset, offset + CHUNK_CHARS);
  return {stateTransport:1, offset, totalChars:json.length, text, digest,
    nextOffset:offset + text.length < json.length ? offset + text.length : null};
}
module.exports = {encodeStateResponse};
