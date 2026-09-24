// Synthetic database latency only; this is not a cloud or phone benchmark.
const { performance } = require('node:perf_hooks');
const { createHash } = require('node:crypto');
const { fixture } = require('../tests/helpers/story-access-fixture');
const { createStoryService } = require('../cloudfunctions/storyBooks/service');

async function main() {
  const { repo, account, tables } = fixture();
  account('owner', 'family_stable');
  const context = { APPID: 'wx-original', OPENID: 'owner' };
  const options = { accessEnabled: true, rulesReady: true, bootstrapAppId: context.APPID };
  await createStoryService(repo, options)(context, { action: 'capabilities' });
  for (let i = 0; i < 7; i++) {
    tables.set(`stories:story-${i}`, { familyId: 'family_stable', id: `story-${i}`, title: `测试故事 ${i}`, version: 1 });
    tables.set(`memories:memory-${i}`, { familyId: 'family_stable', frontendContributionId: `memory-${i}`, text: `测试记忆 ${i}` });
  }
  let calls = 0;
  const delayMs = 20;
  const read = async work => { calls++; await new Promise(resolve => setTimeout(resolve, delayMs)); return work(); };
  const wrap = reader => ({ ...reader, get: (table, id) => read(() => reader.get(table, id)) });
  const delayed = {
    ...wrap(repo), all: (table, id) => read(() => repo.all(table, id)),
    transaction: fn => repo.transaction(tx => fn(wrap(tx))),
  };
  const service = createStoryService(delayed, options);
  const samples = [];
  for (let i = 0; i < 3; i++) {
    calls = 0;
    const started = performance.now();
    const result = await service(context, { action: 'state' });
    samples.push({ durationMs: Number((performance.now() - started).toFixed(2)), reads: calls,
      sha256: createHash('sha256').update(JSON.stringify(result)).digest('hex') });
  }
  console.log(JSON.stringify({ synthetic: true, perReadDelayMs: delayMs, samples }, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
