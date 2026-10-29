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
  const {PNG}=require('pngjs'),jpeg=require('jpeg-js');
  let decoded;
  if(buffer.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) {
    if(buffer.length<33 || buffer.readUInt32BE(16)*buffer.readUInt32BE(20)>12*1024*1024) invalid();
    decoded=PNG.sync.read(buffer,{checkCRC:true});
  } else if(buffer[0]===255 && buffer[1]===216) {
    decoded=jpeg.decode(buffer,{useTArray:true,maxResolutionInMP:12,maxMemoryUsageInMB:128});
  } else throw new StoryImageError('IMAGE_FORMAT_UNSUPPORTED','这张图的格式暂不支持裁切，请使用 PNG 或 JPG 图片');
  if(!decoded.width || !decoded.height || decoded.width*decoded.height>12*1024*1024) invalid();
  const width=purpose==='cover'?800:900,height=1200;
  const left=Math.round(crop.x*decoded.width),top=Math.round(crop.y*decoded.height);
  const region={left,top,width:Math.min(decoded.width-left,Math.round(crop.width*decoded.width)),height:Math.min(decoded.height-top,Math.round(crop.height*decoded.height))};
  if(region.width<1 || region.height<1 || Math.abs(region.width/region.height-width/height)>0.015) invalid();
  const output=new PNG({width,height});
  // Bilinear resampling in bounded RGBA memory; no native build/download step on CloudBase.
  for(let y=0;y<height;y++)for(let x=0;x<width;x++) {
    const sx=left+Math.max(0,Math.min(region.width-1,(x+.5)*region.width/width-.5));
    const sy=top+Math.max(0,Math.min(region.height-1,(y+.5)*region.height/height-.5));
    const x0=Math.floor(sx),y0=Math.floor(sy),x1=Math.min(left+region.width-1,x0+1),y1=Math.min(top+region.height-1,y0+1),fx=sx-x0,fy=sy-y0;
    for(let c=0;c<4;c++)output.data[(y*width+x)*4+c]=Math.round(
      (decoded.data[(y0*decoded.width+x0)*4+c]*(1-fx)+decoded.data[(y0*decoded.width+x1)*4+c]*fx)*(1-fy)+
      (decoded.data[(y1*decoded.width+x0)*4+c]*(1-fx)+decoded.data[(y1*decoded.width+x1)*4+c]*fx)*fy);
  }
  if(aiGenerated) {
    // A visible AI label must survive even if the original corner was cropped off.
    const glyphs={A:['01110','10001','10001','11111','10001','10001','10001'],I:['111','010','010','010','010','010','111']};
    const scale=4,boxX=width-70,boxY=height-46;
    for(let y=boxY;y<height-8;y++)for(let x=boxX;x<width-8;x++)for(let c=0;c<3;c++)output.data[(y*width+x)*4+c]*=.55;
    let gx=boxX+9;
    for(const letter of 'AI') {
      const glyph=glyphs[letter];
      glyph.forEach((row,y)=>[...row].forEach((bit,x)=>{if(bit==='1')for(let dy=0;dy<scale;dy++)for(let dx=0;dx<scale;dx++){
        const offset=((boxY+5+y*scale+dy)*width+gx+x*scale+dx)*4;output.data.fill(255,offset,offset+4);
      }}));gx+=(glyph[0].length+2)*scale;
    }
  }
  return {buffer:PNG.sync.write(output,{colorType:6}),width,height};
}
module.exports={normalizeCrop,renderRoleImage};
