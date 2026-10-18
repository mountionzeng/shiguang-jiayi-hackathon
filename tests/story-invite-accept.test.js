const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./helpers/story-access-fixture');
const { createStoryService } = require('../cloudfunctions/storyBooks/service');
const core = require('../cloudfunctions/storyBooks/core');

/*
 * 一键邀请：朋友点开链接就成为家人，不再填称呼、不再输核对码。
 * 安全边界：链接只认第一个点开的微信；主人随时撤销；灰度名单只管发邀请的主人，
 * 受邀者只凭一份有效邀请通行，且只能做「看邀请、接受邀请」两件事。
 */
async function setup(extra = {}) {
  const f = fixture();
  f.account('owner'); f.account('friend'); f.account('other');
  // 朋友的家庭不在灰度名单里：这正是新朋友的真实处境。
  const options = {
    accessEnabled: true, rulesReady: true, invitationsEnabled: true, copyReceiveEnabled: true, sharedEditEnabled: true,
    bootstrapAppId: 'wx-original', sharedReadFamilyIds: ['family_owner'], ...extra,
  };
  const service = createStoryService(f.repo, options);
  const call = (who, action, input = {}) => service({ APPID: 'wx-original', OPENID: who }, { action, ...input });
  await call('owner', 'create', { storyId: 'story-a', title: '外婆家的夏天', writingMode: 'objective', memoryIds: [], requestId: 'create-story-a' });
  f.tables.get('stories:family_owner_story-a').currentRevisionId = 'revision-a';
  const chapters = [
    { id: 'chapter-one', title: '不公开', memoryIds: [], content: [{ text: '没有分享的秘密' }] },
    { id: 'chapter-three', title: '井水西瓜', memoryIds: [], content: [{ text: '井水里的西瓜很凉。' }] },
  ];
  f.tables.set('biography_drafts:family_owner_revision-a', { familyId: 'family_owner', storyId: 'story-a', revision: { id: 'revision-a', storyId: 'story-a', draft: {
    title: '外婆家的夏天', chapters, ...core.flatten(chapters), sourceCount: 0, generatedAt: '', generationMode: 'local-demo',
  } } });
  const invite = (input = {}) => call('owner', 'inviteCreate', {
    familyId: 'family_owner', storyId: 'story-a', chapterIds: ['chapter-three'], inviteeName: '小岚',
    permissions: { read: true, forward: false, edit: false, copy: true }, ...input,
  });
  return { ...f, call, invite, options, service };
}

test('朋友点开邀请就成为家人：没有核对码，称呼沿用主人给的名字，只读到被分享的章节', async () => {
  const f = await setup();
  const inv = await f.invite();
  const seen = await f.call('friend', 'inviteGet', { token: inv.token });
  assert.equal(seen.inviteeName, '小岚', '朋友第一眼看到主人起的称呼');
  assert.equal(seen.status, 'unrequested');

  const accepted = await f.call('friend', 'inviteAccept', { token: inv.token });
  assert.equal(accepted.status, 'approved');
  assert.equal(accepted.familyId, 'family_owner');
  assert.equal(accepted.storyId, 'story-a');
  assert.equal(accepted.displayName, '小岚');

  const read = await f.call('friend', 'sharedRead', { familyId: 'family_owner', storyId: 'story-a' });
  assert.deepEqual(read.chapters.map(c => c.id), ['chapter-three']);
  assert.equal(JSON.stringify(read).includes('没有分享的秘密'), false);
});

test('重复点开是同一个人，幂等；第二个微信不能再绑定同一份邀请', async () => {
  const f = await setup();
  const inv = await f.invite();
  const first = await f.call('friend', 'inviteAccept', { token: inv.token });
  const again = await f.call('friend', 'inviteAccept', { token: inv.token });
  assert.deepEqual(again, first);
  await assert.rejects(f.call('other', 'inviteAccept', { token: inv.token }), { code: 'STORY_FORBIDDEN' });
  await assert.rejects(f.call('other', 'sharedRead', { familyId: 'family_owner', storyId: 'story-a' }), { code: 'STORY_ACCESS_DISABLED' });
});

