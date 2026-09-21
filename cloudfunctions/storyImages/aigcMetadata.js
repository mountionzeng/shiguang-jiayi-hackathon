const crypto = require("node:crypto");
const zlib = require("node:zlib");
const jpeg = require("jpeg-js");

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const XMP_HEADER = Buffer.from("http://ns.adobe.com/xap/1.0/\0", "ascii");
// A private XMP namespace only scopes the `AIGC:Metadata` property; the value
// itself follows GB 45438-2025's AIGC JSON structure.
const AIGC_NAMESPACE = "urn:shiguang:aigc:metadata:1.0";
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 12 * 1024 * 1024;
const MAX_IMAGE_DIMENSION = 8192;
const MAX_DECODED_BYTES = MAX_IMAGE_PIXELS * 4;
const MAX_PNG_CHUNKS = 4096;
const MAX_JPEG_SEGMENTS = 4096;
const TERMINAL_METADATA_ERRORS = new Set([
  "AIGC_IMAGE_DECODE_FAILED",
  "AIGC_IMAGE_MALFORMED",
  "AIGC_IMAGE_TYPE_MISMATCH",
  "AIGC_METADATA_TOO_LARGE",
  "AIGC_METADATA_VALIDATION_FAILED",
  "AIGC_PNG_FORMAT_UNSUPPORTED",
  "AIGC_PRODUCE_ID_REQUIRED",
  "AIGC_SOURCE_ID_REQUIRED",
]);

