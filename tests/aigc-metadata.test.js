const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const zlib = require("node:zlib");
const test = require("node:test");
const {
  classifyAigcMetadataError,
  createAigcMetadataWriter,
  produceIdFor,
} = require("../cloudfunctions/storyImages/aigcMetadata");

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const JPEG_1X1 = Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wCEAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRQBAwQEBQQFCQUFCRQNCw0UFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFP/AABEIAAIAAgMBEQACEQEDEQH/xAGiAAABBQEBAQEBAQAAAAAAAAAAAQIDBAUGBwgJCgsQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+gEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoLEQACAQIEBAMEBwUEBAABAncAAQIDEQQFITEGEkFRB2FxEyIygQgUQpGhscEJIzNS8BVictEKFiQ04SXxFxgZGiYnKCkqNTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqCg4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2dri4+Tl5ufo6ery8/T19vf4+fr/2gAMAwEAAhEDEQA/APuv9m/wH4a1L9nj4XXd34d0m6u7jwtpcs089jE8kjtaRFmZiuSSSSSeua6+KOHsmpZ9j6dPB0lFVqqSVOCSSnKyStsfP1MlyvHzeMxmFp1KtR80pShGUpSlrKUpNNuTbbbbbbd2f//Z",
  "base64",
);

function pngAigcTexts(buffer) {
  const texts = [];
  for (let offset = 8; offset < buffer.length; ) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "iTXt" && data.subarray(0, 5).equals(Buffer.from("AIGC\0"))) {
      const textStart = data.indexOf(Buffer.from([0, 0, 0, 0]), 5) + 4;
      texts.push(JSON.parse(data.subarray(textStart).toString("utf8")));
    }
    offset += 12 + length;
  }
  return texts;
}

function jpegApp1(payload) {
  const segment = Buffer.alloc(payload.length + 4);
  segment[0] = 0xff;
  segment[1] = 0xe1;
  segment.writeUInt16BE(payload.length + 2, 2);
  payload.copy(segment, 4);
  return segment;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const name = Buffer.from(type, "ascii");
  const output = Buffer.alloc(12 + data.length);
  output.writeUInt32BE(data.length, 0);
  name.copy(output, 4);
  data.copy(output, 8);
  output.writeUInt32BE(crc32(Buffer.concat([name, data])), 8 + data.length);
  return output;
}

function rgbaPng(filter) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 6;
  const pixels = Buffer.from([filter, 12, 34, 56, 255]);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", zlib.deflateSync(pixels)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function pngWithHeaderByte(buffer, index, value) {
  const output = Buffer.from(buffer);
  output[24 + index] = value;
  output.writeUInt32BE(crc32(output.subarray(12, 29)), 29);
  return output;
}

function pngWithValidCrcButInvalidPixels(buffer) {
  const output = Buffer.from(buffer);
  for (let offset = 8; offset < output.length; ) {
    const length = output.readUInt32BE(offset);
    if (output.toString("ascii", offset + 4, offset + 8) === "IDAT") {
      output.fill(0, offset + 8, offset + 8 + length);
      output.writeUInt32BE(crc32(output.subarray(offset + 4, offset + 8 + length)), offset + 8 + length);
      return output;
    }
    offset += 12 + length;
  }
  throw new Error("fixture has no IDAT");
}

function jpegWithValidMarkersButInvalidPixels(buffer) {
  const sos = buffer.indexOf(Buffer.from([0xff, 0xda]));
  const scanStart = sos + 2 + buffer.readUInt16BE(sos + 2);
  return Buffer.concat([buffer.subarray(0, scanStart), Buffer.from([0xff, 0xd9])]);
}

function pngWithManyChunks(buffer, count) {
  const headerEnd = 8 + 12 + buffer.readUInt32BE(8);
  const chunks = Array.from({ length: count }, () => pngChunk("aaAa", Buffer.alloc(0)));
  return Buffer.concat([buffer.subarray(0, headerEnd), ...chunks, buffer.subarray(headerEnd)]);
}

function jpegWithManySegments(buffer, count) {
  const segments = Array.from({ length: count }, () => Buffer.from([0xff, 0xe2, 0x00, 0x02]));
  return Buffer.concat([buffer.subarray(0, 2), ...segments, buffer.subarray(2)]);
}

function jpegSegmentCount(buffer) {
  let count = 0;
  for (let offset = 2; offset < buffer.length; ) {
    while (buffer[offset] === 0xff) offset += 1;
    const marker = buffer[offset];
    offset += 1;
    const length = buffer.readUInt16BE(offset);
    count += 1;
    if (marker === 0xda) return count;
    offset += length;
  }
  throw new Error("fixture has no SOS");
}