test('撤销后立即失效：已接受的朋友读不到，没接受的人也点不开', async () => {
  const f = await setup();
  const accepted = await f.invite(), pending = await f.invite({ chapterIds: ['chapter-one'], inviteeName: '阿远' });
  await f.call('friend', 'inviteAccept', { token: accepted.token });
  await f.call('owner', 'inviteRevoke', { familyId: 'family_owner', storyId: 'story-a', invitationId: accepted.invitationId });
  await assert.rejects(f.call('friend', 'sharedRead', { familyId: 'family_owner', storyId: 'story-a' }), { code: 'STORY_FORBIDDEN' });
  await f.call('owner', 'inviteRevoke', { familyId: 'family_owner', storyId: 'story-a', invitationId: pending.invitationId });
  await assert.rejects(f.call('other', 'inviteAccept', { token: pending.token }), { code: 'STORY_FORBIDDEN' });
});

test('过期的邀请不能接受', async () => {
  let clock = 1_000_000;
  const f = await setup({ now: () => clock });
  const inv = await f.invite();
  clock += 25 * 60 * 60 * 1000;
  await assert.rejects(f.call('friend', 'inviteAccept', { token: inv.token }), { code: 'STORY_FORBIDDEN' });
});

test('接纳只通过灰度检查，不授予主人才有的能力', async () => {
  const f = await setup();
  const inv = await f.invite();
  await f.call('friend', 'inviteAccept', { token: inv.token });
  // 朋友不能管理邀请，也不能凭此发邀请（没有「再邀请」授权）。
  await assert.rejects(f.call('friend', 'inviteManage', { familyId: 'family_owner', storyId: 'story-a' }), { code: 'STORY_FORBIDDEN' });
  await assert.rejects(f.call('friend', 'inviteCreate', { familyId: 'family_owner', storyId: 'story-a', chapterIds: ['chapter-three'], permissions: { read: true } }), { code: 'STORY_FORBIDDEN' });
  // 朋友自己的空间里没有人回信给他。
  assert.deepEqual((await f.call('friend', 'copyReturns')).returns, []);
  // 朋友读不到邀请范围之外的章节。
  await assert.rejects(f.call('friend', 'sharedRead', { familyId: 'family_owner', storyId: 'story-a', chapterIds: ['chapter-one'] }), { code: 'STORY_FORBIDDEN' });
  // 没有被接纳的第三方，连这些动作的大门都进不去。
  await assert.rejects(f.call('other', 'copyReturns'), { code: 'STORY_ACCESS_DISABLED' });
});

test('主人不在名单里时，没人能发邀请，朋友也点不开', async () => {
  const f = await setup({ sharedReadFamilyIds: [] });
  await assert.rejects(f.invite(), { code: 'STORY_ACCESS_DISABLED' });
});

test('没有邀请的陌生人拿不到任何东西；伪造的 token 一律拒绝', async () => {
  const f = await setup();
  await f.invite();
  await assert.rejects(f.call('other', 'inviteAccept', { token: 'f'.repeat(48) }), { code: 'STORY_FORBIDDEN' });
  await assert.rejects(f.call('other', 'inviteAccept', { token: 'not-a-token' }), { code: 'STORY_FORBIDDEN' });
  await assert.rejects(f.call('other', 'sharedRead', { familyId: 'family_owner', storyId: 'story-a' }), { code: 'STORY_ACCESS_DISABLED' });
});

test('主人自己不能接受自己的邀请', async () => {
  const f = await setup();
  const inv = await f.invite();
  await assert.rejects(f.call('owner', 'inviteAccept', { token: inv.token }), { code: 'STORY_FORBIDDEN' });
});

test('称呼缺失时退回邀请里的「亲友」，不抛错；超长或带控制字符的称呼被拒绝', async () => {
  const f = await setup();
  const unnamed = await f.invite({ inviteeName: undefined });
  const accepted = await f.call('friend', 'inviteAccept', { token: unnamed.token });
  assert.equal(accepted.displayName, '亲友');
  await assert.rejects(f.invite({ inviteeName: '字'.repeat(31) }), { code: 'STORY_FORBIDDEN' });
  await assert.rejects(f.invite({ inviteeName: '小\u202e岚' }), { code: 'STORY_FORBIDDEN' });
});

