const {parseExtraction,suppressed,textKey,CANDIDATE_POOL_LIMIT} = require('./personalMemoryCore');
const {TABLES,digest,error,assertEpoch,bumpEpoch} = require('./personalMemoryRepository');
const CONSENT_VERSION = 1;
function createMemoryService(repo, {extract, now = Date.now} = {}) {
  return async function dispatch(identity, event = {}) {
    await repo.authorize(identity);
    if (event.action === 'configure') {
      if (typeof event.enabled !== 'boolean' || (event.enabled && event.consentVersion !== CONSENT_VERSION)) throw error('PERSONAL_MEMORY_CONSENT_REQUIRED');
      await repo.transaction(async tx=>{
        await tx.authorize(identity,event.enabled);
        const control = await tx.get(TABLES.controls,identity.accountId) || {version:0,enabled:false};
        await bumpEpoch(tx,identity,control,{enabled:event.enabled,consentVersion:CONSENT_VERSION,decidedAt:new Date(now()).toISOString()});
      });
      return {enabled:event.enabled};
    }
    const snapshot = await repo.snapshot(identity);
    if (event.action === 'list') {
      const insights = snapshot.insights.filter(item=>item.userId===identity.accountId && item.status==='active' && !suppressed(snapshot.suppressions,identity.accountId,item.lineageKey,item.evidenceIds,textKey(item.text)))
        .map(({lineageKey,text,origin,allowProactiveMention})=>({lineageKey,text,origin,allowProactiveMention}));
      await repo.transaction(tx=>assertEpoch(tx,identity,snapshot));
      return {enabled:snapshot.control.enabled===true,insights};
    }
    if (event.action === 'forget') {
      const insight = snapshot.insights.find(item=>item.userId===identity.accountId && item.lineageKey===event.lineageKey);
      if (!insight) throw error('PERSONAL_MEMORY_NOT_FOUND');
      const id = identity.accountId+'_'+insight.lineageKey;
      await repo.transaction(async tx=>{
        const control = await assertEpoch(tx,identity,snapshot);
        const previous = await tx.get(TABLES.suppressions,id);
        await tx.set(TABLES.suppressions,id,{userId:identity.accountId,lineageKey:insight.lineageKey,textKey:textKey(insight.text),
          evidenceIds:[...new Set([...(previous?.evidenceIds || []),...insight.evidenceIds,
            ...snapshot.evidence.filter(item=>item.lineageKeys?.includes(insight.lineageKey)).map(item=>item.id)])],forgottenAt:new Date(now()).toISOString()});
        await tx.set(TABLES.insights,id,{...insight,status:'forgotten'});
        await bumpEpoch(tx,identity,control);
      });
      return {forgotten:true};
    }
    if (event.action !== 'extract') throw error('INVALID_ACTION');
    if (!snapshot.control.enabled) return {status:'disabled'};
    await repo.authorize(identity,true);
    const source = await repo.source(identity,event.memoryId);
    if (!source) return {status:'ineligible'};
    if (snapshot.suppressions.some(item=>item.userId===identity.accountId && item.evidenceIds.includes(source.evidenceId))) return {status:'suppressed'};
    const jobId = source.evidenceId;
    const claimId = digest(jobId+'|'+now()+'|'+Math.random());
    const claimed = await repo.transaction(async tx=>{
      await assertEpoch(tx,identity,snapshot,true);
      const job = await tx.get(TABLES.jobs,jobId);
      if (job?.status==='complete' || (job?.status==='running' && job.startedAt > now()-60000)) return false;
      await tx.set(TABLES.jobs,jobId,{userId:identity.accountId,status:'running',startedAt:now(),claimId});
      return true;
    });
    if (!claimed) return {status:'already_processed'};
    try {
      const candidates = snapshot.insights.filter(item=>item.userId===identity.accountId && item.status==='active' && item.allowProactiveMention===true &&
        !suppressed(snapshot.suppressions,identity.accountId,item.lineageKey,item.evidenceIds,textKey(item.text)))
        .sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)||b.confidence-a.confidence).slice(0,CANDIDATE_POOL_LIMIT)
        .map((item,i)=>({ref:'C'+(i+1),lineageKey:item.lineageKey,category:item.category,text:item.text}));
      const changes = parseExtraction(await extract(source,candidates,identity),candidates);
      const latestSource = await repo.source(identity,event.memoryId);
      if (!latestSource || latestSource.fingerprint !== source.fingerprint) throw error('PERSONAL_MEMORY_SOURCE_CHANGED');
      await repo.transaction(async tx=>{
        const control = await assertEpoch(tx,identity,snapshot,true);
        if (!control.enabled) throw error('PERSONAL_MEMORY_CHANGED');
        const job = await tx.get(TABLES.jobs,jobId);
        if (job?.claimId!==claimId) throw error('PERSONAL_MEMORY_CHANGED');
        // Re-read the authoritative memory in the transaction (deletion/edit races).
        const memory = await tx.get('memories',source.sourceDocId);
        const spoken = Array.isArray(memory?.aiRevisions) ? memory.aiRevisions[0]?.text : memory?.text;
        if (!memory || memory.deletedAt || memory.scope!=='personal' || digest(String(spoken || '').trim())!==source.fingerprint) throw error('PERSONAL_MEMORY_SOURCE_CHANGED');
        const touched = new Set();
        for (const change of changes) {
          const lineageKey = change.lineageKey || digest(identity.accountId+'|'+change.category+'|'+textKey(change.text)).slice(0,32);
          if (touched.has(lineageKey) || suppressed(snapshot.suppressions,identity.accountId,lineageKey,[source.evidenceId],textKey(change.text))) continue;
          touched.add(lineageKey);
          const id = identity.accountId+'_'+lineageKey;
          const previous = await tx.get(TABLES.insights,id);
          const reinforce = previous && change.action==='reinforce';
          const evidenceIds = change.action==='supersede' ? [source.evidenceId] : [...new Set([...(previous?.evidenceIds || []),source.evidenceId])].slice(-20);
          await tx.set(TABLES.insights,id,{userId:identity.accountId,lineageKey,status:'active',category:reinforce?previous.category:change.category,
            text:reinforce?previous.text:change.text,origin:reinforce?previous.origin:change.origin,
            projectScoped:change.projectScoped || Boolean(previous?.projectScoped),
            allowProactiveMention:change.allowProactiveMention && previous?.allowProactiveMention!==false,
            confidence:change.confidence,evidenceIds,revision:(previous?.revision || 0)+1,updatedAt:new Date(now()).toISOString(),
            ...(previous?.lastMentionedAt ? {lastMentionedAt:previous.lastMentionedAt} : {})});
        }
        const {text,...evidence} = source;
        await tx.set(TABLES.evidence,source.evidenceId,{...evidence,id:source.evidenceId,userId:identity.accountId,lineageKeys:[...touched]});
        await tx.set(TABLES.jobs,jobId,{userId:identity.accountId,status:'complete',claimId,completedAt:now()});
        await bumpEpoch(tx,identity,control);
      });
      return {status:'complete'};
    } catch (err) {
      await repo.transaction(async tx=>{
        await tx.authorize(identity);
        const job = await tx.get(TABLES.jobs,jobId);
        if (job?.claimId===claimId) await tx.set(TABLES.jobs,jobId,{...job,status:'failed'});
      }).catch(()=>{});
      throw err;
    }
  };
}
module.exports = {createMemoryService,CONSENT_VERSION};
