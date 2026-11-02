const cloud=require('wx-server-sdk');
const {readAuthoritativeStory,writeAuthoritativeStory,readAuthoritativeMedia,authoritativeShareCard,READ_PATH,WRITE_PATH,MEDIA_PATH,CARD_PATH}=require('./core');
const {webImport,PATH:WEB_IMPORT_PATH}=require('./webImport');
const {webLoginQr,PATH:WEB_LOGIN_QR_PATH}=require('./webLoginQr');
cloud.init({env:cloud.DYNAMIC_CURRENT_ENV});
const db=cloud.database();
function reader(target){return {async get(table,id){try{return (await target.collection(table).doc(id).get()).data;}catch(error){if(/does not exist|not found|cannot find document/i.test(String(error?.message||error?.errMsg||error)))return undefined;throw error;}},async set(table,id,value){await target.collection(table).doc(id).set({data:value});}};}
const repo={transaction:fn=>db.runTransaction(tx=>fn(reader(tx))),
  async listStories(familyId,cursor,limit){return (await db.collection('stories').where({familyId}).orderBy('_id','asc').skip(cursor).limit(limit)
    .field({id:true,familyId:true,title:true,bookTitle:true,updatedAt:true,currentRevisionId:true,version:true,deletedAt:true,sourcePolicyRequired:true}).get()).data;}};
const headersOf=value=>Object.fromEntries(Object.entries(value||{}).map(([key,item])=>[key.toLowerCase(),String(item)]));
function response(statusCode,value){return {statusCode,headers:{'content-type':'application/json'},body:JSON.stringify(value)};}
async function main(event={}){
  const isImport=String(event.path||event.requestContext?.path||'')===WEB_IMPORT_PATH;
  const isLoginQr=String(event.path||event.requestContext?.path||'')===WEB_LOGIN_QR_PATH;
  if(isLoginQr?process.env.WEB_LOGIN_QR_ENABLED!=='true':isImport?process.env.WEB_STORY_IMPORT_ENABLED!=='true':process.env.STORY_DESKTOP_ACCESS_ENABLED!=='true')return response(404,{error:'not_found'});
  const secret=String(process.env.STORY_DESKTOP_AUTHORITY_SECRET||'');
  const raw=typeof event.body==='string'?event.body:JSON.stringify(event.body??null);if(Buffer.byteLength(raw)>600000)return response(413,{error:'payload_too_large'});
  let body;try{body=JSON.parse(raw);}catch{return response(400,{error:'invalid_input'});}
  const request={method:String(event.httpMethod||event.requestContext?.httpMethod||''),path:String(event.path||event.requestContext?.path||''),headers:headersOf(event.headers),body};
  try{
    const options={secret,now:Date.now,shareCardEnabled:process.env.STORY_SHARE_CARD_ENABLED==='true',
      async approveShareCard(text,openid){
        if(!openid)return false;
        try{const response=await cloud.openapi.security.msgSecCheck({openid,scene:3,version:2,content:text});return response?.result?.suggest==='pass';}catch{return false;}
      },async signMedia(fileID,maxAge){const result=await cloud.getTempFileURL({fileList:[{fileID,maxAge}]});
      return result.fileList?.find(item=>item.fileID===fileID&&item.status===0)?.tempFileURL;}};
    if(isLoginQr)return response(200,await webLoginQr(repo,request,{...options,envVersion:process.env.WEB_LOGIN_QR_ENV_VERSION,generate:input=>cloud.openapi.wxacode.getUnlimited(input)}));
    if(isImport)return response(200,await webImport(repo,request,{...options,download:async fileID=>(await cloud.downloadFile({fileID})).fileContent}));
    if(request.path===READ_PATH)return response(200,{story:await readAuthoritativeStory(repo,request,options)});
    if(request.path===WRITE_PATH)return response(200,{result:await writeAuthoritativeStory(repo,request,options)});
    if(request.path===MEDIA_PATH)return response(200,{photo:await readAuthoritativeMedia(repo,request,options)});
    if(request.path===CARD_PATH)return response(200,{card:await authoritativeShareCard(repo,request,options)});
    return response(404,{error:'not_found'});
  }catch(error){const code=String(error?.code||'authority_unavailable');return response(code==='invalid_authority_signature'||code==='replayed_authority_request'?401:
    code==='authority_rate_limited'?429:['story_access_revoked','STORY_FORBIDDEN'].includes(code)?404:['version_conflict','VERSION_CONFLICT'].includes(code)?409:422,{error:code});}
}
module.exports={main};