test('接受后得到的是章节授权，权限由邀请决定，朋友自己不能放大', async () => {
  const f = await setup();
  const inv = await f.invite({ permissions: { read: true, forward: false, edit: false, copy: false } });
  await f.call('friend', 'inviteAccept', { token: inv.token });
  const read = await f.call('friend', 'sharedRead', { familyId: 'family_owner', storyId: 'story-a' });
  assert.equal(read.capabilities.copy, false);
  assert.equal(read.capabilities.sharedEdit, false);
});

async function joined(f, input = {}) {
  const inv = await f.invite(input);
  await f.call('friend', 'inviteAccept', { token: inv.token });
  return inv;
}
const access = (inv, extra = {}) => ({ familyId: 'family_owner', storyId: 'story-a', invitationId: inv.invitationId, ...extra });

test('主人的管理页能看到每位家人当前生效的章节和权限', async () => {
  const f = await setup();
  const inv = await joined(f);
  const managed = await f.call('owner', 'inviteManage', { familyId: 'family_owner', storyId: 'story-a' });
  const member = managed.invitations.find(item => item.invitationId === inv.invitationId).member;
  assert.equal(member.name, '小岚');
  assert.equal(member.active, true);
  assert.deepEqual(member.chapterIds, ['chapter-three']);
  assert.equal(member.permissions.copy, true);
});

test('主人改权限立刻生效：关掉收入，朋友就不能再收；打开改写，朋友才能改', async () => {
  const f = await setup();
  const inv = await joined(f);
  let read = await f.call('friend', 'sharedRead', { familyId: 'family_owner', storyId: 'story-a' });
  assert.equal(read.capabilities.copy, true);
  assert.equal(read.capabilities.sharedEdit, false);

  await f.call('owner', 'inviteSetAccess', access(inv, { permissions: { read: true, copy: false, edit: true } }));
  read = await f.call('friend', 'sharedRead', { familyId: 'family_owner', storyId: 'story-a' });
  assert.equal(read.capabilities.copy, false);
  assert.equal(read.capabilities.sharedEdit, true);

  const grant = [...f.tables].find(([key]) => key.startsWith('story_grants:'))[1];
  assert.equal(grant.version, 2, '每次调整授权版本号加一');
  assert.equal(grant.permissions.forward, false);
  assert.equal(grant.permissions.publish, false);
});

test('主人可以收窄到更少的章节，但不能选择不存在的章节', async () => {
  const f = await setup();
  const inv = await joined(f, { chapterIds: ['chapter-one', 'chapter-three'] });
  await f.call('owner', 'inviteSetAccess', access(inv, { chapterIds: ['chapter-three'], permissions: { read: true, copy: false, edit: false } }));
  const read = await f.call('friend', 'sharedRead', { familyId: 'family_owner', storyId: 'story-a' });
  assert.deepEqual(read.chapters.map(c => c.id), ['chapter-three']);
  await assert.rejects(f.call('owner', 'inviteSetAccess', access(inv, { chapterIds: ['chapter-two'], permissions: { read: true } })), { code: 'STORY_FORBIDDEN' });
});

test('人物管理按编号关联：已有资料可以邀请，改名不重复建人，接受前没有权限', async () => {
  const f=await setup({sharedEditEnabled:false});
  addMember(f,'小岚','同学');
  const inv=await f.invite({targetMemberId:'member-manual',inviteeName:'伪造称呼'});
  assert.equal((await f.call('friend','inviteGet',{token:inv.token})).inviteeName,'小岚');
  assert.equal([...f.tables].some(([key])=>key.startsWith('story_grants:')),false);
  await f.call('owner','memberUpdate',{memberId:'member-manual',name:'岚姐',relation:'朋友'});
  await f.call('friend','inviteAccept',{token:inv.token});
  const people=[...f.tables].filter(([key])=>key.startsWith('family_members:family_owner_'));
  assert.equal(people.length,1);assert.equal(people[0][1].name,'岚姐');
  assert.equal(people[0][1].accountId,[...f.tables].find(([key,row])=>key.startsWith('user_accounts:') && row.wxOpenId==='friend')[1].accountId);
  const managed=await f.call('owner','inviteManage',{storyId:'story-a',includePeople:true});
  assert.equal(managed.bookPeople,true);assert.equal(managed.people[0].id,'member-manual');
  assert.equal(managed.people[0].name,'岚姐');assert.equal(managed.invitations[0].memberId,'member-manual');
  assert.equal(JSON.stringify(managed).includes('井水里的西瓜很凉'),false);
  const read=await f.call('friend','sharedRead',{familyId:'family_owner',storyId:'story-a'});
  assert.deepEqual(read.chapters.map(ch=>ch.id),['chapter-three']);assert.equal(read.capabilities.sharedEdit,false);
});

