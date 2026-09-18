const crypto = require('node:crypto');

const PRINCIPAL_ID = /^principal_[0-9a-f]{32}$/;
const FAMILY_ID = /^family_[0-9A-Za-z_-]{1,120}$/;
const ACCOUNT_ID = /^account_[0-9a-f]{24}$/;
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const aliasIdFor = (appId, openid) => hash(JSON.stringify([appId, openid]));

function identityError(code = 'STORY_FORBIDDEN') {
  const messages = {
    AUTH_REQUIRED: '请重新登录',
    IDENTITY_UNLINKED: '故事身份尚未关联，请从原账号进入或完成身份核验',
    STORY_FORBIDDEN: '这份故事当前不可访问',
  };
  return Object.assign(new Error(messages[code]), { code });
}

async function identityFromAlias(reader, aliasId, appId) {
  const alias = await reader.get('story_identity_aliases', aliasId);
  if (!alias || alias.status !== 'active' || alias.appId !== appId || !PRINCIPAL_ID.test(alias.principalId)) throw identityError();
  const principal = await reader.get('story_principals', alias.principalId);
  if (!principal || principal.status !== 'active' || !FAMILY_ID.test(principal.familyId) || !ACCOUNT_ID.test(principal.accountId)) throw identityError();
  const space = await reader.get('story_principal_spaces', principal.familyId);
  if (!space || space.status !== 'active' || space.principalId !== alias.principalId || space.accountId !== principal.accountId) throw identityError();
  return { principalId: alias.principalId, accountId: principal.accountId, familyId: principal.familyId, aliasId, appId };
}

// Context comes from getWXContext, never request data. This only bootstraps the
// configured original app. Cross-app linking is a separate, verified operation.
async function resolveStoryIdentity(repo, context, { bootstrapAppId } = {}) {
  const appId = context?.APPID;
  const openid = context?.OPENID;
  if (typeof appId !== 'string' || !/^wx[0-9A-Za-z_-]{1,80}$/.test(appId) ||
      typeof openid !== 'string' || !/^[0-9A-Za-z_-]{1,128}$/.test(openid)) throw identityError('AUTH_REQUIRED');
  const aliasId = aliasIdFor(appId, openid);
  return repo.transaction(async tx => {
    const alias = await tx.get('story_identity_aliases', aliasId);
    if (alias) return identityFromAlias(tx, aliasId, appId);
    if (!bootstrapAppId || appId !== bootstrapAppId) throw identityError('IDENTITY_UNLINKED');
    const accountDocumentId = `account_${hash(openid).slice(0, 24)}`;
    const account = await tx.get('user_accounts', accountDocumentId);
    if (!account || account.status !== 'active' || account.wxOpenId !== openid ||
        !ACCOUNT_ID.test(account.accountId) || !FAMILY_ID.test(account.primaryFamilyId)) throw identityError('IDENTITY_UNLINKED');
    const familyId = account.primaryFamilyId;
    const family = await tx.get('families', familyId);
    if (!family || family.ownerAccountId !== account.accountId || family._openid !== openid) throw identityError('IDENTITY_UNLINKED');
    // A missing alias is not permission to claim a previously bound space, even
    // if an operator changes the configured bootstrap app after a migration.
    if (await tx.get('story_principal_spaces', familyId)) throw identityError('IDENTITY_UNLINKED');
    const principalId = `principal_${crypto.randomBytes(16).toString('hex')}`;
    const createdAt = new Date().toISOString();
    await tx.set('story_principals', principalId, { status: 'active', accountId: account.accountId, familyId, createdAt });
    await tx.set('story_principal_spaces', familyId, { status: 'active', principalId, accountId: account.accountId, createdAt });
    await tx.set('story_identity_aliases', aliasId, { status: 'active', appId, principalId, createdAt });
    return { principalId, accountId: account.accountId, familyId, aliasId, appId };
  });
}

async function assertCurrentIdentity(reader, ctx) {
  if (!ctx || typeof ctx.aliasId !== 'string' || !/^[0-9a-f]{64}$/.test(ctx.aliasId)) throw identityError();
  const current = await identityFromAlias(reader, ctx.aliasId, ctx.appId);
  if (current.principalId !== ctx.principalId || current.familyId !== ctx.familyId || current.accountId !== ctx.accountId) throw identityError();
  return current;
}

async function assertSpaceOwner(reader, ctx) {
  await assertCurrentIdentity(reader, ctx);
  const family = await reader.get('families', ctx.familyId);
  if (!family || family.ownerAccountId !== ctx.accountId) throw identityError();
}

module.exports = { PRINCIPAL_ID, FAMILY_ID, aliasIdFor, resolveStoryIdentity, assertCurrentIdentity, assertSpaceOwner, identityError };
