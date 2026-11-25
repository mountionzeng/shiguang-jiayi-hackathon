const crypto=require('node:crypto');
const {subjectFor}=require('../../cloudfunctions/drinkingTimeBridge/core');
const {sign}=require('../../cloudfunctions/storyDesktopAccess/core');
const {webImport,PATH}=require('../../cloudfunctions/storyDesktopAccess/webImport');
const {prepareWebImportIdentity}=require('../../cloudfunctions/drinkingTimeBridge/egress');
const core=require('../../cloudfunctions/storyBooks/core');
function fixture(){
  const data=new Map(),familyId='family_demo',principalId='principal_'+'1'.repeat(32),accountId='account_'+'2'.repeat(24);
  const context={APPID:'wxTestApp',OPENID:'test-openid'},subject=subjectFor(context.APPID,context.OPENID),secret='s'.repeat(32);
  const grantId='desktop-grant-'+crypto.createHash('sha256').update('web-import:'+subject).digest('hex');
  const ref={storyId:'story-demo',revisionId:'revision-one',version:1};
  const draft={title:'虚构：河边的一本书',generatedAt:'2026-11-02T00:00:00.000Z',chapters:[
    {id:'chapter-one',title:'河岸',memoryIds:[],content:[{text:'河边第一段\n\n第二行'},{photoId:'photo-demo'}]},
    {id:'chapter-empty',title:'空章',memoryIds:[],content:[]},
    {id:'chapter-last',title:'归家',memoryIds:[],content:[{text:'回到家。'}]},
  ]};Object.assign(draft,core.flatten(draft.chapters));
  data.set('story_identity_aliases/'+crypto.createHash('sha256').update(JSON.stringify([context.APPID,context.OPENID])).digest('hex'),{status:'active',appId:context.APPID,principalId});
  data.set('story_principals/'+principalId,{status:'active',familyId,accountId});
  data.set('story_principal_spaces/'+familyId,{status:'active',principalId,accountId});
  data.set('families/'+familyId,{ownerAccountId:accountId,_openid:context.OPENID,storyBooks:{status:'active'}});
  data.set('stories/'+familyId+'_'+ref.storyId,{id:ref.storyId,familyId,title:draft.title,version:1,currentRevisionId:ref.revisionId,updatedAt:'2026-11-02T00:00:00.000Z'});
  data.set('biography_drafts/'+familyId+'_'+ref.revisionId,{familyId,storyId:ref.storyId,revision:{id:ref.revisionId,storyId:ref.storyId,editorName:'虚构作者',draft}});
  data.set('photos/'+familyId+'__photo-demo',{familyId,photoId:'photo-demo',_openid:context.OPENID,displayFileID:`cloud://env/user-photos/${familyId}/photo-demo/display.jpg`,moderation:{ok:true,suggest:'pass'}});
  const repo={async get(table,id){return structuredClone(data.get(table+'/'+id));},async set(table,id,value){data.set(table+'/'+id,structuredClone(value));},
    async transaction(fn){return fn(repo);},async listStories(family,cursor,limit){return [...data.entries()].filter(([k,s])=>k.startsWith('stories/')&&s.familyId===family).map(([,s])=>s).slice(cursor,cursor+limit);}};
  const options={secret,now:()=>Date.now(),download:async()=>Buffer.from('fixture-photo')};
  function signed(input,nonce=crypto.randomBytes(18).toString('base64url')){
    const body={grantId,...input},timestamp=String(options.now());
    return {method:'POST',path:PATH,body,headers:{'x-shiguang-timestamp':timestamp,'x-shiguang-nonce':nonce,'x-shiguang-signature':sign(secret,timestamp,nonce,body,PATH)}};
  }
  return {data,repo,options,context,subject,grantId,ref,signed,ready:()=>prepareWebImportIdentity(repo,context),
    request:input=>webImport(repo,signed(input),options)};
}
module.exports={fixture};
