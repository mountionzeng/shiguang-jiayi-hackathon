const {StoryImageError} = require('./core');
const invalid = () => {throw new StoryImageError('INVALID_CROP','请重新调整图片取景范围');};
function normalizeCrop(value, purpose) {
  if (value === undefined) return undefined;
  if (!['cover','backdrop'].includes(purpose) || !value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(k=>!['x','y','width','height'].includes(k))) invalid();
  const result = {};
  for(const key of ['x','y','width','height']) {
    if(typeof value[key] !== 'number' || !Number.isFinite(value[key])) invalid();
    result[key]=Math.round(value[key]*1000000)/1000000;
  }
  if(result.x<0 || result.y<0 || result.width<=0.01 || result.height<=0.01 || result.x+result.width>1.000002 || result.y+result.height>1.000002) invalid();
  return result;
}
async function renderRoleImage(buffer, crop, purpose, aiGenerated) {
  const sharp=require('sharp');
  const oriented=await sharp(buffer,{limitInputPixels:12*1024*1024}).rotate().toBuffer();
  const meta=await sharp(oriented).metadata();
  const width=purpose==='cover'?800:900, height=1200;
  const left=Math.round(crop.x*meta.width),top=Math.round(crop.y*meta.height);
  const region={left,top,width:Math.min(meta.width-left,Math.round(crop.width*meta.width)),height:Math.min(meta.height-top,Math.round(crop.height*meta.height))};
  // A stale/malicious crop cannot stretch an image into a different aspect ratio.
  if(region.width<1 || region.height<1 || Math.abs(region.width/region.height-width/height)>0.015) invalid();
  let output=sharp(oriented).extract(region).resize(width,height,{fit:'fill'});
  if(aiGenerated) output=output.composite([{input:Buffer.from(`<svg width="${width}" height="${height}"><rect x="${width-165}" y="1150" width="150" height="36" rx="5" fill="black" opacity="0.35"/><text x="${width-150}" y="1175" font-family="sans-serif" font-size="22" fill="white">AI generated</text></svg>`),top:0,left:0}]);
  return {buffer:await output.png().toBuffer(),width,height};
}
module.exports={normalizeCrop,renderRoleImage};