function failure(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function classifyAigcMetadataError(error) {
  const candidate = String((error && (error.code || error.message)) || "");
  const errorCode = /^AIGC_[A-Z0-9_]{1,35}$/.test(candidate) ? candidate : "AIGC_METADATA_FAILED";
  return { errorCode, terminal: TERMINAL_METADATA_ERRORS.has(errorCode) };
}

function safeText(value, code) {
  const text = String(value || "").trim();
  if (!text || text.length > 512 || /[\0-\x1f\x7f]/.test(text)) throw failure(code);
  return text;
}

function produceIdFor(sourceId) {
  const source = safeText(sourceId, "AIGC_SOURCE_ID_REQUIRED");
  return crypto.createHash("sha256").update(source, "utf8").digest("hex");
}

function metadataFor(contentProducer, produceId) {
  return {
    AIGC: {
      Label: "1",
      ContentProducer: contentProducer,
      ProduceID: produceId,
      ReservedCode1: "",
      ContentPropagator: "",
      PropagateID: "",
      ReservedCode2: "",
    },
  };
}

let crcTable;
function crc32(...buffers) {
  if (!crcTable) {
    crcTable = Array.from({ length: 256 }, (_, value) => {
      let crc = value;
      for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
      return crc >>> 0;
    });
  }
  let crc = 0xffffffff;
  for (const buffer of buffers) {
    for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const name = Buffer.from(type, "ascii");
  const output = Buffer.alloc(12 + data.length);
  output.writeUInt32BE(data.length, 0);
  name.copy(output, 4);
  data.copy(output, 8);
  output.writeUInt32BE(crc32(name, data), 8 + data.length);
  return output;
}

function parsePng(buffer) {
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) throw failure("AIGC_IMAGE_TYPE_MISMATCH");
  const chunks = [];
  let offset = 8;
  while (offset < buffer.length) {
    if (offset + 12 > buffer.length) throw failure("AIGC_IMAGE_MALFORMED");
    const length = buffer.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (length > 64 * 1024 * 1024 || end > buffer.length) throw failure("AIGC_IMAGE_MALFORMED");
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    const expected = buffer.readUInt32BE(offset + 8 + length);
    if (crc32(buffer.subarray(offset + 4, offset + 8), data) !== expected) throw failure("AIGC_IMAGE_MALFORMED");
    if (chunks.length >= MAX_PNG_CHUNKS) throw failure("AIGC_IMAGE_MALFORMED");
    chunks.push({ type, data, raw: buffer.subarray(offset, end) });
    offset = end;
    if (type === "IEND") break;
  }
  if (chunks[0]?.type !== "IHDR" || chunks.at(-1)?.type !== "IEND" || offset !== buffer.length) {
    throw failure("AIGC_IMAGE_MALFORMED");
  }
  if (
    chunks[0].data.length !== 13
    || chunks[0].data.readUInt32BE(0) === 0
    || chunks[0].data.readUInt32BE(4) === 0
    || chunks.at(-1).data.length !== 0
    || !chunks.some((chunk) => chunk.type === "IDAT")
  ) throw failure("AIGC_IMAGE_MALFORMED");
  let idatStarted = false;
  let idatEnded = false;
  for (let index = 0; index < chunks.length; index += 1) {
    const { type } = chunks[index];
    if (!/^[A-Za-z]{4}$/.test(type)) throw failure("AIGC_IMAGE_MALFORMED");
    if (index > 0 && type === "IHDR") throw failure("AIGC_IMAGE_MALFORMED");
    if (type === "PLTE" && idatStarted) throw failure("AIGC_IMAGE_MALFORMED");
    if (type === "IDAT") {
      if (idatEnded) throw failure("AIGC_IMAGE_MALFORMED");
      idatStarted = true;
    } else if (idatStarted && type !== "IEND") {
      idatEnded = true;
    }
    if (/^[A-Z]/.test(type) && !["IHDR", "PLTE", "IDAT", "IEND"].includes(type)) {
      throw failure("AIGC_IMAGE_MALFORMED");
    }
  }
  return chunks;
}

function isAigcPngText(chunk) {
  return chunk.type === "iTXt" && chunk.data.length >= 5 && chunk.data.subarray(0, 5).equals(Buffer.from("AIGC\0"));
}

function writePng(buffer, json, chunks) {
  const data = Buffer.concat([Buffer.from("AIGC\0", "ascii"), Buffer.from([0, 0, 0, 0]), Buffer.from(json, "utf8")]);
  const desired = pngChunk("iTXt", data);
  const existing = chunks.filter(isAigcPngText);
  if (existing.length === 1 && existing[0].raw.equals(desired)) return buffer;
  const keptCount = chunks.length - existing.length;
  if (keptCount + 1 > MAX_PNG_CHUNKS) throw failure("AIGC_METADATA_TOO_LARGE");
  const output = [PNG_SIGNATURE];
  for (const chunk of chunks) {
    if (isAigcPngText(chunk)) continue;
    if (chunk.type === "IEND") output.push(desired);
    output.push(chunk.raw);
  }
  return Buffer.concat(output);
}

function escapeXml(value) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function xmpSegment(json) {
  const xml = `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:AIGC="${AIGC_NAMESPACE}" AIGC:Metadata="${escapeXml(json)}"/></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;
  const payload = Buffer.concat([XMP_HEADER, Buffer.from(xml, "utf8")]);
  if (payload.length + 2 > 0xffff) throw failure("AIGC_METADATA_TOO_LARGE");
  const segment = Buffer.alloc(payload.length + 4);
  segment[0] = 0xff;
  segment[1] = 0xe1;
  segment.writeUInt16BE(payload.length + 2, 2);
  payload.copy(segment, 4);
  return segment;
}

function parseJpegHeader(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) throw failure("AIGC_IMAGE_TYPE_MISMATCH");
  const segments = [];
  let offset = 2;
  let scanStart = -1;
  let hasSof = false;
  while (offset < buffer.length) {
    if (buffer[offset] !== 0xff) throw failure("AIGC_IMAGE_MALFORMED");
    while (buffer[offset] === 0xff) offset += 1;
    if (offset >= buffer.length) throw failure("AIGC_IMAGE_MALFORMED");
    const marker = buffer[offset];
    const start = offset - 1;
    offset += 1;
    if (marker === 0xd9) throw failure("AIGC_IMAGE_MALFORMED");
    if (marker === 0xd8 || marker === 0x00 || (marker >= 0xd0 && marker <= 0xd7)) throw failure("AIGC_IMAGE_MALFORMED");
    if (offset + 2 > buffer.length) throw failure("AIGC_IMAGE_MALFORMED");
    const length = buffer.readUInt16BE(offset);
    if (length < 2 || offset + length > buffer.length) throw failure("AIGC_IMAGE_MALFORMED");
    const end = offset + length;
    if (segments.length >= MAX_JPEG_SEGMENTS) throw failure("AIGC_IMAGE_MALFORMED");
    segments.push({ marker, raw: buffer.subarray(start, end) });
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      if (length < 8 || buffer.readUInt16BE(offset + 3) === 0 || buffer.readUInt16BE(offset + 5) === 0) {
        throw failure("AIGC_IMAGE_MALFORMED");
      }
      hasSof = true;
    }
    offset = end;
    if (marker === 0xda) {
      scanStart = start;
      break;
    }
  }
  if (scanStart < 0 || !hasSof) throw failure("AIGC_IMAGE_MALFORMED");
  let eoi = -1;
  for (let index = offset; index + 1 < buffer.length; index += 1) {
    if (buffer[index] !== 0xff) continue;
    let next = index + 1;
    while (next < buffer.length && buffer[next] === 0xff) next += 1;
    if (next >= buffer.length) break;
    if (buffer[next] === 0x00 || (buffer[next] >= 0xd0 && buffer[next] <= 0xd7)) {
      index = next;
      continue;
    }
    if (buffer[next] === 0xd9) {
      eoi = next + 1;
      break;
    }
  }
  if (eoi !== buffer.length) throw failure("AIGC_IMAGE_MALFORMED");
  return { segments: segments.slice(0, -1), tail: buffer.subarray(scanStart) };
}

function isOwnAigcXmp(segment) {
  const namespace = Buffer.from(`xmlns:AIGC="${AIGC_NAMESPACE}" AIGC:Metadata="`, "utf8");
  return segment.marker === 0xe1 && segment.raw.includes(XMP_HEADER) && segment.raw.includes(namespace);
}

function writeJpeg(buffer, json) {
  const parsed = parseJpegHeader(buffer);
  const desired = xmpSegment(json);
  const existing = parsed.segments.filter(isOwnAigcXmp);
  if (existing.length === 1 && existing[0].raw.equals(desired)) return buffer;
  const kept = parsed.segments.filter((segment) => !isOwnAigcXmp(segment)).map((segment) => segment.raw);
  if (kept.length + 2 > MAX_JPEG_SEGMENTS) throw failure("AIGC_METADATA_TOO_LARGE");
  const written = Buffer.concat([buffer.subarray(0, 2), desired, ...kept, parsed.tail]);
  const validated = parseJpegHeader(written).segments.filter(isOwnAigcXmp);
  if (validated.length !== 1 || !validated[0].raw.equals(desired)) throw failure("AIGC_METADATA_VALIDATION_FAILED");
  return written;
}

function validateDimensions(width, height) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    throw failure("AIGC_IMAGE_MALFORMED");
  }
  if (
    width > MAX_IMAGE_DIMENSION
    || height > MAX_IMAGE_DIMENSION
    || width > Math.floor(MAX_IMAGE_PIXELS / height)
  ) throw failure("AIGC_IMAGE_DECODE_FAILED");
}

