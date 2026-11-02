const { createHash } = require('node:crypto');

// Read only the authenticated caller's saved mini-program profile. Event fields
// are deliberately absent: a caller cannot supply another account or nickname.
async function loginDisplayName(db, context) {
  const openid = context?.OPENID;
  if (typeof openid !== 'string' || !/^[0-9A-Za-z_-]{1,128}$/.test(openid)) return undefined;
  const id = 'account_' + createHash('sha256').update(openid).digest('hex').slice(0, 24);
  const result = await db.collection('user_accounts').doc(id).get();
  const account = result?.data;
  if (account?.wxOpenId !== openid || account.status !== 'active') return undefined;
  const name = typeof account.displayName === 'string' ? account.displayName.trim() : '';
  return name && Array.from(name).length <= 8 ? name : undefined;
}
module.exports = { loginDisplayName };
