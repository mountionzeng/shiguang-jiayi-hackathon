const test=require('node:test'),assert=require('node:assert/strict');
const {checkOutgoingPackage}=require('../cloudfunctions/drinkingTimeBridge/outgoingText');
const pkg=()=>({storyTitle:'新书名',sender:{displayName:'作者'},chapters:[{title:'新章名',blocks:[{type:'text',text:'最新正文'},{type:'image',caption:'图片说明'}],layout:{pages:[{label:'页名'}]}}]});
test('all delivery exits check current title, text, author, caption and page labels with trusted identity',async()=>{
 for(const action of ['sendChapter','createChapterClaimLink','returnChapter']){
  let checked;
  await checkOutgoingPackage(action,pkg(),{OPENID:'verified'},async(text,openid)=>{checked={text,openid};return true;});
  for(const word of ['新书名','作者','新章名','最新正文','图片说明','页名'])assert.ok(checked.text.includes(word));
  assert.equal(checked.openid,'verified');
  await assert.rejects(checkOutgoingPackage(action,pkg(),{OPENID:'verified'},async()=>false),{code:'CONTENT_REJECTED'});
  await assert.rejects(checkOutgoingPackage(action,pkg(),{OPENID:'verified'}),{code:'MODERATION_UNAVAILABLE'});
  await assert.rejects(checkOutgoingPackage(action,pkg(),{OPENID:'verified'},async()=>{throw Object.assign(new Error('review'),{code:'MODERATION_REVIEW'});}),{code:'MODERATION_REVIEW'});
 }
});
test('reading an already received package does not start a new check',async()=>{
 await checkOutgoingPackage('readChapterPackage',null,{},()=>{throw new Error('unexpected');});
});
test('delivery dispatch refuses review before any remote send',async()=>{
 const fs=require('node:fs'),vm=require('node:vm');let posts=0;
 const cloud={init(){},DYNAMIC_CURRENT_ENV:'test',database:()=>({collection:()=>({doc:()=>({set:async()=>{},remove:async()=>{}})})}),getWXContext:()=>({APPID:'wxapp',OPENID:'verified'}),callFunction:async()=>({result:{error:"STORY_BOOK_ERROR",code:"MODERATION_REVIEW"}}),openapi:{}};
 const module={exports:{}};
 vm.runInNewContext(fs.readFileSync(require.resolve('../cloudfunctions/drinkingTimeBridge/index'),'utf8'),{module,exports:module.exports,Buffer,URL,console,process:{env:{CHAPTER_PACKAGE_ENABLED:'true',CHAPTER_DELIVERY_ENABLED:'true',DRINKING_TIME_BRIDGE_BASE_URL:'https://example.com',DRINKING_TIME_BRIDGE_SECRET:'x'.repeat(32)}},require(name){
  if(name==='wx-server-sdk')return cloud;
  if(name==='node:https')return {request(){posts++;throw new Error('must not send');}};
  if(name.startsWith('./'))return require('../cloudfunctions/drinkingTimeBridge/'+name.slice(2));
  return require(name);
 }});
 const result=await module.exports.main({action:'createChapterClaimLink',package:pkg(),requestId:'12345678-1234-1234-1234-123456789012'});
 assert.equal(result.code,'MODERATION_REVIEW');assert.doesNotMatch(result.message,/var\/user|callFunction/);
 assert.equal(posts,0);
});

test('delivery reuses the existing story moderator without forwarding a caller-supplied identity',async()=>{
 const {createOutgoingModerator}=require('../cloudfunctions/drinkingTimeBridge/outgoingText');let request;
 const approve=createOutgoingModerator(async input=>{request=input;return {result:{ok:true}};});
 assert.equal(await approve('完整新稿','untrusted-openid'),true);
 assert.deepEqual(request,{name:'storyBooks',data:{action:'checkOutgoingText',text:'完整新稿'}});
 for(const response of [undefined,{result:{}},{result:{error:'bad',ok:true}}])await assert.rejects(createOutgoingModerator(async()=>response)('稿'),{code:'MODERATION_UNAVAILABLE'});
});
test('the reused moderation endpoint requires verified identity and owns no client-controlled account field',async()=>{
 const {fixture}=require('./helpers/story-access-fixture');
 const {createStoryService}=require('../cloudfunctions/storyBooks/service');const f=fixture();f.account('owner');let checked;
 const service=createStoryService(f.repo,{accessEnabled:true,rulesReady:true,bootstrapAppId:'wx-original',approveChapterText:async(text,openid)=>{checked={text,openid};return true;}});
 const input={action:'checkOutgoingText',text:'最新全文',OPENID:'forged',openid:'forged'};
 await assert.rejects(service({},input),{code:'AUTH_REQUIRED'});
 assert.deepEqual(await service({APPID:'wx-original',OPENID:'owner'},input),{ok:true});
 assert.deepEqual(checked,{text:'最新全文',openid:'owner'});
});

test('server moderation proof binds the exact text and identity, is single-use and is cleaned on failure',async()=>{
 const {fixture}=require('./helpers/story-access-fixture');
 const {moderationContext}=require('../cloudfunctions/storyBooks/moderationIdentity');
 const {withModerationIdentity}=require('../cloudfunctions/drinkingTimeBridge/outgoingText');
 const f=fixture();const ctx={APPID:'wx-original',OPENID:'owner'};
 const db={collection:table=>({doc:id=>({set:({data})=>f.repo.set(table,id,data),remove:()=>f.repo.remove(table,id)})})};
 await withModerationIdentity(db)('新稿',ctx,async proof=>{
  const event={action:'checkOutgoingText',proof,text:'新稿',openid:'forged'};
  await assert.rejects(moderationContext(f.repo,{}, {...event,text:'换稿'}),{code:'AUTH_REQUIRED'});
  await assert.rejects(moderationContext(f.repo,{},event,Date.now()+121000),{code:'AUTH_REQUIRED'});
  assert.deepEqual(await moderationContext(f.repo,{},event),ctx);
  await assert.rejects(moderationContext(f.repo,{},event),{code:'AUTH_REQUIRED'});
  assert.deepEqual(await moderationContext(f.repo,{}, {...event,action:'articleSave'}),{});
 });
 assert.equal(f.tables.size,0);
 await assert.rejects(withModerationIdentity(db)('新稿',ctx,async()=>{throw new Error('network');}),/network/);
 assert.equal(f.tables.size,0);
 await assert.rejects(moderationContext(f.repo,{}, {action:'checkOutgoingText',text:'稿',openid:'owner'}),{code:'AUTH_REQUIRED'});
});