function paethPredictor(left, above, upperLeft) {
  const estimate = left + above - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const aboveDistance = Math.abs(estimate - above);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) return left;
  return aboveDistance <= upperLeftDistance ? above : upperLeft;
}

function decodePng(chunks) {
  const header = chunks[0].data;
  const width = header.readUInt32BE(0);
  const height = header.readUInt32BE(4);
  validateDimensions(width, height);
  const bitDepth = header[8];
  const colorType = header[9];
  const compression = header[10];
  const filterMethod = header[11];
  const interlace = header[12];
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  if (bitDepth !== 8 || !channels || compression !== 0 || filterMethod !== 0 || interlace !== 0) {
    throw failure("AIGC_PNG_FORMAT_UNSUPPORTED");
  }
  const rowBytes = width * channels;
  const expectedBytes = (rowBytes + 1) * height;
  try {
    const idat = chunks.filter((chunk) => chunk.type === "IDAT").map((chunk) => chunk.data);
    const compressed = idat.length === 1 ? idat[0] : Buffer.concat(idat);
    const inflated = zlib.inflateSync(compressed, { info: true, maxOutputLength: expectedBytes + 1 });
    const pixels = inflated.buffer;
    if (inflated.engine.bytesWritten !== compressed.length) throw failure("AIGC_IMAGE_DECODE_FAILED");
    if (pixels.length !== expectedBytes) throw failure("AIGC_IMAGE_DECODE_FAILED");
    let previous;
    for (let rowIndex = 0; rowIndex < height; rowIndex += 1) {
      const offset = rowIndex * (rowBytes + 1);
      const filter = pixels[offset];
      if (filter > 4) throw failure("AIGC_IMAGE_DECODE_FAILED");
      const row = pixels.subarray(offset + 1, offset + 1 + rowBytes);
      for (let index = 0; index < row.length; index += 1) {
        const left = index >= channels ? row[index - channels] : 0;
        const above = previous ? previous[index] : 0;
        const upperLeft = previous && index >= channels ? previous[index - channels] : 0;
        if (filter === 1) row[index] = (row[index] + left) & 0xff;
        else if (filter === 2) row[index] = (row[index] + above) & 0xff;
        else if (filter === 3) row[index] = (row[index] + Math.floor((left + above) / 2)) & 0xff;
        else if (filter === 4) row[index] = (row[index] + paethPredictor(left, above, upperLeft)) & 0xff;
      }
      previous = row;
    }
  } catch (error) {
    if (String(error && error.code).startsWith("AIGC_")) throw error;
    throw failure("AIGC_IMAGE_DECODE_FAILED");
  }
}

