import {sharingHome} from '../../../../services/storySharing';
import {ShareCardBlock,ShareCardDescriptor,ShareCardSelection,storyShareCard} from '../../../../services/storyShareCard';

type ChoiceBlock=ShareCardBlock&{checked:boolean};
type ChoiceChapter={id:string;title:string;blocks:ChoiceBlock[]};
const canvasWidth=750;
function lines(ctx:WechatMiniprogram.CanvasContext,text:string,maxWidth:number){
  const result:string[]=[];for(const paragraph of text.split(/\n/)){let line='';for(const char of paragraph){const next=line+char;if(line && ctx.measureText(next).width>maxWidth){result.push(line);line=char;}else line=next;}result.push(line || ' ');}return result;
}
function canvasExport(canvasId:string,height:number,page:WechatMiniprogram.Page.TrivialInstance){return new Promise<string>((resolve,reject)=>wx.canvasToTempFilePath({canvasId,x:0,y:0,width:canvasWidth,height,destWidth:canvasWidth,destHeight:height,fileType:'jpg',quality:.94,success:r=>resolve(r.tempFilePath),fail:reject},page));}
function imageInfo(src:string){return new Promise<WechatMiniprogram.GetImageInfoSuccessCallbackResult>((resolve,reject)=>wx.getImageInfo({src,success:resolve,fail:reject}));}

