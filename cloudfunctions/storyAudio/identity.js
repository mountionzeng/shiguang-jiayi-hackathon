const crypto=require('node:crypto');
const accountDocumentIdFor=openid=>`account_${crypto.createHash('sha256').update(openid).digest('hex').slice(0,24)}`;
/*
 * familyId 由 openid 推导。原先用 replace 把非法字符悄悄换成下划线，
 * 这意味着两个不同的 openid 可能被洗成同一个 familyId——两个用户共用一个房间，
 * 故事互相串门。微信 openid 实际就是 [0-9A-Za-z_-]{28}，永远不触发替换，
 * 所以这是一个没有守卫的假设，正是用户变多以后才会咬人的那种。
 * 改为校验：不合规就报错，把一次静默的房间合并换成一声响亮的失败。
 * 与 drinkingTimeBridge/egress.js 已有的做法保持一致。
 */
function assertOpenid(openid){if(typeof openid!=='string'||!/^[0-9A-Za-z_-]{1,128}$/.test(openid))throw new Error('INVALID_OPENID');return openid;}
const fallbackFamilyId=openid=>`family_${assertOpenid(openid)}`;

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
