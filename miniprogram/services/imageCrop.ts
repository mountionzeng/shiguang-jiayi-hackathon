export interface ImageCrop { x:number; y:number; width:number; height:number }
export function imageCropFrame(sourceWidth:number, sourceHeight:number, purpose:string, zoom=1, x=.5, y=.5) {
  if (!(sourceWidth>0 && sourceHeight>0)) throw new Error('暂时读不到图片尺寸');
  const width=220, height=purpose==='cover'?330:220*4/3;
  const scale=Math.max(width/sourceWidth,height/sourceHeight)*Math.max(1,Math.min(3,zoom));
  const imageWidth=sourceWidth*scale,imageHeight=sourceHeight*scale;
  const left=-(imageWidth-width)*Math.max(0,Math.min(1,x)),top=-(imageHeight-height)*Math.max(0,Math.min(1,y));
  return {width,height,imageWidth,imageHeight,left,top,
    style:`width:${imageWidth}px;height:${imageHeight}px;left:${left}px;top:${top}px;`,
    crop:{x:-left/imageWidth,y:-top/imageHeight,width:width/imageWidth,height:height/imageHeight}};
}