test('已绑定人物撤销后再邀请仍只认本人，另一微信不能抢绑，也不能走旧审批绕过', async () => {
  const f=await setup({sharedReadFamilyIds:['family_owner','family_other']});addMember(f,'小岚');
  const first=await f.invite({targetMemberId:'member-manual'});
  await f.call('friend','inviteAccept',{token:first.token});
  await f.call('owner','inviteRevoke',access(first));
  const next=await f.invite({targetMemberId:'member-manual'});
  await assert.rejects(f.call('other','inviteAccept',{token:next.token}),{code:'STORY_FORBIDDEN'});
  await assert.rejects(f.call('other','inviteApply',{token:next.token,displayName:'小岚'}),{code:'STORY_FORBIDDEN'});
  assert.equal((await f.call('friend','inviteAccept',{token:next.token})).status,'approved');
  assert.equal([...f.tables].filter(([key])=>key.startsWith('family_members:family_owner_')).length,1);
});

test('人物关联拒绝别家、已删除、主笔及未知编号，发邀请者不能凭名字替代编号', async () => {
  const f=await setup();addMember(f,'小岚');
  await assert.rejects(f.invite(),{code:'STORY_INVITEE_EXISTS'});
  for(const memberId of ['missing','../member-manual'])await assert.rejects(f.invite({targetMemberId:memberId}),{code:'STORY_FORBIDDEN'});
  const target=f.tables.get('family_members:family_owner_member-manual');
  for(const patch of [{familyId:'family_other'},{deletedAt:'2026-10-18'},{role:'owner'}]){
    f.tables.set('family_members:family_owner_member-manual',{...target,...patch});
    await assert.rejects(f.invite({targetMemberId:'member-manual'}),{code:'STORY_FORBIDDEN'});
  }
});

test('同一人物改名后仍不能重复邀请；同一人物在另一书中由已绑定的微信接受', async () => {
  const f=await setup();addMember(f,'小岚');
  const first=await f.invite({targetMemberId:'member-manual'});
  await f.call('owner','memberUpdate',{memberId:'member-manual',name:'岚姐',relation:'朋友'});
  await assert.rejects(f.invite({targetMemberId:'member-manual'}),{code:'STORY_INVITEE_EXISTS'});
  await f.call('friend','inviteAccept',{token:first.token});
  const story=structuredClone(f.tables.get('stories:family_owner_story-a'));story.id='story-b';story.currentRevisionId='revision-b';
  f.tables.set('stories:family_owner_story-b',story);
  const revision=structuredClone(f.tables.get('biography_drafts:family_owner_revision-a'));
  revision.storyId='story-b';revision.revision.storyId='story-b';revision.revision.id='revision-b';
  f.tables.set('biography_drafts:family_owner_revision-b',revision);
  const next=await f.invite({storyId:'story-b',targetMemberId:'member-manual'});
  await assert.rejects(f.call('other','inviteAccept',{token:next.token}),{code:'STORY_FORBIDDEN'});
  await f.call('friend','inviteAccept',{token:next.token});
  assert.equal([...f.tables].filter(([key])=>key.startsWith('family_members:family_owner_')).length,1);
  assert.equal([...f.tables].filter(([key,row])=>key.startsWith('story_grants:') && row.status==='active').length,2);
});

test('管理页不把另一份邀请的有效授权显示成这份邀请的权限',async()=>{
  const f=await setup();const inv=await joined(f);
  const grant=[...f.tables].find(([key])=>key.startsWith('story_grants:'));
  f.tables.set(grant[0],{...grant[1],invitationId:'f'.repeat(64)});
  const managed=await f.call('owner','inviteManage',{familyId:'family_owner',storyId:'story-a'});
  assert.equal(managed.invitations[0].member.active,false);assert.deepEqual(managed.invitations[0].member.chapterIds,[]);
  await assert.rejects(f.call('owner','inviteSetAccess',access(inv,{permissions:{read:true}})),{code:'STORY_FORBIDDEN'});
});

