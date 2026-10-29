const crypto=require('node:crypto');
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
/** Called only with the authenticated bridge response; never accept sender identity from the client. */
async function recordDeliveryActivity(db,context,result,direction,pkg){
  const message=pkg||result.package,delivery=result.delivery;
  if(!message||!delivery?.deliveryId)return;
  const account=await db.collection('user_accounts').doc(`account_${hash(context.OPENID).slice(0,24)}`).get().then(row=>row.data);
  if(!account?.primaryFamilyId)throw new Error('family_not_found');
  try{await db.createCollection('account_message_receipts');}catch(error){if(!/exist|already/i.test(String(error?.errMsg||error?.message||error)))throw error;}
  const familyId=account.primaryFamilyId;
  const id=hash(`${familyId}:${direction}:${delivery.deliveryId}`);
  // Fixed document identity makes rereading/retrying idempotent. Package content is immutable.
  await db.collection('account_message_receipts').doc(id).set({data:{familyId,direction,
    deliveryId:delivery.deliveryId,packageId:message.packageId,package:message,kind:delivery.kind||'send',
    senderKey:direction==='received'?String(delivery.senderKey||''):'',senderName:message.sender?.displayName||'',
    createdAt:delivery.createdAt||message.createdAt,recordedAt:new Date().toISOString()}});
}
module.exports={recordDeliveryActivity};