function decodeJpeg(buffer) {
  try {
    const decoded = jpeg.decode(buffer, {
      useTArray: true,
      formatAsRGBA: true,
      maxResolutionInMP: MAX_IMAGE_PIXELS / 1e6,
      maxMemoryUsageInMB: MAX_DECODED_BYTES / (1024 * 1024),
    });
    validateDimensions(decoded.width, decoded.height);
    if (!decoded.data || decoded.data.length !== decoded.width * decoded.height * 4) {
      throw failure("AIGC_IMAGE_DECODE_FAILED");
    }
  } catch (error) {
    if (error?.code === "AIGC_IMAGE_DECODE_FAILED") throw error;
    throw failure("AIGC_IMAGE_DECODE_FAILED");
  }
}

function createAigcMetadataWriter({ contentProducer } = {}) {
  let producer = "";
  try {
    producer = safeText(contentProducer, "AIGC_CONTENT_PRODUCER_REQUIRED");
  } catch (_) {
    // Configuration is intentionally represented by `configured`; write fails closed below.
  }
  function write(input, contentType, produceId) {
    if (!producer) throw failure("AIGC_METADATA_NOT_CONFIGURED");
    if (!Buffer.isBuffer(input) || input.length === 0) throw failure("AIGC_IMAGE_MALFORMED");
    if (input.length > MAX_IMAGE_BYTES) throw failure("AIGC_IMAGE_DECODE_FAILED");
    const id = safeText(produceId, "AIGC_PRODUCE_ID_REQUIRED");
    const json = JSON.stringify(metadataFor(producer, id));
    const mediaType = String(contentType || "").trim().toLowerCase();
    let buffer;
    if (mediaType === "image/png") {
      const chunks = parsePng(input);
      decodePng(chunks);
      buffer = writePng(input, json, chunks);
    } else if (mediaType === "image/jpeg") {
      buffer = writeJpeg(input, json);
      decodeJpeg(buffer);
    } else if (mediaType === "image/webp") {
      if (input.length < 12 || input.toString("ascii", 0, 4) !== "RIFF" || input.toString("ascii", 8, 12) !== "WEBP") {
        throw failure("AIGC_IMAGE_TYPE_MISMATCH");
      }
      throw failure("AIGC_WEBP_UNSUPPORTED");
    } else {
      throw failure("AIGC_IMAGE_TYPE_MISMATCH");
    }
    if (buffer.length > MAX_IMAGE_BYTES) throw failure("AIGC_IMAGE_DECODE_FAILED");
    return { buffer, contentType: mediaType, produceId: id };
  }
  return {
    configured: Boolean(producer),
    produceIdFor,
    write,
    writeForSource(input, contentType, sourceId) {
      return write(input, contentType, produceIdFor(sourceId));
    },
  };
}

module.exports = { classifyAigcMetadataError, createAigcMetadataWriter, produceIdFor };
