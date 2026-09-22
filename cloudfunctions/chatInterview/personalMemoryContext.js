const { CANDIDATE_POOL_LIMIT, SELECTOR_VERSION, selectInsights, promptContext, suppressed, textKey } = require('./personalMemoryCore');
const { TABLES, digest, assertEpoch, bumpEpoch, error } = require('./personalMemoryRepository');

async function prepareContext(repo, identity, {nowMs = Date.now(), excludeMemoryId} = {}) {
  await repo.authorize(identity, true);
  const snapshot = await repo.snapshot(identity);
  const candidates = [];
  if (snapshot.control.enabled === true) {
    // Privacy hard boundary: never construct a selection candidate for hidden data.
    const mentionable = snapshot.insights.filter(item => item.userId === identity.accountId && item.status === 'active' && item.allowProactiveMention === true && !item.projectScoped &&
      !suppressed(snapshot.suppressions,identity.accountId,item.lineageKey,item.evidenceIds || [],textKey(item.text)))
      .sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)||b.confidence-a.confidence).slice(0,CANDIDATE_POOL_LIMIT);
    const sources = new Map();
    const records = mentionable.length && repo.sourceRecords ? await repo.sourceRecords(identity) : undefined;
    for (const insight of mentionable) {
      const evidence = snapshot.evidence.filter(item => item.userId === identity.accountId && insight.evidenceIds.includes(item.id) && item.memoryId !== excludeMemoryId);
      const valid = [];
      for (const item of evidence) {
        if (!sources.has(item.memoryId)) sources.set(item.memoryId,await repo.source(identity,item.memoryId,records));
        const source = sources.get(item.memoryId);
        if (source?.fingerprint === item.fingerprint) valid.push(item);
      }
      if (!valid.length) continue;
      candidates.push({lineageKey:insight.lineageKey,category:insight.category,origin:insight.origin,text:insight.text,
        projectScoped:insight.projectScoped,confidence:insight.confidence,updatedAt:insight.updatedAt,
        lastMentionedAt:insight.lastMentionedAt,evidenceIds:valid.map(item=>item.id),
        earliestEvidenceOn:valid.map(item=>item.occurredOn).filter(Boolean).sort()[0] || null});
    }
  }
  const selected = selectInsights(candidates,nowMs);
  // Recheck after assembly so a concurrent forget/disable cannot leak into a prompt.
  await repo.transaction(tx=>assertEpoch(tx,identity,snapshot,true));
  return {snapshot,selected,promptContext:promptContext(selected),selectorVersion:SELECTOR_VERSION};
}
async function commitContext(repo, identity, context, nowMs = Date.now()) {
  if (!context) return;
  await repo.transaction(async tx=>{
    const control = await assertEpoch(tx,identity,context.snapshot,true);
    for (const item of context.selected) {
      const current = await tx.get(TABLES.insights,identity.accountId+'_'+item.lineageKey);
      if (!current || current.status !== 'active' || current.allowProactiveMention !== true || !control.enabled) throw error('PERSONAL_MEMORY_CHANGED');
      for (const evidenceId of item.evidenceIds) {
        const evidence = context.snapshot.evidence.find(value=>value.id===evidenceId);
        const memory = evidence && await tx.get('memories',evidence.sourceDocId);
        const text = Array.isArray(memory?.aiRevisions) ? memory.aiRevisions[0]?.text : memory?.text;
        if (!memory || memory.deletedAt || memory.scope!=='personal' || digest(String(text || '').trim())!==evidence.fingerprint) throw error('PERSONAL_MEMORY_SOURCE_CHANGED');
      }
      await tx.set(TABLES.insights,identity.accountId+'_'+item.lineageKey,{...current,lastMentionedAt:new Date(nowMs).toISOString(),selectorVersion:SELECTOR_VERSION});
    }
    if (context.selected.length) await bumpEpoch(tx,identity,control);
  });
}
module.exports = {prepareContext,commitContext};
