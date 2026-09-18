const test=require('node:test');
const assert=require('node:assert/strict');
const {prepareDesktopBody}=require('../cloudfunctions/drinkingTimeBridge/egress');
const {subjectFor}=require('../cloudfunctions/drinkingTimeBridge/core');

function fixture(){
  const data=new Map(),familyId='family_owner';
  const story={id:'story-a',familyId,title:'家里的故事',version:2,currentRevisionId:'revision-a',updatedAt:'2026-09-18T00:00:00Z'};
  const revision={id:'revision-a',storyId:story.id,draft:{title:'书名',generatedAt:story.updatedAt,chapters:[{id:'chapter-a',title:'童年',memoryIds:[],content:[{text:'云端原文'}]}]}};
  data.set('families/'+familyId,{_openid:'owner',storyBooks:{status:'active'}});
  data.set('stories/'+familyId+'_story-a',story);
  data.set('biography_drafts/'+familyId+'_revision-a',{familyId,storyId:story.id,revision});
  const repo={async get(table,id){return structuredClone(data.get(table+'/'+id));},async set(table,id,value){data.set(table+'/'+id,structuredClone(value));},async transaction(fn){return fn(repo);}};
  const context={APPID:'wx-original',OPENID:'owner'};
  const event={action:'issueDesktop',storyRef:{storyId:story.id,revisionId:revision.id,version:2}};
  return {data,repo,context,event,story,revision,options:{bootstrapAppId:'wx-original'}};
}

test('desktop sends only authoritative saved manuscript, never injected client text',async()=>{
  const f=fixture();
  const body=await prepareDesktopBody(f.repo,{...f.event,story:{text:'恶意替换',sourceKey:'forged'}},f.context,f.options);
  assert.equal(body.subject,subjectFor('wx-original','owner'));
  assert.equal(body.story.manuscript.chapters[0].content[0].text,'云端原文');
  assert.equal(JSON.stringify(body).includes('恶意替换'),false);
  assert.match(body.story.sourceRevision,/^[0-9a-f]{16}$/);
  assert.deepEqual(body.story.memories,[]);
});

test('migrated owners cannot downgrade to arbitrary legacy snapshots',async()=>{
  const f=fixture();
  await assert.rejects(prepareDesktopBody(f.repo,{action:'issueDesktop',story:{sourceKey:'story:假旧稿'}},f.context,f.options),{code:'STORY_PROTOCOL_REQUIRED'});
});

test('desktop rejects protected content, stale revisions and deleted stories',async()=>{
  for(const change of ['protected','draft','stale','deleted','foreign']){
    const f=fixture();
    if(change==='protected')f.story.sourcePolicyRequired=true;
    if(change==='draft')f.revision.draft.chapters[0].content[0].sourceIds=[];
    if(change==='stale')f.story.version++;
    if(change==='deleted')f.story.deletedAt='now';
    if(change==='foreign')f.story.familyId='family_other';
    f.data.set('stories/family_owner_story-a',f.story);
    f.data.set('biography_drafts/family_owner_revision-a',{familyId:'family_owner',storyId:'story-a',revision:f.revision});
    await assert.rejects(prepareDesktopBody(f.repo,f.event,f.context,f.options));
  }
});

test('legacy compatibility is limited to verified original-app owners before migration',async()=>{
  const f=fixture(),story={sourceKey:'story:旧故事'};
  f.data.set('families/family_owner',{_openid:'owner'});
  assert.deepEqual((await prepareDesktopBody(f.repo,{action:'issueDesktop',story},f.context,f.options)).story,story);
  await assert.rejects(prepareDesktopBody(f.repo,{action:'issueDesktop',story},{...f.context,APPID:'wx-other'},f.options));
  f.data.set('families/family_owner',{_openid:'someone-else'});
  await assert.rejects(prepareDesktopBody(f.repo,{action:'issueDesktop',story},f.context,f.options));
});

test('desktop database errors fail closed',async()=>{
  const f=fixture();
  f.repo.get=async()=>{throw new Error('offline');};
  await assert.rejects(prepareDesktopBody(f.repo,f.event,f.context,f.options),/offline/);
});

test('verified app aliases resolve the owned space; disabled or missing bindings never fall back',async()=>{
  const crypto=require('node:crypto'),f=fixture();
  const principalId='principal_'+'1'.repeat(32),accountId='account_'+'2'.repeat(24);
  const key='story_identity_aliases/'+crypto.createHash('sha256').update(JSON.stringify(['wx-linked','new-owner'])).digest('hex');
  const context={APPID:'wx-linked',OPENID:'new-owner'};
  f.data.set(key,{status:'active',appId:'wx-linked',principalId});
  f.data.set('story_principals/'+principalId,{status:'active',familyId:'family_owner',accountId});
  f.data.set('story_principal_spaces/family_owner',{status:'active',principalId,accountId});
  f.data.set('families/family_owner',{ownerAccountId:accountId,storyBooks:{status:'active'}});
  assert.equal((await prepareDesktopBody(f.repo,f.event,context,f.options)).story.sourceKey,'story-a');
  f.data.set(key,{status:'disabled',appId:'wx-linked',principalId});
  await assert.rejects(prepareDesktopBody(f.repo,f.event,context,f.options),{code:'STORY_FORBIDDEN'});
  // Even an original-app identity cannot reclaim an already bound family.
  await assert.rejects(prepareDesktopBody(f.repo,f.event,f.context,f.options),{code:'IDENTITY_UNLINKED'});
});