Page({
  data:{loading:false,busy:false,title:'',notice:'',chapters:[] as ChoiceChapter[],chapterId:'',previewPath:'',canPreview:false},
  storyId:'',familyId:'',revisionId:'',descriptor:undefined as ShareCardDescriptor|undefined,selection:undefined as ShareCardSelection|undefined,epoch:0,hidden:false,
  onLoad(options:{storyId?:string;familyId?:string}={}){this.storyId=options.storyId || '';this.familyId=options.familyId || '';wx.hideShareMenu();},
  onShow(){this.hidden=false;if(!this.data.chapters.length)void this.refresh();},
  onHide(){this.hidden=true;this.epoch++;this.descriptor=undefined;this.selection=undefined;this.revisionId='';this.setData({title:'',chapters:[],chapterId:'',previewPath:'',canPreview:false,busy:false});},
  onUnload(){this.onHide();this.storyId='';this.familyId='';this.revisionId='';},
  async refresh(){
    const epoch=++this.epoch;this.setData({loading:true,notice:'',chapters:[],previewPath:'',canPreview:false});
    try{const source=await storyShareCard.source(this.storyId,this.familyId || undefined);if(this.hidden || epoch!==this.epoch)return;
      const chapters=source.chapters.map(chapter=>({...chapter,blocks:chapter.blocks.map(block=>({...block,checked:false}))}));
      const first=chapters.find(chapter=>chapter.blocks.some(block=>block.publishable));this.revisionId=source.revisionId;
      this.setData({title:source.story.title,chapters,chapterId:first?.id || '',notice:first?'请选择要放进卡片的文字和照片。':'这本故事暂时没有可公开发布的内容。'});this.updateReady();
    }catch(error){if(!this.hidden && epoch===this.epoch)this.setData({notice:error instanceof Error?error.message:'故事卡片暂不可用'});}
    finally{if(!this.hidden && epoch===this.epoch)this.setData({loading:false});}
  },
  chooseChapter(event:WechatMiniprogram.CustomEvent<{value:string}>){if(this.data.busy)return;this.descriptor=undefined;this.selection=undefined;this.setData({chapterId:event.detail.value,previewPath:''});this.updateReady();},
  chooseBlocks(event:WechatMiniprogram.CustomEvent<{value:string[]}>){if(this.data.busy)return;const selected=new Set(event.detail.value);this.descriptor=undefined;this.selection=undefined;
    this.setData({chapters:this.data.chapters.map(chapter=>chapter.id===this.data.chapterId?{...chapter,blocks:chapter.blocks.map(block=>({...block,checked:selected.has(block.blockId)}))}:chapter),previewPath:''});this.updateReady();},
  updateReady(){const chapter=this.data.chapters.find(item=>item.id===this.data.chapterId),selected=chapter?.blocks.filter(block=>block.checked) || [];
    this.setData({canPreview:selected.some(block=>block.kind==='text') && selected.length<=12 && selected.filter(block=>block.kind==='photo').length<=4 && selected.every(block=>block.publishable)});},
  selected():ShareCardSelection|undefined{const chapter=this.data.chapters.find(item=>item.id===this.data.chapterId),blocks=chapter?.blocks.filter(block=>block.checked) || [];
    if(!this.data.canPreview || !chapter)return undefined;return {storyId:this.storyId,...(this.familyId?{familyId:this.familyId}:{}),revisionId:this.revisionId,chapterId:chapter.id,blockIds:blocks.map(block=>block.blockId),photoIds:blocks.flatMap(block=>block.photoId?[block.photoId]:[])};},
  async preview(){if(this.data.busy)return;const selection=this.selected();if(!selection){this.setData({notice:'请至少选择一段可公开发布的文字；最多 12 段、4 张图片。'});return;}
    const epoch=this.epoch;this.setData({busy:true,notice:'正在核对公开发布权限…'});
    try{const preview=await storyShareCard.preview(selection),material=await storyShareCard.material(selection,preview.descriptor.id);if(this.hidden || epoch!==this.epoch)return;
      const path=await this.draw(material.descriptor,material.media);if(this.hidden || epoch!==this.epoch)return;this.descriptor=material.descriptor;this.selection=selection;this.setData({previewPath:path,notice:'这是最终图片的预览。只包含你刚才选中的内容。'});
    }catch(error){if(!this.hidden && epoch===this.epoch)this.setData({previewPath:'',notice:error instanceof Error?error.message:'预览生成失败，请重试'});}
    finally{if(!this.hidden && epoch===this.epoch)this.setData({busy:false});}
  },
  async draw(descriptor:ShareCardDescriptor,media:Array<{photoId:string;url:string}>){
    const images=new Map<string,WechatMiniprogram.GetImageInfoSuccessCallbackResult>();for(const item of media)images.set(item.photoId,await imageInfo(item.url));
    const ctx=wx.createCanvasContext('storyCard',this);ctx.setFontSize(46);const titleLines=lines(ctx,descriptor.title,630);ctx.setFontSize(28);
    const chapterLines=descriptor.chapterTitle?lines(ctx,descriptor.chapterTitle,630):[];ctx.setFontSize(30);const paragraphLines=descriptor.paragraphs.flatMap(text=>[...lines(ctx,text,630),' ']);
    const height=Math.max(1050,190+titleLines.length*64+chapterLines.length*44+paragraphLines.length*48+descriptor.photos.length*360+180);
    if(height>3900)throw new Error('卡片排版过长，请减少文字或换行后重试');
    ctx.setFillStyle('#fbf8f1');ctx.fillRect(0,0,canvasWidth,height);ctx.setFillStyle('#4f7f6b');ctx.fillRect(58,70,72,6);ctx.setFillStyle('#2a2e2b');ctx.setTextAlign('left');
    let y=126;ctx.setFontSize(46);for(const line of titleLines){ctx.fillText(line,58,y);y+=64;}ctx.setFillStyle('#6a6e68');ctx.setFontSize(28);for(const line of chapterLines){ctx.fillText(line,58,y);y+=44;}y+=22;
    ctx.setFillStyle('#2a2e2b');ctx.setFontSize(30);for(const line of paragraphLines){ctx.fillText(line,58,y);y+=48;}
    for(const photo of descriptor.photos){const image=images.get(photo.photoId);if(!image||image.width<=0||image.height<=0)throw new Error('所选图片暂时无法读取');
      const scale=Math.min(634/image.width,320/image.height),width=image.width*scale,height=image.height*scale;
      ctx.drawImage(image.path,58+(634-width)/2,y+(320-height)/2,width,height);y+=356;}
    ctx.setStrokeStyle('#ded6c8');ctx.setLineWidth(2);ctx.beginPath();ctx.moveTo(58,height-112);ctx.lineTo(692,height-112);ctx.stroke();ctx.setFillStyle('#6a6e68');ctx.setFontSize(24);ctx.fillText(descriptor.byline,58,height-62);
    await new Promise<void>(resolve=>ctx.draw(false,resolve));return canvasExport('storyCard',height,this);
  },
  async save(){if(this.data.busy || !this.selection || !this.descriptor)return;const epoch=this.epoch;this.setData({busy:true,notice:'保存前正在重新核对权限…'});
    try{const material=await storyShareCard.material(this.selection,this.descriptor.id);if(this.hidden || epoch!==this.epoch)return;const path=await this.draw(material.descriptor,material.media);
      if(this.hidden || epoch!==this.epoch)return;
      await new Promise<void>((resolve,reject)=>wx.saveImageToPhotosAlbum({filePath:path,success:()=>resolve(),fail:reject}));if(!this.hidden && epoch===this.epoch)this.setData({previewPath:path,notice:'图片已保存到相册。你可以自行选择发布到哪里。'});
    }catch(error){if(!this.hidden && epoch===this.epoch)this.setData({notice:'没有保存成功：'+(error instanceof Error?error.message:'请检查相册权限后重试')});}
    finally{if(!this.hidden && epoch===this.epoch)this.setData({busy:false});}
  },
  onShareAppMessage(){return sharingHome;},
});

export {lines};
