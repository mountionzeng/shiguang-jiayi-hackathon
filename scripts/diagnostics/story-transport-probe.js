/* Diagnostic helper only. Copy with the diagnostic page into an isolated preview.
 * Never retain/print the response body, account IDs, titles, text or fingerprints.
 */
const ACTIONS = ['capabilities', 'state', 'state', 'capabilities', 'capabilities', 'state'];
const STATE_FIELDS = ['members', 'contributions', 'manuscriptRevisions', 'stories', 'storyMigration',
  'draft', 'personalDrafts', 'deletedStories', 'draftSourceFingerprint', 'personalDraftSourceFingerprints'];

function utf8Bytes(text) {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes++;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length
      && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) { bytes += 4; i++; }
    else bytes += 3;
  }
  return bytes;
}

function jsonBytes(value) {
  const text = JSON.stringify(value);
  return text === undefined ? 0 : utf8Bytes(text);
}

function summarize(result, action, now) {
  const startedAt = now();
  const body = JSON.stringify(result);
  const stringifyMs = now() - startedAt;
  const parseStart = now();
  JSON.parse(body);
  const parseMs = now() - parseStart;
  const summary = { chars: body.length, utf8Bytes: utf8Bytes(body), stringifyMs, parseMs };
  if (action === 'state') {
    summary.fields = Object.fromEntries(STATE_FIELDS.filter(key => result[key] !== undefined)
      .map(key => [key, { bytes: jsonBytes(result[key]),
        ...(Array.isArray(result[key]) ? { count: result[key].length } : {}) }]));
    const revisions = result.manuscriptRevisions || [];
    const currentIds = new Set((result.stories || []).map(story => story.currentRevisionId).filter(Boolean));
    const current = revisions.filter(revision => currentIds.has(revision.id));
    summary.revisions = { count: revisions.length, currentStoryPointers: currentIds.size,
      matchingCurrentCount: current.length, matchingCurrentBytes: jsonBytes(current) };
    summary.migrationActive = result.storyMigration?.status === 'active';
  }
  summary.analysisMs = now() - startedAt;
  return summary;
}

async function runStoryTransportProbe(callFunction, options = {}) {
  const now = options.now || Date.now;
  const samples = [];
  for (const action of ACTIONS) {
    if (options.cancelled?.()) break;
    const startedAt = now();
    let response;
    try {
      response = await callFunction({ name: 'storyBooks', data: { action } });
    } catch {
      // Do not expose SDK errors: they can contain URLs, request payloads or IDs.
      samples.push({ action, startedAt, durationMs: now() - startedAt, ok: false, failure: 'transport' });
      break;
    }
    const durationMs = now() - startedAt;
    const result = response?.result;
    if (!result || typeof result !== 'object' || result.error
      || (action === 'state' && (!Array.isArray(result.manuscriptRevisions) || !Array.isArray(result.stories)))) {
      samples.push({ action, startedAt, durationMs, ok: false, failure: 'response' });
      break;
    }
    const requestID = typeof response.requestID === 'string' && /^[a-f0-9-]{36}$/i.test(response.requestID)
      ? response.requestID : undefined;
    const sample = { action, startedAt, durationMs, ok: true,
      ...(requestID ? { requestID } : {}), ...summarize(result, action, now) };
    samples.push(sample);
    options.onSample?.(sample);
  }
  return samples;
}

module.exports = { runStoryTransportProbe, utf8Bytes };
