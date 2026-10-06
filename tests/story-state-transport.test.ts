import test from 'node:test';
import assert from 'node:assert/strict';
import { readStoryState } from '../miniprogram/services/storyStateTransport';
const { encodeStateResponse } = require('../cloudfunctions/storyBooks/stateTransport');

test('large story state retains every revision and unicode character below the cloud response limit', async () => {
  const state = {roomStateVersion:1, manuscriptRevisions:[{text:'温馨🐈\n"\\'.repeat(160000)}]};
  let calls = 0;
  const result = await readStoryState(async data => {
    calls++;
    const response = encodeStateResponse(state, data);
    assert.ok(Buffer.byteLength(JSON.stringify(response)) < 1048576);
    return response;
  });
  assert.deepEqual(result, state);
  assert.ok(calls > 1);
});

test('small and legacy responses stay compatible', async () => {
  const state = {roomStateVersion:1, stories:[]};
  assert.equal(encodeStateResponse(state, {}), state);
  assert.deepEqual(await readStoryState(async () => state), state);
});

test('a changed snapshot is refused instead of mixing history from different reads', async () => {
  const first = encodeStateResponse({text:'甲'.repeat(400000)}, {stateTransport:1});
  assert.throws(() => encodeStateResponse({text:'乙'.repeat(400000)}, {
    stateTransport:1, stateOffset:first.nextOffset, stateDigest:first.digest,
  }), /内容已有更新/);
});

test('malformed or non-progressing chunks are rejected', async () => {
  for (const chunk of [
    {stateTransport:1,offset:0,totalChars:5,text:'abc',digest:'a'.repeat(64),nextOffset:0},
    {stateTransport:1,offset:1,totalChars:5,text:'abc',digest:'a'.repeat(64),nextOffset:4},
  ]) await assert.rejects(readStoryState(async () => chunk), /故事数据分段无效/);
});

test('snapshot changes or errors midway never return a partial room', async () => {
  let calls=0;
  const first=encodeStateResponse({text:'甲'.repeat(400000)}, {stateTransport:1});
  await assert.rejects(readStoryState(async () => ++calls === 1 ? first : {...first,digest:'b'.repeat(64)}), /故事数据分段无效/);
  calls=0;
  await assert.rejects(readStoryState(async () => {
    if (++calls===1) return first;
    throw new Error('network failed');
  }), /network failed/);
});
