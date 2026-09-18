const crypto=require('node:crypto');
const {copiedPath,MAX_BYTES,validateMetadata}=require('./copyAssets');
function storageError(){return Object.assign(new Error('图片文件未完成验证，请稍后重试'),{code:'STORY_COPY_STORAGE_ERROR'});}
function checkedJpeg(bytes){
  if(!Buffer.isBuffer(bytes) || bytes.length<4 || bytes.length>MAX_BYTES || bytes[0]!==255 || bytes[1]!==216 || bytes[bytes.length-2]!==255 || bytes[bytes.length-1]!==217)throw storageError();
  return bytes;
}
const sha256=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
// No signed public URL or remote URL fetch. SDK credentials remain server-side.
// This adapter is not instantiated by public dispatch until activation gates pass.
function createCopyStorage(cloud){
  return {
    async copy(sourceFileID,destination){
      if(typeof sourceFileID!=='string' || !/^cloud:\/\/[^/]+\/user-photos\/family_[\w-]+\/photo-[a-z0-9-]+\/display\.jpg$/.test(sourceFileID) || !copiedPath.test(destination))throw storageError();
      const bytes=checkedJpeg((await cloud.downloadFile({fileID:sourceFileID})).fileContent);
      const cloudPath=destination.split('/').slice(3).join('/');
      const result=await cloud.uploadFile({cloudPath,fileContent:bytes});
      return validateMetadata({fileID:result.fileID,bytes:bytes.length,sha256:sha256(bytes)},destination);
    },
    async verify(asset){
      if(!copiedPath.test(asset.fileID || ''))throw storageError();
      const bytes=checkedJpeg((await cloud.downloadFile({fileID:asset.fileID})).fileContent);
      if(bytes.length!==asset.bytes || sha256(bytes)!==asset.sha256)throw storageError();
    },
    async remove(fileIDs){
      if(!Array.isArray(fileIDs) || fileIDs.length>45 || fileIDs.some(id=>!copiedPath.test(id)))throw storageError();
      if(!fileIDs.length)return;
      const response=await cloud.deleteFile({fileList:[...new Set(fileIDs)]});
      if(!Array.isArray(response.fileList) || fileIDs.some(id=>!response.fileList.some(item=>item.fileID===id && item.status===0)))throw storageError();
    },
  };
}
module.exports={createCopyStorage};
