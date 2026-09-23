const crypto = require('node:crypto');
const digest = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const TABLES = { controls:'personal_memory_controls', insights:'personal_memory_insights', evidence:'personal_memory_evidence', suppressions:'personal_memory_suppressions', jobs:'personal_memory_jobs' };
function error(code) { return Object.assign(new Error(code), {code}); }
function createRepository(db) {
  function io(database) {
    return {
      async get(table, id) {
        try { return (await database.collection(table).doc(id).get()).data || null; }
        catch (err) {
          // Missing documents are normal. Missing collections/permissions/network are not.
          if (/DOCUMENT_NOT_FOUND|document (?:does not exist|not found)|\bdocument\.get:fail document with _id \S+ does not exist\b|\bdocument\.get:fail -1\b/i.test(String(err?.errMsg || err?.message || ''))) return null;
          throw err;
        }
      },
      async set(table, id, value) {
        const {_id, _openid, ...data} = value;
        await database.collection(table).doc(id).set({data});
      },
      async authorize(identity, requireConsent = false) {
        const account = await this.get('user_accounts', identity.accountDocumentId);
        const family = await this.get('families', identity.familyId);
        if (!account || account.status !== 'active' || account.wxOpenId !== identity.openid || account.accountId !== identity.accountId || account.primaryFamilyId !== identity.familyId || family?.ownerAccountId !== identity.accountId) throw error('IDENTITY_REVOKED');
        if (requireConsent && !(account.aiConsent?.version >= 1)) throw error('AI_CONSENT_REQUIRED');
      },
    };
  }
  const access = io(db);
  async function all(table, where) {
    const rows = [];
    for (let offset = 0; ; offset += 100) {
      const result = await db.collection(table).where(where).orderBy('_id','asc').skip(offset).limit(100).get();
      rows.push(...result.data);
      if (result.data.length < 100) return rows;
    }
  }
  return {
    ...access,
    transaction: fn => db.runTransaction(tx => fn(io(tx))),
    async snapshot(identity) {
      // Read the epoch first. Every mutation serializes through that document.
      const control = await access.get(TABLES.controls, identity.accountId) || {version:0,enabled:false};
      const where = {userId:identity.accountId};
      const [insights,evidence,suppressions] = await Promise.all([all(TABLES.insights,where),all(TABLES.evidence,where),all(TABLES.suppressions,where)]);
      return {control,insights,evidence,suppressions};
    },
    async sourceRecords(identity) {
      return Promise.all([all('memories',{familyId:identity.familyId}),all('family_members',{familyId:identity.familyId})]);
    },
    async source(identity, memoryId, records) {
      if (typeof memoryId !== 'string' || !/^[0-9A-Za-z_-]{1,160}$/.test(memoryId)) return null;
      const [memories,members] = records || await this.sourceRecords(identity);
      const memory = memories.find(m => (m.frontendContributionId || m.id || String(m._id || '').replace(identity.familyId+'_','')) === memoryId);
      const profiles = members.filter(m => !m.deletedAt && m.kind !== 'person');
      const owner = profiles.find(m => m.relation === '自己') || profiles.find(m => m.role === 'owner');
      if (!memory || memory.deletedAt || memory.scope !== 'personal' || !owner || memory.authorMemberId !== (owner.memberId || owner.id) || memory.sourcePolicyRequired || memory.sourceIds || memory.sourceSystem || memory.origin === 'import' || memory.segments?.some(segment=>segment.source==='import')) return null;
      let text = memory.text;
      if (memory.aiRevisions !== undefined) {
        if (!Array.isArray(memory.aiRevisions) || !memory.aiRevisions.length || memory.aiRevisions[0]?.kind !== 'spoken' || typeof memory.aiRevisions[0].text !== 'string') return null;
        // Never learn from AI-generated prose; only the saved, original speech.
        text = memory.aiRevisions[0].text;
      } else if (memory.organizationMode === 'cloud-ai') return null;
      if (typeof text !== 'string' || !text.trim() || text.length > 4000) return null;
      const fingerprint = digest(text.trim());
      return {memoryId,sourceDocId:memory._id,text:text.trim(),fingerprint,
        evidenceId:digest(identity.accountId+'|'+memoryId+'|'+fingerprint),occurredOn:String(memory.createdAt || '').slice(0,10) || null};
    },
  };
}
async function assertEpoch(tx, identity, snapshot, requireConsent = false) {
  await tx.authorize(identity, requireConsent);
  const control = await tx.get(TABLES.controls, identity.accountId) || {version:0,enabled:false};
  if (control.version !== snapshot.control.version) throw error('PERSONAL_MEMORY_CHANGED');
  return control;
}
async function bumpEpoch(tx, identity, control, patch = {}) {
  await tx.set(TABLES.controls, identity.accountId, {...control,...patch,userId:identity.accountId,version:control.version+1});
}
module.exports = {TABLES, digest, error, createRepository, assertEpoch, bumpEpoch};