test('一本书的人物只来自本书素材、主角和邀请；没有章节时仍能查看资料', async () => {
  const f=await setup();addMember(f,'小岚');addMember(f,'其他书的人','朋友','unrelated');
  const story=f.tables.get('stories:family_owner_story-a');story.memoryIds=['memory-one'];story.currentRevisionId='';
  f.tables.set('memories:family_owner_memory-one',{familyId:'family_owner',relatedMemberIds:['member-manual'],text:'不返回的素材正文'});
  const managed=await f.call('owner','inviteManage',{storyId:'story-a',includePeople:true,familyId:'family_other'});
  assert.equal(managed.familyId,'family_owner');assert.deepEqual(managed.people.map(p=>p.id),['member-manual']);
  assert.deepEqual(managed.chapters,[]);assert.equal(JSON.stringify(managed).includes('素材正文'),false);
  await assert.rejects(f.invite({targetMemberId:'member-manual'}),{code:'STORY_FORBIDDEN'});
  await assert.rejects(f.call('friend','inviteManage',{storyId:'story-a',includePeople:true}),{code:'STORY_ACCESS_DISABLED'});
});

test('接受后主人可明确改选当前章节；未选择的章节不自动开放，越权和无效章节仍拒绝', async () => {
  const f=await setup({sharedEditEnabled:false});const inv=await joined(f);
  await f.call('owner','inviteSetAccess',access(inv,{chapterIds:['chapter-one'],permissions:{read:true,copy:false,edit:false}}));
  const read=await f.call('friend','sharedRead',{familyId:'family_owner',storyId:'story-a'});
  assert.deepEqual(read.chapters.map(ch=>ch.id),['chapter-one']);assert.equal(read.capabilities.copy,false);
  await assert.rejects(f.call('friend','sharedRead',{familyId:'family_owner',storyId:'story-a',chapterIds:['chapter-three']}),{code:'STORY_FORBIDDEN'});
  await assert.rejects(f.call('owner','inviteSetAccess',access(inv,{chapterIds:['chapter-missing'],permissions:{read:true}})),{code:'STORY_FORBIDDEN'});
  await assert.rejects(f.call('owner','inviteSetAccess',access(inv,{chapterIds:['chapter-three'],permissions:{read:true,edit:true}})),{code:'STORY_ACCESS_NOT_READY'});
  await assert.rejects(f.call('friend','inviteSetAccess',access(inv,{chapterIds:['chapter-three'],permissions:{read:true}})),{code:'STORY_FORBIDDEN'});
});

test('只有主人能改权限；朋友不能改自己的，也不能改别人的', async () => {
  const f = await setup();
  const inv = await joined(f);
  await assert.rejects(f.call('friend', 'inviteSetAccess', access(inv, { permissions: { read: true, copy: true, edit: true } })), { code: 'STORY_FORBIDDEN' });
  await assert.rejects(f.call('other', 'inviteSetAccess', access(inv, { permissions: { read: true, edit: true } })), { code: 'STORY_ACCESS_DISABLED' });
});

test('改权限不能越过服务端开关，也不能夹带转发或发布', async () => {
  const f = await setup({ sharedEditEnabled: false });
  const inv = await joined(f);
  await assert.rejects(f.call('owner', 'inviteSetAccess', access(inv, { permissions: { read: true, edit: true } })), { code: 'STORY_ACCESS_NOT_READY' });
  await assert.rejects(f.call('owner', 'inviteSetAccess', access(inv, { permissions: { read: true, publish: true } })), { code: 'STORY_FORBIDDEN' });
  await assert.rejects(f.call('owner', 'inviteSetAccess', access(inv, { permissions: { read: true, forward: true } })), { code: 'STORY_FORBIDDEN' });
  await assert.rejects(f.call('owner', 'inviteSetAccess', access(inv, { permissions: { read: false } })), { code: 'STORY_FORBIDDEN' });
});

