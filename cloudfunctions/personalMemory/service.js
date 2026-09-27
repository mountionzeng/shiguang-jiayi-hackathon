const {parseExtraction,suppressed,textKey,CANDIDATE_POOL_LIMIT,distinctTellingCount,isTendencyReady} = require('./personalMemoryCore');
const {TABLES,digest,error,assertEpoch,bumpEpoch,validInsightEvidence} = require('./personalMemoryRepository');
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
      const records = repo.sourceRecords ? await repo.sourceRecords(identity) : undefined;
      const active = snapshot.insights.filter(item=>item.userId===identity.accountId && item.status==='active' && !suppressed(snapshot.suppressions,identity.accountId,item.lineageKey,item.evidenceIds,textKey(item.text)));
      const insights = [];
      const sourceCache = new Map();
      for (const item of active) {
        const evidence = await validInsightEvidence(repo,identity,item,snapshot.evidence,{records,sources:sourceCache});
        if (!evidence.length || !isTendencyReady(item,distinctTellingCount(evidence))) continue;
        const sources = evidence.map(reference=>({id:reference.id,label:reference.kind==='user_correction'?'你的纠正':'讲述',
          occurredOn:reference.occurredOn || null,excerpt:reference.excerpt}));
        sources.sort((a,b)=>String(a.occurredOn||'').localeCompare(String(b.occurredOn||'')));
        insights.push({lineageKey:item.lineageKey,text:item.text,origin:item.origin,allowProactiveMention:item.allowProactiveMention,evidence:sources});
      }
      await repo.transaction(tx=>assertEpoch(tx,identity,snapshot));
      return {enabled:snapshot.control.enabled===true,insights};
    }
    if (event.action === 'confirm' || event.action === 'correct') {
      const insight = snapshot.insights.find(item=>item.userId===identity.accountId && item.status==='active' && item.lineageKey===event.lineageKey);
      if (!insight) throw error('PERSONAL_MEMORY_NOT_FOUND');
      if (event.action === 'correct' && event.text !== undefined && typeof event.text !== 'string') throw error('INVALID_CORRECTION');
      const correction = event.action === 'correct' ? String(event.text || '').trim() : '';
      if (correction && Array.from(correction).length > 60) throw error('INVALID_CORRECTION');
      await repo.transaction(async tx=>{
        const control = await assertEpoch(tx,identity,snapshot);
        const id = identity.accountId+'_'+insight.lineageKey;
        const current = await tx.get(TABLES.insights,id);
        if (!current || current.status!=='active') throw error('PERSONAL_MEMORY_CHANGED');
        const nowIso = new Date(now()).toISOString();
        if (event.action === 'confirm') {
          await tx.set(TABLES.insights,id,{...current,origin:'user_stated',confirmedAt:nowIso,lastMentionedAt:null,revision:(current.revision || 0)+1,updatedAt:nowIso});
        } else if (correction) {
          const correctionEvidenceId=digest(identity.accountId+'|correction|'+insight.lineageKey+'|'+nowIso+'|'+digest(correction));
          await tx.set(TABLES.evidence,correctionEvidenceId,{id:correctionEvidenceId,userId:identity.accountId,kind:'user_correction',
            lineageKeys:[insight.lineageKey],fingerprint:digest(correction),correctionText:correction,occurredOn:nowIso.slice(0,10)});
          await tx.set(TABLES.insights,id,{...current,text:correction,origin:'user_corrected',correctionText:correction,correctionEvidenceId,
            evidenceIds:[correctionEvidenceId],correctedAt:nowIso,lastMentionedAt:null,revision:(current.revision || 0)+1,updatedAt:nowIso});
        } else {
          const previous = await tx.get(TABLES.suppressions,id);
          await tx.set(TABLES.suppressions,id,{userId:identity.accountId,lineageKey:insight.lineageKey,textKey:textKey(insight.text),
            evidenceIds:[...new Set([...(previous?.evidenceIds || []),...insight.evidenceIds,
              ...snapshot.evidence.filter(item=>item.lineageKeys?.includes(insight.lineageKey)).map(item=>item.id)])],
            reason:'user_corrected',forgottenAt:new Date(now()).toISOString()});
          await tx.set(TABLES.insights,id,{...current,status:'corrected',origin:'user_corrected',allowProactiveMention:false,correctedAt:nowIso,revision:(current.revision || 0)+1,updatedAt:nowIso});
        }
        await bumpEpoch(tx,identity,control);
      });
      return event.action==='confirm' ? {confirmed:true} : {corrected:Boolean(correction),disabled:!correction};
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
    const sourceRecords = repo.sourceRecords ? await repo.sourceRecords(identity) : undefined;
    const source = await repo.source(identity,event.memoryId,sourceRecords);
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
      const candidateInsights = snapshot.insights.filter(item=>item.userId===identity.accountId && item.status==='active' && item.allowProactiveMention===true &&
        !suppressed(snapshot.suppressions,identity.accountId,item.lineageKey,item.evidenceIds,textKey(item.text)))
        .sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)||b.confidence-a.confidence).slice(0,CANDIDATE_POOL_LIMIT);
      const candidates = [];
      const sourceCache = new Map([[source.memoryId,source]]);
      for (const [index,item] of candidateInsights.entries()) {
        const evidence = await validInsightEvidence(repo,identity,item,snapshot.evidence,{records:sourceRecords,sources:sourceCache});
        if (!evidence.length) continue;
        candidates.push({ref:'C'+(index+1),lineageKey:item.lineageKey,category:item.category,text:item.text,
          origin:item.origin,userConfirmed:Boolean(item.confirmedAt || item.correctionEvidenceId),
          conversationTendency:item.conversationTendency===true,distinctSourceCount:distinctTellingCount(evidence)});
      }
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
          const id = identity.accountId+'_'+lineageKey;
          const previous = await tx.get(TABLES.insights,id);
          const reclassified = previous && change.conversationTendency===true && previous.conversationTendency!==true;
          const replaces = change.action==='supersede' || reclassified;
          // A model can miss a candidate match; stable text keys must not turn
          // that into either confidence inflation or reversal of a correction.
          if (previous && change.action==='new' && textKey(previous.text)!==textKey(change.text)) continue;
          // A new model inference cannot overrule an explicit user correction or confirmation.
          if ((change.action!=='reinforce' || reclassified) && change.origin==='inferred' && (previous?.correctionEvidenceId || previous?.confirmedAt)) continue;
          touched.add(lineageKey);
          const reinforce = previous && !replaces;
          const allEvidenceIds = replaces ? [source.evidenceId] : [...new Set([...(previous?.evidenceIds || []),source.evidenceId])];
          const correctionEvidenceId = reinforce && previous.correctionEvidenceId;
          const evidenceIds = correctionEvidenceId ? [correctionEvidenceId,...allEvidenceIds.filter(id=>id!==correctionEvidenceId).slice(-19)] : allEvidenceIds.slice(-20);
          const conversationTendency = change.conversationTendency===true || (reinforce && previous.conversationTendency===true);
          await tx.set(TABLES.insights,id,{...(reinforce ? previous : {}),userId:identity.accountId,lineageKey,status:'active',category:reinforce?previous.category:change.category,
            text:reinforce?previous.text:change.text,origin:reinforce?previous.origin:change.origin,
            conversationTendency:Boolean(conversationTendency),
            projectScoped:change.projectScoped || Boolean(previous?.projectScoped),
            allowProactiveMention:change.allowProactiveMention && previous?.allowProactiveMention!==false,
            confidence:reinforce ? previous.confidence : change.confidence,evidenceIds,revision:(previous?.revision || 0)+1,updatedAt:new Date(now()).toISOString(),
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
