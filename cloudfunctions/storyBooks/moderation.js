const OPENID=/^[0-9A-Za-z_-]{1,128}$/;
function createTextModerator(security){
  return async (text,openid,title)=>{
    if(!security || typeof security.msgSecCheck!=='function' || !OPENID.test(openid || ''))return false;
    const content=Array.from(String(text || '').trim());
    if(!content.length)return true;
    const safeTitle=Array.from(String(title || '').trim()).slice(0,100).join('');
    try{
      for(let offset=0;offset<content.length;offset+=2500){
        const response=await security.msgSecCheck({content:content.slice(offset,offset+2500).join(''),version:2,scene:4,openid,...(safeTitle?{title:safeTitle}:{})});
        if(response?.result?.suggest!=='pass')return false;
      }
      return true;
    }catch{return false;}
  };
}
module.exports={createTextModerator};
