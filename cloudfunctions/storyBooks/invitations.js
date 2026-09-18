const crypto = require('node:crypto');
const { assertCurrentIdentity, assertSpaceOwner, identityError, FAMILY_ID } = require('./identity');
const { evaluateStoryAccess, grantIdFor } = require('./access');
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const ID = /^[a-f0-9]{64}$/;
const TOKEN = /^[a-f0-9]{48}$/;
const STORY = /^story-[a-z0-9-]{1,100}$/;
const TTL = 24 * 60 * 60 * 1000;
const LIMIT = 12;
function fail(code = 'STORY_FORBIDDEN') {
  if (code === 'STORY_FORBIDDEN') throw identityError();
  throw Object.assign(new Error(code === 'STORY_INVITE_LIMIT' ? '邀请或申请次数已达上限，请稍后再试或撤销旧邀请' : '这项操作暂未开放'), { code });
}
function chapterIds(value) {
  return Array.isArray(value) && value.length > 0 && value.length <= 30 && new Set(value).size === value.length &&
    value.every(id => typeof id === 'string' && /^chapter-[a-z0-9-]{1,60}$/.test(id));
}
async function resource(tx, familyId, storyId) {
  if (!FAMILY_ID.test(familyId || '') || !STORY.test(storyId || '')) fail();
  const family = await tx.get('families', familyId);
  const space = await tx.get('story_principal_spaces', familyId);
  const story = await tx.get('stories', `${familyId}_${storyId}`);
  if (!family || family.storyBooks?.status !== 'active' || space?.status !== 'active' || family.ownerAccountId !== space.accountId ||
      !story || story.familyId !== familyId || story.id !== storyId || story.deletedAt || !/^revision-[a-zA-Z0-9-]{1,120}$/.test(story.currentRevisionId || '')) fail();
  return { story, space };
}
async function currentChapters(tx, story) {
  const record = await tx.get('biography_drafts', `${story.familyId}_${story.currentRevisionId}`);
  if (!record || record.familyId !== story.familyId || record.storyId !== story.id || record.revision?.id !== story.currentRevisionId ||
      record.revision.storyId !== story.id || !Array.isArray(record.revision.draft?.chapters)) fail();
  return record.revision.draft.chapters;
}
async function rate(tx, principalId, now) {
  const previous = await tx.get('story_invite_rates', principalId);
  const window = Math.floor(now / 3600000);
  const count = previous?.window === window ? previous.count : 0;
  if (!Number.isSafeInteger(count) || count >= 30) fail('STORY_INVITE_LIMIT');
  await tx.set('story_invite_rates', principalId, { window, count: count + 1 });
}
async function sourceCheck(tx, inv, story, space, now) {
  if (inv.ownerPrincipalId !== space.principalId || !chapterIds(inv.chapterIds)) fail();
  if (inv.creatorPrincipalId !== space.principalId) {
    const grant = await tx.get('story_grants', grantIdFor(inv.familyId, inv.storyId, inv.creatorPrincipalId));
    if (grant?.version !== inv.parentGrantVersion || !evaluateStoryAccess({principalId:inv.creatorPrincipalId,ownerPrincipalId:space.principalId,story,grant,action:'forward',chapterIds:inv.chapterIds,nowMs:now})) fail();
  }
}
const ownStatus = (inv, principalId) => {
  const applicant = inv.applicants.find(item => item.principalId === principalId);
  return { status: inv.status === 'revoked' ? 'revoked' : applicant?.status || 'unrequested', expiresAtMs: inv.expiresAtMs,
    ...(applicant ? { applicantId: applicant.id, verificationCode: applicant.verificationCode } : {}),
    ...(inv.status === 'approved' && inv.recipientPrincipalId === principalId ? {familyId:inv.familyId,storyId:inv.storyId} : {}) };
};

