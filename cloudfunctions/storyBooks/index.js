const cloud=require('wx-server-sdk');
const {createStoryService}=require('./service');
const {createDocumentAdapter}=require('./repository');
const {createCopyStorage}=require('./copyStorage');
cloud.init({env:cloud.DYNAMIC_CURRENT_ENV});
const db=cloud.database();
const repo={...createDocumentAdapter(db),
  async all(table,familyId){const rows=[];for(let offset=0;;offset+=100){const result=await db.collection(table).where({familyId}).orderBy('_id','asc').skip(offset).limit(100).get();rows.push(...result.data);if(result.data.length<100)return rows;}},
  async transaction(fn){return db.runTransaction(async transaction=>fn(createDocumentAdapter(transaction)));},
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
  async approveExcerpt(text){
    try{
      const result=await cloud.callFunction({name:'contentSecurityCheck',data:{content:text,title:'故事选段'}});
      return result?.result?.ok===true;
    }catch{return false;}
  },
  async approveSharedEdit(text){
    try{
      const result=await cloud.callFunction({name:'contentSecurityCheck',data:{content:text,title:'亲友编辑故事'} });
      return result?.result?.ok===true;
    }catch{return false;}
  },
  async approveShareCard(text){
    try{
      const result=await cloud.callFunction({name:'contentSecurityCheck',data:{content:text,title:'公开故事卡片'} });
      return result?.result?.ok===true;
    }catch{return false;}
  },
  async signMedia(fileID,maxAge){
    const result=await cloud.getTempFileURL({fileList:[{fileID,maxAge}]});
    return result.fileList?.find(item=>item.fileID===fileID && item.status===0)?.tempFileURL;
  },
  rulesReady:process.env.STORY_ACCESS_RULES_READY==='true',
  bootstrapAppId:process.env.STORY_IDENTITY_BOOTSTRAP_APP_ID,
  sharedReadFamilyIds:String(process.env.STORY_ACCESS_CANARY_FAMILY_IDS || '').split(',').map(value=>value.trim()).filter(Boolean),
});
function errorCode(error) {
  if(['STORY_PROTOCOL_REQUIRED','CONTENT_REJECTED','STORY_EXCERPT_MISMATCH','STORY_SHARE_SELECTION_INVALID','STORY_SHARE_LIMIT','VERSION_CONFLICT','INVALID_INPUT','DUPLICATE_TITLE',
    'STORY_COPY_MEDIA_PENDING','STORY_COPY_STORAGE_ERROR','STORY_COPY_BUSY','STORY_COPY_LIMIT','STORY_RETURN_EMPTY','STORY_RETURN_LIMIT'].includes(error?.code))return error.code;
  if(['AUTH_REQUIRED','IDENTITY_UNLINKED','STORY_FORBIDDEN','STORY_ACCESS_DISABLED','STORY_ACCESS_NOT_READY','STORY_INVITE_LIMIT'].includes(error?.code))return error.code;
  const message=String(error?.message || error || '');
  if(/重新登录|记录空间|创建记录档案/.test(message))return 'AUTH_REQUIRED';
  if(/迁移|故事库.*准备/.test(message))return 'MIGRATION_NOT_READY';
  if(/已有更新|重新加载|请求编号冲突|已处理/.test(message))return 'VERSION_CONFLICT';
  if(/同名故事/.test(message))return 'DUPLICATE_TITLE';
  if(/其他故事|不能引用|跨/.test(message))return 'CROSS_STORY_REFERENCE';
  if(/不可用|没找到|不存在/.test(message))return 'STORY_NOT_FOUND';
  if(/无效|不能为空|不支持|请选择/.test(message))return 'INVALID_INPUT';
  return 'STORY_BOOK_ERROR';
}
exports.main=async event=>{
  try{
    return await dispatch(cloud.getWXContext(),event);
  }catch(error){return {error:'STORY_BOOK_ERROR',code:errorCode(error),message:error.message || '故事操作失败，请重试'};}
};
exports.errorCode=errorCode;
