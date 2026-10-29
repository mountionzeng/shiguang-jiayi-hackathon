const test=require('node:test'),assert=require('node:assert/strict');
const {recordDeliveryActivity}=require('../cloudfunctions/drinkingTimeBridge/activity');
test('trusted delivery identity is persisted once per recipient and delivery, not grouped by display name',async()=>{
 const rows=new Map();
 const db={createCollection:async()=>{},collection:table=>({doc:id=>({get:async()=>({data:{primaryFamilyId:'family-owner'}}),set:async({data})=>rows.set(table+':'+id,data)})})};
 const response={delivery:{deliveryId:'test-delivery',senderKey:'opaque-sender',kind:'send',createdAt:'2026-10-25T00:00:00Z'},package:{packageId:'cp_example001',sender:{displayName:'小满'},chapters:[]}};
 await recordDeliveryActivity(db,{OPENID:'owner'},response,'received');await recordDeliveryActivity(db,{OPENID:'owner'},response,'received');
 assert.equal(rows.size,1);const row=[...rows.values()][0];assert.equal(row.senderKey,'opaque-sender');assert.equal(row.direction,'received');assert.equal(row.familyId,'family-owner');assert.deepEqual(row.package,response.package);
});
