const crypto = require('node:crypto');
const {assertIdentityStillActive, assertConsentVersion, AI_CONSENT_VERSION} = require('./aiGuard');
const {validateArticleWriting} = require('./articleWriting');
const COLLECTION = 'article_chat_turns';
const initialized = new WeakSet();
const missing = error => /DOCUMENT_NOT_FOUND|document (?:does not exist|not found)|document\.get:fail -1|document\.get:fail document with _id .* does not exist/i.test(String(error?.message || error?.errMsg));
async function read(db, id) {
  try { return (await db.collection(COLLECTION).doc(id).get()).data; }
  catch(error) { if (!missing(error)) throw error; }
}
function inputSnapshot(value) {
  if (!value || typeof value !== 'object') throw new Error('ARTICLE_TURN_INVALID');
  const text = (v, max) => {if(typeof v !== 'string' || v.length > max) throw new Error('ARTICLE_TURN_INVALID'); return v;};
  const answer = text(value.answer,value.articleWriting === undefined ? 500 : 20000).trim();
  if (!answer || !Array.isArray(value.conversation) || value.conversation.length > 200) throw new Error('ARTICLE_TURN_INVALID');
  const sourceText = text(value.sourceText,40000);
  const conversation = value.conversation.map(t => {
      if (!t || !['user','assistant'].includes(t.role)) throw new Error('ARTICLE_TURN_INVALID');
      return {role:t.role,text:text(t.text,value.articleWriting === undefined ? 5000 : 20000)};
  });
  if (value.articleWriting !== undefined && conversation.reduce((length, turn) => length + turn.text.length, 0) > 40000) {
    throw new Error('ARTICLE_TURN_INVALID');
  }
  return {answer,sourceText,scope:text(value.scope,500),storyTitle:text(value.storyTitle,200),
    conversation, ...(value.articleWriting === undefined ? {} : {articleWriting:validateArticleWriting(value.articleWriting,sourceText)})};
}
/** Claim once before inference. Lost receipts and concurrent retries never re-run the model. */
async function articleTurn(event, db, identity, generate) {
  if (typeof event.turnId !== 'string' || !/^article-[a-z0-9-]{8,100}$/.test(event.turnId)) throw new Error('ARTICLE_TURN_INVALID');
  const input = inputSnapshot(event.input);
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex');
  const id = crypto.createHash('sha256').update(JSON.stringify([identity.accountId,identity.familyId,event.turnId])).digest('hex');
  if (!initialized.has(db) && db.createCollection) {
    try {await db.createCollection(COLLECTION);} catch(error) {
      if (!/already exists|ResourceExist|COLLECTION_(ALREADY_)?EXIST|Table (?:already )?exist/i.test(String(error?.message || error?.errMsg))) throw error;
    }
    initialized.add(db);
  }
  const receipt = row => ({turnId:event.turnId,status:row.status,...(row.status==='ready'
    ? {reply:row.reply,...(row.decision ? {decision:row.decision} : {})} : {})});
  const claimed = await db.runTransaction(async tx => {
    await assertIdentityStillActive(tx,identity);
    const row = await read(tx,id);
    if (row) {
      if (row.accountId !== identity.accountId || row.familyId !== identity.familyId || row.fingerprint !== fingerprint) throw new Error('ARTICLE_TURN_CONFLICT');
      return {existing:receipt(row)};
    }
    assertConsentVersion(identity.account,AI_CONSENT_VERSION);
    await tx.collection(COLLECTION).doc(id).set({data:{accountId:identity.accountId,familyId:identity.familyId,
      fingerprint,status:'sending',createdAtMs:Date.now()}});
    return {};
  });
  if (claimed.existing) return claimed.existing;
  let result;
  try {
    result = await generate({...input,mode:'personal',memoryType:'memoir',sourceOnly:true});
  } catch (error) {
    // Even a rejected/unknown provider call must not be automatically purchased twice.
    await db.collection(COLLECTION).doc(id).update({data:{status:'failed'}});
    throw error;
  }
  await db.runTransaction(async tx => {
    await assertIdentityStillActive(tx,identity);
    await tx.collection(COLLECTION).doc(id).update({data:{status:'ready',reply:result.text,...(result.decision ? {decision:result.decision} : {})}});
  });
  return receipt({status:'ready',reply:result.text,decision:result.decision});
}
module.exports = {articleTurn,inputSnapshot};