test('撤销之后不能再通过改权限把授权复活', async () => {
  const f = await setup();
  const inv = await joined(f);
  await f.call('owner', 'inviteRevoke', access(inv));
  await assert.rejects(f.call('owner', 'inviteSetAccess', access(inv, { permissions: { read: true, copy: true } })), { code: 'STORY_FORBIDDEN' });
  await assert.rejects(f.call('friend', 'sharedRead', { familyId: 'family_owner', storyId: 'story-a' }), { code: 'STORY_FORBIDDEN' });
});

test('还没有人加入的邀请不能改权限', async () => {
  const f = await setup();
  const inv = await f.invite();
  await assert.rejects(f.call('owner', 'inviteSetAccess', access(inv, { permissions: { read: true, copy: true } })), { code: 'STORY_FORBIDDEN' });
});

function addMember(f, name, relation = '朋友', memberId = 'member-manual') {
  f.tables.set(`family_members:family_owner_${memberId}`, { familyId: 'family_owner', memberId, id: memberId, name, relation, avatarText: name.slice(0, 1), role: 'contributor', kind: 'person' });
  const family = f.tables.get('families:family_owner');
  family.memberNameClaims = { ...(family.memberNameClaims || {}), [require('../cloudfunctions/storyBooks/core').hash(name)]: { name, memberId } };
}

test('接受邀请后，这位家人出现在主人的记忆之家名单里，关系默认「家人」', async () => {
  const f = await setup();
  const inv = await f.invite();
  await f.call('friend', 'inviteAccept', { token: inv.token });
  const member = [...f.tables].find(([key]) => key.startsWith('family_members:family_owner_wx_'))[1];
  assert.equal(member.name, '小岚');
  assert.equal(member.relation, '家人');
  assert.equal(member.role, 'contributor');
  assert.equal(member.kind, 'person');
});

test('邀请时选的关系会带进名单；重复点开不会产生第二个人', async () => {
  const f = await setup();
  const inv = await f.invite({ relation: '同学' });
  await f.call('friend', 'inviteAccept', { token: inv.token });
  await f.call('friend', 'inviteAccept', { token: inv.token });
  const members = [...f.tables].filter(([key]) => key.startsWith('family_members:family_owner_wx_'));
  assert.equal(members.length, 1);
  assert.equal(members[0][1].relation, '同学');
});

test('名字已经在名单里：直接告诉主人“这个人已经存在”，不生成邀请', async () => {
  const f = await setup();
  addMember(f, '小岚', '同学');
  await assert.rejects(f.invite(), { code: 'STORY_INVITEE_EXISTS', message: /已经存在/ });
  await assert.rejects(f.invite({ relation: '朋友' }), { code: 'STORY_INVITEE_EXISTS' }, '关系不同也算同一个人，和手动添加一致');
  const other = await f.invite({ inviteeName: '阿远' });
  assert.ok(other.token);
});

test('同一个名字已有一份等待中的邀请时，不能再发第二份', async () => {
  const f = await setup();
  await f.invite();
  await assert.rejects(f.invite(), { code: 'STORY_INVITEE_EXISTS' });
});

test('邀请发出后主人手动加了同名的人：接受时拦下，不产生重名成员', async () => {
  const f = await setup();
  const inv = await f.invite();
  addMember(f, '小岚', '同事');
  await assert.rejects(f.call('friend', 'inviteAccept', { token: inv.token }), { code: 'STORY_INVITEE_EXISTS' });
  await assert.rejects(f.call('friend', 'sharedRead', { familyId: 'family_owner', storyId: 'story-a' }), { code: 'STORY_ACCESS_DISABLED' });
});

test('同名成员在「最近删除」里时仍算已存在，和手动添加一致', async () => {
  const f = await setup();
  addMember(f, '小岚', '同学');
  f.tables.get('family_members:family_owner_member-manual').deletedAt = '2026-10-01T00:00:00.000Z';
  await assert.rejects(f.invite(), { code: 'STORY_INVITEE_EXISTS' });
});

test('关系过长或带控制字符的邀请被拒绝', async () => {
  const f = await setup();
  await assert.rejects(f.invite({ relation: '关'.repeat(13) }), { code: 'STORY_FORBIDDEN' });
  await assert.rejects(f.invite({ relation: '同‮学' }), { code: 'STORY_FORBIDDEN' });
});