test('authority mode binds the selected story without sending manuscript text',async()=>{
  const crypto=require('node:crypto'),f=fixture(),principalId='principal_'+'1'.repeat(32),accountId='account_'+'2'.repeat(24);
  const key='story_identity_aliases/'+crypto.createHash('sha256').update(JSON.stringify(['wx-linked','new-owner'])).digest('hex'),context={APPID:'wx-linked',OPENID:'new-owner'};
  f.data.set(key,{status:'active',appId:'wx-linked',principalId});f.data.set('story_principals/'+principalId,{status:'active',familyId:'family_owner',accountId});
  f.data.set('story_principal_spaces/family_owner',{status:'active',principalId,accountId});f.data.set('families/family_owner',{ownerAccountId:accountId,storyBooks:{status:'active'}});
  f.story.sourcePolicyRequired=true;f.revision.draft.provenanceVersion=1;f.revision.draft.chapters[0].content[0]={text:'受保护原文',blockId:'block-'+'a'.repeat(64),sourceIds:[]};
  f.data.set('stories/family_owner_story-a',f.story);f.data.set('biography_drafts/family_owner_revision-a',{familyId:'family_owner',storyId:'story-a',revision:f.revision});
  const body=await prepareDesktopBody(f.repo,f.event,context,{authorityEnabled:true,now:()=>1000,randomBytes:()=>Buffer.alloc(32,3)});
  assert.equal('story' in body,false);assert.equal(body.storyAccess.storyId,'story-a');assert.equal(body.storyAccess.revisionId,'revision-a');
  assert.equal(JSON.stringify(body).includes('受保护原文'),false);assert.match(body.storyAccess.grantId,/^desktop-grant-[a-f0-9]{64}$/);
  const grant=f.data.get('story_desktop_grants/'+body.storyAccess.grantId);assert.equal(grant.principalId,principalId);assert.equal(grant.expiresAtMs,2592001000);
});

test('migration in progress never permits fallback or forwarding client text',async()=>{
  const f=fixture();
  for(const status of ['preparing','restarting','unknown']){
    f.data.set('families/family_owner',{_openid:'owner',storyBooks:{status}});
    await assert.rejects(prepareDesktopBody(f.repo,{action:'issueDesktop',story:{sourceKey:'story:旧故事'}},f.context,f.options),{code:'MIGRATION_NOT_READY'});
  }
});

test('cloud entry signs only the prepared body and performs no HTTP request after rejection',async()=>{
  const vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
  const {EventEmitter}=require('node:events'),f=fixture(),sent=[];
  const target={collection:table=>({doc:id=>({get:async()=>({data:await f.repo.get(table,id)})})})};
  const cloud={init(){},getWXContext:()=>f.context,database:()=>({runTransaction:fn=>fn(target)})};
  const https={request(_url,options,callback){
    const request=new EventEmitter();
    request.end=payload=>{
      sent.push({options,body:JSON.parse(payload)});
      const response=new EventEmitter();
      response.statusCode=200;response.headers={'content-type':'application/json'};
      callback(response);
      response.emit('data',Buffer.from(JSON.stringify({code:'ABC234',expiresAt:'2026-09-18T00:05:00Z',storyId:1,imported:true})));
      response.emit('end');
    };
    return request;
  }};
  const module={exports:{}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../cloudfunctions/drinkingTimeBridge/index.js'),'utf8'),{
    module,exports:module.exports,Buffer,URL,
    process:{env:{DRINKING_TIME_BRIDGE_BASE_URL:'https://example.invalid/api',DRINKING_TIME_BRIDGE_SECRET:'x'.repeat(32),WECHAT_APP_ID:'wx-original'}},
    require:name=>name==='wx-server-sdk'?cloud:name==='node:https'?https:name.startsWith('./')?require('../cloudfunctions/drinkingTimeBridge/'+name.slice(2)):require(name),
  });
  await module.exports.main({...f.event,story:{text:'不可发送'}});
  assert.equal(sent.length,1);
  assert.equal(sent[0].body.story.manuscript.chapters[0].content[0].text,'云端原文');
  assert.equal(JSON.stringify(sent[0]).includes('不可发送'),false);
  f.data.set('stories/family_owner_story-a',{...f.story,sourcePolicyRequired:true});
  await assert.rejects(module.exports.main(f.event),{code:'STORY_PROTOCOL_REQUIRED'});
  assert.equal(sent.length,1);
});