test("configured requires a non-empty content producer", () => {
  assert.equal(createAigcMetadataWriter({ contentProducer: "" }).configured, false);
  assert.equal(createAigcMetadataWriter({ contentProducer: "wx-test-provider" }).configured, true);
});

test("derives a stable, irreversible ProduceID from a source identifier", () => {
  const source = "openid-and-private-job-id-123";
  const first = produceIdFor(source);
  const expected = crypto.createHash("sha256").update(source, "utf8").digest("hex");
  assert.equal(first, expected);
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(produceIdFor(source), first);
  assert.notEqual(produceIdFor(`${source}-other`), first);
  assert.equal(first.includes(source), false);
  const written = createAigcMetadataWriter({ contentProducer: "wx-test-provider" })
    .writeForSource(PNG_1X1, "image/png", source);
  assert.equal(written.produceId, expected);
});

test("classifies deterministic image errors as terminal and configuration or unknown errors as retryable", () => {
  assert.deepEqual(classifyAigcMetadataError(new Error("AIGC_IMAGE_DECODE_FAILED")), {
    errorCode: "AIGC_IMAGE_DECODE_FAILED", terminal: true,
  });
  assert.deepEqual(classifyAigcMetadataError(new Error("AIGC_METADATA_NOT_CONFIGURED")), {
    errorCode: "AIGC_METADATA_NOT_CONFIGURED", terminal: false,
  });
  assert.deepEqual(classifyAigcMetadataError(new Error("AIGC_WEBP_UNSUPPORTED")), {
    errorCode: "AIGC_WEBP_UNSUPPORTED", terminal: false,
  });
  assert.deepEqual(classifyAigcMetadataError(new Error("credential detail")), {
    errorCode: "AIGC_METADATA_FAILED", terminal: false,
  });
});

test("writes the complete AIGC JSON into one valid PNG iTXt chunk", () => {
  const writer = createAigcMetadataWriter({ contentProducer: "wx-test-provider" });
  const result = writer.write(PNG_1X1, "image/png", "job-123");
  assert.equal(result.contentType, "image/png");
  assert.equal(result.produceId, "job-123");
  assert.deepEqual(pngAigcTexts(result.buffer), [{
    AIGC: {
      Label: "1",
      ContentProducer: "wx-test-provider",
      ProduceID: "job-123",
      ReservedCode1: "",
      ContentPropagator: "",
      PropagateID: "",
      ReservedCode2: "",
    },
  }]);
  assert.deepEqual(writer.write(result.buffer, result.contentType, result.produceId), result);
});

test("writes one AIGC XMP APP1 segment into JPEG and is idempotent", () => {
  const writer = createAigcMetadataWriter({ contentProducer: "wx-test-provider" });
  const once = writer.write(JPEG_1X1, "image/jpeg", "job-456");
  const twice = writer.write(once.buffer, once.contentType, once.produceId);
  const text = twice.buffer.toString("utf8");
  assert.equal(twice.contentType, "image/jpeg");
  assert.equal(twice.produceId, "job-456");
  assert.equal((text.match(/xmlns:AIGC=/g) || []).length, 1);
  assert.match(text, /AIGC:Metadata/);
  assert.match(text, /&quot;ProduceID&quot;:&quot;job-456&quot;/);
  assert.deepEqual(twice.buffer, once.buffer);
});

test("preserves unrelated XMP that happens to declare an AIGC namespace", () => {
  const unrelated = jpegApp1(Buffer.from(
    "http://ns.adobe.com/xap/1.0/\0<rdf:Description xmlns:AIGC=\"urn:other:aigc\" AIGC:Rating=\"reviewed\"/>",
    "utf8",
  ));
  const input = Buffer.concat([JPEG_1X1.subarray(0, 2), unrelated, JPEG_1X1.subarray(2)]);
  const output = createAigcMetadataWriter({ contentProducer: "wx-test-provider" })
    .write(input, "image/jpeg", "job-789").buffer;
  assert.ok(output.includes(unrelated));
  assert.match(output.toString("utf8"), /AIGC:Metadata/);
});

