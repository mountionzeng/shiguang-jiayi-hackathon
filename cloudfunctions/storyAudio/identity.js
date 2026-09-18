const crypto=require('node:crypto');
const accountDocumentIdFor=openid=>`account_${crypto.createHash('sha256').update(openid).digest('hex').slice(0,24)}`;
const fallbackFamilyId=openid=>`family_${openid.replace(/[^0-9A-Za-z_-]/g,'_')}`;

async function resolveStoryAudioIdentity(db,openid) {
  const fallback={openid,accountId:accountDocumentIdFor(openid),familyId:fallbackFamilyId(openid)};
  try{
    const account=(await db.collection('user_accounts').doc(accountDocumentIdFor(openid)).get()).data;
    if(!account||account.status==='disabled')return fallback;
    const accountId=String(account.accountId||''),familyId=String(account.primaryFamilyId||'');
    if(!/^account_[0-9a-f]{24}$/.test(accountId)||!/^family_[0-9A-Za-z_-]+$/.test(familyId))return fallback;
    return {openid,accountId,familyId};
  }catch{return fallback;}
}
module.exports={accountDocumentIdFor,fallbackFamilyId,resolveStoryAudioIdentity};
