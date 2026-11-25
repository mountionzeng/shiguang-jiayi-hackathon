const {assertIdentityStillActive} = require('./aiGuard');

function preferenceSnapshot(account) {
  const value = account?.writingPreferences;
  return {text: typeof value?.text === 'string' ? value.text.slice(0, 500) : '',
    revision: Number.isSafeInteger(value?.revision) ? value.revision : 0};
}
async function writingPreferences(event, db, identity) {
  return db.runTransaction(async tx => {
    await assertIdentityStillActive(tx, identity);
    const ref = tx.collection('user_accounts').doc(identity.accountDocumentId);
    const current = preferenceSnapshot((await ref.get()).data);
    if (event.operation === 'get') return current;
    if (event.operation !== 'save' || typeof event.text !== 'string' || event.text.length > 500)
      throw new Error('WRITING_PREFERENCES_INVALID');
    if (event.revision !== current.revision) throw new Error('WRITING_PREFERENCES_CHANGED');
    const next = {text:event.text.trim(), revision:current.revision + 1};
    await ref.update({data:{writingPreferences:next}});
    return next;
  });
}
async function assertWritingPreferencesCurrent(db, identity, snapshot) {
  const latest = preferenceSnapshot((await db.collection('user_accounts').doc(identity.accountDocumentId).get()).data);
  if (JSON.stringify(latest) !== JSON.stringify(snapshot)) throw new Error('WRITING_PREFERENCES_CHANGED');
}
module.exports = {preferenceSnapshot, writingPreferences, assertWritingPreferencesCurrent};
