import {newStoryId} from '../../../../services/storyRecords';
import {saveCurrentStoryId} from '../../../../services/storySelection';
import {copyRequestId,CopyTargetStory,storyCopies} from '../../../../services/storyCopies';
import {SharedChapter,storySharing} from '../../../../services/storySharing';

Page({
  data:{loading:false,busy:false,available:false,title:'',notice:'',chapters:[] as Array<SharedChapter&{checked:boolean}>,
    mode:'new' as 'new'|'append',copyTitle:'',targets:[] as CopyTargetStory[],targetStoryId:'',targetIndex:0,selectedTargetTitle:''},
  sourceFamilyId:'',sourceStoryId:'',sourceRevisionId:'',requestId:'',epoch:0,hidden:false,
  onLoad(options:{familyId?:string;storyId?:string}={}){this.sourceFamilyId=options.familyId || '';this.sourceStoryId=options.storyId || '';},
  onShow(){this.hidden=false;void this.refresh();},
  onHide(){this.hidden=true;this.epoch++;this.setData({available:false,title:'',chapters:[],targets:[],busy:false});},
  onUnload(){this.onHide();this.sourceFamilyId='';this.sourceStoryId='';this.sourceRevisionId='';this.requestId='';},
  async refresh(){
    const epoch=++this.epoch;this.setData({loading:true,available:false,title:'',chapters:[],targets:[],notice:''});
    try{const [source,targets]=await Promise.all([storySharing.read(this.sourceFamilyId,this.sourceStoryId),storyCopies.targets()]);
      if(this.hidden || epoch!==this.epoch)return;if(source.capabilities?.copy!==true)throw new Error('主人没有允许把这些章节收入你的故事');
      this.sourceRevisionId=source.revisionId;this.requestId='';
      this.setData({available:true,title:source.story.title,copyTitle:`我的${source.story.title}`.slice(0,40),targets,
        targetStoryId:targets[0]?.id || '',targetIndex:0,selectedTargetTitle:targets[0]?.title || '',chapters:source.chapters.map(chapter=>({...chapter,checked:true}))});
    }catch(error){if(!this.hidden && epoch===this.epoch)this.setData({notice:error instanceof Error?error.message:'暂时无法接收这份故事'});}
    finally{if(!this.hidden && epoch===this.epoch)this.setData({loading:false});}
  },
  invalidate(){this.requestId='';},
  chooseChapters(event:WechatMiniprogram.CustomEvent<{value:string[]}>){this.invalidate();this.setData({chapters:this.data.chapters.map(chapter=>({...chapter,checked:event.detail.value.includes(chapter.id)}))});},
  chooseMode(event:WechatMiniprogram.CustomEvent<{value:'new'|'append'}>){this.invalidate();this.setData({mode:event.detail.value});},
  enterTitle(event:WechatMiniprogram.Input){this.invalidate();this.setData({copyTitle:event.detail.value});},
  chooseTarget(event:WechatMiniprogram.CustomEvent<{value:string}>){const targetIndex=Number(event.detail.value),story=this.data.targets[targetIndex];if(!story)return;this.invalidate();this.setData({targetStoryId:story.id,targetIndex,selectedTargetTitle:story.title});},
  async receive(){
    if(!this.data.available || this.data.busy)return;const chapterIds=this.data.chapters.filter(chapter=>chapter.checked).map(chapter=>chapter.id);
    if(!chapterIds.length){this.setData({notice:'请至少选择一个章节。'});return;}
    let target:Parameters<typeof storyCopies.receive>[0]['target'];
    if(this.data.mode==='new'){
      const title=this.data.copyTitle.trim();if(!title){this.setData({notice:'请给自己的故事起个名字。'});return;}
      target={mode:'new',storyId:newStoryId(),title};
    }else{
      const story=this.data.targets.find(item=>item.id===this.data.targetStoryId);if(!story){this.setData({notice:'请选择要放入的故事。'});return;}
      target={mode:'append',storyId:story.id,expectedVersion:story.version,expectedRevisionId:story.currentRevisionId || ''};
    }
    if(!this.requestId)this.requestId=copyRequestId();const epoch=this.epoch;this.setData({busy:true,notice:'正在保存独立副本…'});
    try{const result=await storyCopies.receive({sourceFamilyId:this.sourceFamilyId,sourceStoryId:this.sourceStoryId,sourceRevisionId:this.sourceRevisionId,
      chapterIds,requestId:this.requestId,target});if(this.hidden || epoch!==this.epoch)return;
      saveCurrentStoryId(result.storyId);this.requestId='';this.setData({notice:result.alreadyReceived?'这份章节已经在你的故事里。':'已放进你的故事；以后可以继续补充自己的经历。'});
      wx.redirectTo({url:'/pages/book/book?storyId='+encodeURIComponent(result.storyId)});
    }catch(error){if(!this.hidden && epoch===this.epoch)this.setData({notice:(error instanceof Error?error.message:'保存没有完成')+'。可以直接重试，不会重复添加。'});}
    finally{if(!this.hidden && epoch===this.epoch)this.setData({busy:false});}
  },
});
