const cloud=require('wx-server-sdk');
const {createStoryService}=require('./service');
const {createDocumentAdapter}=require('./repository');
const {createCopyStorage}=require('./copyStorage');
const {createTextModerator}=require('./moderation');
cloud.init({env:cloud.DYNAMIC_CURRENT_ENV});
const db=cloud.database();
const ensuredCollections=new Set();
const moderate=createTextModerator(cloud.openapi.security,cloud.callFunction.bind(cloud));
const repo={...createDocumentAdapter(db),
  async all(table,familyId){const rows=[];for(let offset=0;;offset+=100){const result=await db.collection(table).where({familyId}).orderBy('_id','asc').skip(offset).limit(100).get();rows.push(...result.data);if(result.data.length<100)return rows;}},
  async transaction(fn){return db.runTransaction(async transaction=>fn(createDocumentAdapter(transaction)));},
  // 惰性建集合：快照集合不该依赖 bootstrap token 才能存在，否则第一次写快照就会失败。
  // createCollection 已存在时会报错，忽略即可；每个冷启动最多尝试一次。
  async ensureCollection(name){
    if(ensuredCollections.has(name))return;
    try{await db.createCollection(name);}catch(error){/* 已存在，正是我们要的状态 */}
    ensuredCollections.add(name);
  },
};
const migrationFamilyIds=String(process.env.STORY_BOOKS_MIGRATION_FAMILY_IDS || '').split(',').map(value=>value.trim()).filter(Boolean);
const dispatch=createStoryService(repo,{
  migrationReady:process.env.STORY_BOOKS_MIGRATION_READY==='true',migrationFamilyIds,
  accessEnabled:process.env.STORY_ACCESS_ENABLED==='true',
  invitationsEnabled:process.env.STORY_INVITATIONS_ENABLED==='true',
  sharedMediaEnabled:process.env.STORY_SHARED_MEDIA_ENABLED==='true',
  excerptSharingEnabled:process.env.STORY_EXCERPT_SHARING_ENABLED==='true',
  sharedEditEnabled:process.env.STORY_SHARED_EDIT_ENABLED==='true',
  copyReceiveEnabled:process.env.STORY_COPY_RECEIVE_ENABLED==='true',
  shareCardEnabled:process.env.STORY_SHARE_CARD_ENABLED==='true',
  copyStorage:createCopyStorage(cloud),
  approveExcerpt:(text,openid)=>moderate(text,openid,'故事选段'),
  approveSharedEdit:(text,openid)=>moderate(text,openid,'亲友编辑故事'),
  approveShareCard:(text,openid)=>moderate(text,openid,'公开故事卡片'),
  async signMedia(fileID,maxAge){
    const result=await cloud.getTempFileURL({fileList:[{fileID,maxAge}]});
    return result.fileList?.find(item=>item.fileID===fileID && item.status===0)?.tempFileURL;
  },
  rulesReady:process.env.STORY_ACCESS_RULES_READY==='true',
  bootstrapAppId:process.env.STORY_IDENTITY_BOOTSTRAP_APP_ID,
  sharedReadFamilyIds:String(process.env.STORY_ACCESS_CANARY_FAMILY_IDS || '').split(',').map(value=>value.trim()).filter(Boolean),
});
const {errorCode}=require('./errors');
exports.main=async event=>{
  try{
    return await dispatch(cloud.getWXContext(),event);
  }catch(error){return {error:'STORY_BOOK_ERROR',code:errorCode(error),message:error.message || '故事操作失败，请重试'};}
};
exports.errorCode=errorCode;
