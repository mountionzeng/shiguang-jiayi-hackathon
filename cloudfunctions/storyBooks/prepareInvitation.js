const { exportBookImages } = require('./bookExports');
const { identityError } = require('./identity');

async function prepareInvitation(repo, ctx, event, invitations, options) {
  const selection=event.selection;
  if (!selection || selection.sourceKind || !['book','chapters'].includes(selection.scope)) throw identityError();
  const verifyAccount = async reader => {
    const account=await reader.get('user_accounts',ctx.accountId);
    if (!account || account.status!=='active' || account.primaryFamilyId!==ctx.familyId ||
        event.expectedAccountScope!==JSON.stringify([ctx.verifiedOpenid,account.primaryFamilyId])) throw identityError();
  };
  await verifyAccount(repo);
  // The same approved export path used by image sharing: exact descriptor,
  // current revision, text moderation and signed, approved images.
  const material=await exportBookImages(repo,ctx,{...selection,familyId:ctx.familyId},
    {approve:options.approveShareCard,sign:options.signMedia});
  const descriptor=material.descriptor;
  const invitation=await invitations(ctx,{action:'inviteCreate',familyId:ctx.familyId,storyId:descriptor.storyId,
    chapterIds:descriptor.chapters.map(c=>c.id),permissions:{read:true,copy:true,edit:false,forward:false},inviteeName:event.inviteeName},
  async (tx,story)=>{
    await verifyAccount(tx);
    if (story.currentRevisionId!==descriptor.revisionId || story.version!==descriptor.storyVersion)
      throw Object.assign(new Error('书稿已有更新，请重新生成图文预览'),{code:'VERSION_CONFLICT'});
  });
  return {...invitation,descriptorId:descriptor.id,imageUrl:material.coverUrls?.[0] || material.coverUrl || ''};
}
module.exports={prepareInvitation};