test("rejects MIME and magic-byte mismatches, malformed images, and unsupported WebP", () => {
  const writer = createAigcMetadataWriter({ contentProducer: "wx-test-provider" });
  assert.throws(() => writer.write(PNG_1X1, "image/jpeg", "id"), /AIGC_IMAGE_TYPE_MISMATCH/);
  assert.throws(() => writer.write(PNG_1X1.subarray(0, 20), "image/png", "id"), /AIGC_IMAGE_MALFORMED/);
  assert.throws(() => writer.write(JPEG_1X1.subarray(0, 40), "image/jpeg", "id"), /AIGC_IMAGE_MALFORMED/);
  const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 ")]);
  assert.throws(() => writer.write(webp, "image/webp", "id"), /AIGC_WEBP_UNSUPPORTED/);
});

test("fully decodes pixels instead of trusting valid PNG CRCs or JPEG markers", () => {
  const writer = createAigcMetadataWriter({ contentProducer: "wx-test-provider" });
  writer.write(PNG_1X1, "image/png", "valid-first");
  for (let filter = 0; filter <= 4; filter += 1) {
    assert.equal(writer.write(rgbaPng(filter), "image/png", `filter-${filter}`).contentType, "image/png");
  }
  assert.throws(() => writer.write(rgbaPng(5), "image/png", "bad-filter"), /AIGC_IMAGE_DECODE_FAILED/);
  const invalidPng = pngWithValidCrcButInvalidPixels(PNG_1X1);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    assert.throws(
      () => writer.write(invalidPng, "image/png", `invalid-${attempt}`),
      /AIGC_IMAGE_DECODE_FAILED/,
    );
  }
  assert.throws(
    () => writer.write(jpegWithValidMarkersButInvalidPixels(JPEG_1X1), "image/jpeg", "id"),
    /AIGC_IMAGE_DECODE_FAILED/,
  );
  assert.throws(
    () => writer.write(pngWithHeaderByte(PNG_1X1, 0, 16), "image/png", "16-bit"),
    /AIGC_PNG_FORMAT_UNSUPPORTED/,
  );
});

test("bounds PNG chunk and JPEG segment counts before building unbounded parser state", () => {
  const writer = createAigcMetadataWriter({ contentProducer: "wx-test-provider" });
  assert.throws(() => writer.write(pngWithManyChunks(PNG_1X1, 4097), "image/png", "png-bomb"), /AIGC_IMAGE_MALFORMED/);
  assert.throws(() => writer.write(jpegWithManySegments(JPEG_1X1, 4097), "image/jpeg", "jpeg-bomb"), /AIGC_IMAGE_MALFORMED/);
});

test("metadata insertion respects exact PNG and JPEG structural limits and remains idempotent", () => {
  const writer = createAigcMetadataWriter({ contentProducer: "wx-test-provider" });
  assert.throws(
    () => writer.write(pngWithManyChunks(PNG_1X1, 4093), "image/png", "png-at-cap"),
    /AIGC_METADATA_TOO_LARGE/,
  );
  const markedPng = writer.write(PNG_1X1, "image/png", "png-first").buffer;
  const paddedPng = pngWithManyChunks(markedPng, 4092);
  const rewrittenPng = writer.write(paddedPng, "image/png", "png-second").buffer;
  assert.deepEqual(writer.write(rewrittenPng, "image/png", "png-second").buffer, rewrittenPng);

  const jpegPadding = 4096 - jpegSegmentCount(JPEG_1X1);
  assert.throws(
    () => writer.write(jpegWithManySegments(JPEG_1X1, jpegPadding), "image/jpeg", "jpeg-at-cap"),
    /AIGC_METADATA_TOO_LARGE/,
  );
  const markedJpeg = writer.write(JPEG_1X1, "image/jpeg", "jpeg-first").buffer;
  const paddedJpeg = jpegWithManySegments(markedJpeg, 4096 - jpegSegmentCount(markedJpeg));
  const rewrittenJpeg = writer.write(paddedJpeg, "image/jpeg", "jpeg-second").buffer;
  assert.deepEqual(writer.write(rewrittenJpeg, "image/jpeg", "jpeg-second").buffer, rewrittenJpeg);
});

test("requires configured metadata and safe identifiers without accepting content text", () => {
  assert.throws(
    () => createAigcMetadataWriter({ contentProducer: "" }).write(PNG_1X1, "image/png", "id"),
    /AIGC_METADATA_NOT_CONFIGURED/,
  );
  const writer = createAigcMetadataWriter({ contentProducer: "wx-test-provider" });
  assert.throws(() => writer.write(PNG_1X1, "image/png", ""), /AIGC_PRODUCE_ID_REQUIRED/);
  const output = writer.write(PNG_1X1, "image/png", "job-safe-789");
  const serialized = output.buffer.toString("utf8");
  assert.doesNotMatch(serialized, /prompt|api[_-]?key|正文/i);
});