function createInvitationService(repo, { sharedReadFamilyIds = [], sharedEditEnabled = false, copyReceiveEnabled = false, now = Date.now } = {}) {
  const canary = new Set(sharedReadFamilyIds);
  return async (ctx, input) => repo.transaction(async tx => {
    await assertCurrentIdentity(tx, ctx);
    if (!canary.has(ctx.familyId)) fail('STORY_ACCESS_DISABLED');
    const time = now();
    if (!Number.isFinite(time)) fail();
    const action = input.action;
    if (action === 'inviteCreate' || action === 'inviteManage') {
      if (!canary.has(input.familyId)) fail('STORY_ACCESS_DISABLED');
      const { story, space } = await resource(tx, input.familyId, input.storyId);
      const owner = ctx.principalId === space.principalId;
      const directoryId = `${input.familyId}_${input.storyId}`;
      const directory = await tx.get('story_invite_indexes', directoryId) || { ids: [] };
      if (!Array.isArray(directory.ids) || directory.ids.length > LIMIT) fail();
      if (action === 'inviteManage') {
        if (!owner) fail();
        await assertSpaceOwner(tx, ctx);
        const chapters = await currentChapters(tx, story);
        const invitations = [];
        for (const id of directory.ids) {
          const inv = await tx.get('story_invitations', id);
          if (!inv || inv.familyId !== story.familyId || inv.storyId !== story.id) fail();
          invitations.push({ invitationId:id, status:inv.status === 'pending' && inv.expiresAtMs <= time ? 'expired' : inv.status,
            expiresAtMs:inv.expiresAtMs, chapterIds:inv.chapterIds, permissions:inv.permissions,
            applicants:inv.applicants.map(a=>({applicantId:a.id,displayName:a.displayName,verificationCode:a.verificationCode,status:a.status})) });
        }
        return { story:{id:story.id,title:story.title}, chapters:chapters.map(c=>({id:c.id,title:c.title})), invitations };
      }
      if (!chapterIds(input.chapterIds) || !input.permissions || input.permissions.read !== true ||
          Object.keys(input.permissions).some(key=>!['read','forward','edit','copy','publish'].includes(key)) ||
          Object.values(input.permissions).some(value=>typeof value!=='boolean')) fail();
      if (input.permissions.publish) fail('STORY_ACCESS_NOT_READY');
      const permissions = {read:true,forward:input.permissions.forward === true,
        edit:input.permissions.edit === true,copy:input.permissions.copy === true,publish:false};
      let parentGrantVersion;
      if (owner) await assertSpaceOwner(tx, ctx);
      else {
        if (permissions.edit || permissions.copy) fail();
        const grant = await tx.get('story_grants', grantIdFor(story.familyId, story.id, ctx.principalId));
        if (permissions.forward || !evaluateStoryAccess({principalId:ctx.principalId,ownerPrincipalId:space.principalId,story,grant,action:'forward',chapterIds:input.chapterIds,nowMs:time})) fail();
        parentGrantVersion = grant.version;
      }
      if (permissions.edit && sharedEditEnabled !== true) fail('STORY_ACCESS_NOT_READY');
      if (permissions.copy && copyReceiveEnabled !== true) fail('STORY_ACCESS_NOT_READY');
      // Provenance-bearing copies cannot be delegated before U3's policy verifier.
      if (story.sourcePolicyRequired === true) fail('STORY_ACCESS_NOT_READY');
      const chapters = await currentChapters(tx, story);
      if (input.chapterIds.some(id=>!chapters.some(c=>c.id===id))) fail();
      const retained = [];
      for (const id of directory.ids) {
        const old = await tx.get('story_invitations', id);
        if (old && old.status !== 'revoked' && (old.status === 'approved' || old.expiresAtMs > time)) retained.push(id);
      }
      if (retained.length >= LIMIT) fail('STORY_INVITE_LIMIT');
      await rate(tx,ctx.principalId,time);
      const token = crypto.randomBytes(24).toString('hex'), id = digest(token);
      const inv = {familyId:story.familyId,storyId:story.id,ownerPrincipalId:space.principalId,creatorPrincipalId:ctx.principalId,
        chapterIds:[...input.chapterIds],permissions,status:'pending',expiresAtMs:time+TTL,applicants:[],
        ...(parentGrantVersion ? {parentGrantVersion} : {})};
      await tx.set('story_invitations',id,inv);
      await tx.set('story_invite_indexes',directoryId,{ids:[...retained,id]});
      return {invitationId:id,token,expiresAtMs:inv.expiresAtMs};
    }
    const byToken = action === 'inviteGet' || action === 'inviteApply';
    if (byToken ? !TOKEN.test(input.token || '') : !ID.test(input.invitationId || '')) fail();
    const id = byToken ? digest(input.token) : input.invitationId;
    const inv = await tx.get('story_invitations',id);
    if (!inv || !canary.has(inv.familyId) || !Array.isArray(inv.applicants) || inv.applicants.length > 8) fail();
    if (!byToken && (input.familyId !== inv.familyId || input.storyId !== inv.storyId || ctx.principalId !== inv.ownerPrincipalId)) fail();
    // Revocation remains available after source deletion/expiry; it never reads the manuscript.
    if (action === 'inviteRevoke') {
      await assertSpaceOwner(tx,ctx);
      if (ctx.familyId !== inv.familyId) fail();
      if (inv.recipientPrincipalId) {
        const gid = grantIdFor(inv.familyId,inv.storyId,inv.recipientPrincipalId), grant = await tx.get('story_grants',gid);
        if (grant?.invitationId === id && grant.status === 'active') await tx.set('story_grants',gid,{...grant,status:'revoked',version:grant.version+1});
      }
      await tx.set('story_invitations',id,{...inv,status:'revoked'});
      return {ok:true};
    }
    const {story,space} = await resource(tx,inv.familyId,inv.storyId);
    if (inv.status === 'revoked') fail();
    if (inv.status !== 'approved' && inv.expiresAtMs <= time) fail();
    await sourceCheck(tx,inv,story,space,time);
    if (action === 'inviteGet') return ownStatus(inv,ctx.principalId);
    if (action === 'inviteApply') {
      const previous = inv.applicants.find(a=>a.principalId===ctx.principalId);
      if (previous?.status === 'rejected' || (inv.status === 'approved' && inv.recipientPrincipalId !== ctx.principalId)) fail();
      if (previous) return ownStatus(inv,ctx.principalId);
      if (ctx.principalId === inv.ownerPrincipalId || inv.applicants.length >= 8) fail('STORY_INVITE_LIMIT');
      if (typeof input.displayName !== 'string' || !input.displayName.trim() || input.displayName.length > 30 || /[\u0000-\u001f\u202a-\u202e\u2066-\u2069]/.test(input.displayName)) fail();
      await rate(tx,ctx.principalId,time);
      inv.applicants.push({id:crypto.randomBytes(12).toString('hex'),principalId:ctx.principalId,displayName:input.displayName.trim(),verificationCode:crypto.randomBytes(4).toString('hex'),status:'pending'});
      await tx.set('story_invitations',id,inv);
      return ownStatus(inv,ctx.principalId);
    }
    if (action !== 'inviteDecide') fail();
    await assertSpaceOwner(tx,ctx);
    if (ctx.familyId !== inv.familyId || !['approve','reject'].includes(input.decision)) fail();
    const applicant = inv.applicants.find(a=>a.id===input.applicantId);
    if (!applicant || applicant.verificationCode !== input.verificationCode) fail();
    if (inv.status === 'approved') {
      if (input.decision !== 'approve' || inv.recipientPrincipalId !== applicant.principalId) fail();
      const grant = await tx.get('story_grants',grantIdFor(inv.familyId,inv.storyId,applicant.principalId));
      if (grant?.status !== 'active' || grant.invitationId !== id) fail();
      return {ok:true};
    }
    if (input.decision === 'reject') applicant.status = 'rejected';
    else {
      if (applicant.status !== 'pending') fail();
      const recipient = await tx.get('story_principals',applicant.principalId);
      if (recipient?.status !== 'active' || !canary.has(recipient.familyId)) fail();
      const chapters = await currentChapters(tx,story);
      if (inv.chapterIds.some(id=>!chapters.some(c=>c.id===id))) fail();
      const gid=grantIdFor(inv.familyId,inv.storyId,applicant.principalId), previous=await tx.get('story_grants',gid);
      if (previous?.status === 'active') fail(); // Never silently replace or widen an existing grant.
      await tx.set('story_grants',gid,{familyId:inv.familyId,storyId:inv.storyId,principalId:applicant.principalId,
        ownerPrincipalId:inv.ownerPrincipalId,status:'active',version:(previous?.version || 0)+1,scope:{type:'chapters',chapterIds:inv.chapterIds},permissions:inv.permissions,invitationId:id});
      inv.status='approved';inv.recipientPrincipalId=applicant.principalId;
      for (const item of inv.applicants) item.status=item.id===applicant.id?'approved':'rejected';
    }
    await tx.set('story_invitations',id,inv);
    return {ok:true};
  });
}
module.exports = { createInvitationService };
