const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./helpers/story-access-fixture');
const { resolveStoryIdentity, assertCurrentIdentity, aliasIdFor } = require('../cloudfunctions/storyBooks/identity');
const options = { bootstrapAppId: 'wx-original' };

test('concurrent identity bootstrap is stable and leaves account, balance and family untouched', async () => {
  const { repo, tables, account } = fixture();
  const { accountId } = account('owner', 'family_original');
  const original = structuredClone(tables);
  const context = { APPID: 'wx-original', OPENID: 'owner' };
  const identities = await Promise.all(Array.from({ length: 5 }, () => resolveStoryIdentity(repo, context, options)));
  assert.equal(new Set(identities.map(row => row.principalId)).size, 1);
  assert.match(identities[0].principalId, /^principal_[0-9a-f]{32}$/);
  assert.equal(identities[0].familyId, 'family_original');
  assert.equal(identities[0].accountId, accountId);
  for (const [key, value] of original) assert.deepEqual(tables.get(key), value);
  assert.equal([...tables.keys()].filter(key => key.startsWith('story_principals:')).length, 1);
});

test('same openid from another app and changed bootstrap configuration never auto-claim old space', async () => {
  const { repo, account } = fixture(); account('owner');
  await resolveStoryIdentity(repo, { APPID: 'wx-original', OPENID: 'owner' }, options);
  for (const bootstrapAppId of ['wx-original', 'wx-new']) {
    await assert.rejects(resolveStoryIdentity(repo, { APPID: 'wx-new', OPENID: 'owner' }, { bootstrapAppId }), { code: 'IDENTITY_UNLINKED' });
  }
  assert.notEqual(aliasIdFor('wx-original', 'owner'), aliasIdFor('wx-new', 'owner'));
});

test('only a preverified server-side alias can reuse a stable principal after account migration', async () => {
  const { repo, tables, account } = fixture(); account('owner');
  const first = await resolveStoryIdentity(repo, { APPID: 'wx-original', OPENID: 'owner' }, options);
  const aliasId = aliasIdFor('wx-new', 'new-owner');
  tables.set(`story_identity_aliases:${aliasId}`, { principalId: first.principalId, status: 'active', appId: 'wx-new' });
  const migrated = await resolveStoryIdentity(repo, { APPID: 'wx-new', OPENID: 'new-owner' }, options);
  assert.equal(migrated.principalId, first.principalId);
  assert.equal(migrated.familyId, first.familyId);
  tables.get(`story_identity_aliases:${aliasId}`).status = 'revoked';
  await assert.rejects(assertCurrentIdentity(repo, migrated), { code: 'STORY_FORBIDDEN' });
  await assert.rejects(resolveStoryIdentity(repo, { APPID: 'wx-new', OPENID: 'new-owner' }, options), { code: 'STORY_FORBIDDEN' });
});

test('bootstrap fails closed for missing identity, missing account, wrong ownership and storage failure', async () => {
  const { repo, tables, account } = fixture(); account('owner');
  await assert.rejects(resolveStoryIdentity(repo, { OPENID: 'owner' }, options), { code: 'AUTH_REQUIRED' });
  await assert.rejects(resolveStoryIdentity(repo, { APPID: 'wx-original', OPENID: 'absent' }, options), { code: 'IDENTITY_UNLINKED' });
  tables.get('families:family_owner').ownerAccountId = 'account_other';
  await assert.rejects(resolveStoryIdentity(repo, { APPID: 'wx-original', OPENID: 'owner' }, options), { code: 'IDENTITY_UNLINKED' });
  assert.equal([...tables.keys()].filter(key => key.startsWith('story_')).length, 0);
  await assert.rejects(resolveStoryIdentity({ transaction: async () => { throw new Error('storage down'); } }, { APPID: 'wx-original', OPENID: 'owner' }, options), /storage down/);
});

test('legacy metadata cannot claim a space whose platform-owned author differs', async () => {
  const { repo, tables, account } = fixture(); account('owner');
  tables.get('families:family_owner')._openid = 'someone-else';
  await assert.rejects(resolveStoryIdentity(repo, { APPID: 'wx-original', OPENID: 'owner' }, options), { code: 'IDENTITY_UNLINKED' });
  assert.equal([...tables.keys()].filter(key => key.startsWith('story_')).length, 0);
});

test('first login provisions an empty canonical family before binding the story identity', async () => {
  const {repo,tables,account}=fixture(); const owner=account('new-user');
  tables.delete(`families:${owner.familyId}`);
  const identities=await Promise.all([1,2,3].map(()=>resolveStoryIdentity(repo,{APPID:'wx-original',OPENID:'new-user'},options)));
  assert.equal(new Set(identities.map(x=>x.principalId)).size,1);
  const family=tables.get(`families:${owner.familyId}`);
  assert.equal(family.ownerAccountId,owner.accountId);
  assert.equal(family._openid,'new-user');
  assert.equal(family.storyBooks.status,'active');
  assert.equal(tables.get(`user_accounts:${owner.accountId}`).computeBalanceMicros,321);
});

test('first login cannot recreate a migrated or previously bound missing family', async () => {
  for(const scenario of ['migrated','bound']) {
    const {repo,tables,account}=fixture(); const owner=account('new-user',scenario==='migrated'?'family_other':'family_new-user');
    tables.delete(`families:${owner.familyId}`);
    if(scenario==='bound')tables.set(`story_principal_spaces:${owner.familyId}`,{status:'revoked'});
    await assert.rejects(resolveStoryIdentity(repo,{APPID:'wx-original',OPENID:'new-user'},options),{code:'IDENTITY_UNLINKED'});
    assert.equal(tables.has(`families:${owner.familyId}`),false);
  }
});

test('a newly registered account can load the home and create a first story through the protected service',async()=>{
  const {createStoryService}=require('../cloudfunctions/storyBooks/service');
  const {repo,tables,account}=fixture();const owner=account('first-story');
  tables.delete(`families:${owner.familyId}`);
  const service=createStoryService(repo,{accessEnabled:true,rulesReady:true,bootstrapAppId:'wx-original'});
  const context={APPID:'wx-original',OPENID:'first-story'};
  const home=await service(context,{action:'state',view:'home'});
  assert.equal(home.roomStateVersion,1);assert.deepEqual(home.stories,[]);
  assert.equal(home.storyMigration.status,'active');
  await service(context,{action:'create',storyId:'story-first-book',title:'虚构第一篇',writingMode:'objective',memoryIds:[],requestId:'create-first-book'});
  const reopened=await service(context,{action:'state',view:'home'});
  assert.equal(reopened.stories.length,1);assert.equal(reopened.stories[0].title,'虚构第一篇');
});
