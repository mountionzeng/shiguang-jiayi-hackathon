interface ConsentState {scope:string;decision?:boolean;pending?:Promise<boolean>}
let state:ConsentState|undefined;

export const VOICE_CONSENT_VERSION='voice-clone-v1';
export function clearVoiceConsent(){state=undefined;}

/** Voice cloning is a separate purpose from text AI and photo analysis. */
export async function requestVoiceConsent(accountScope:string):Promise<boolean>{
  if(!accountScope)return false;
  if(state?.scope!==accountScope)state={scope:accountScope};
  if(state.decision!==undefined)return state.decision;
  if(state.pending)return state.pending;
  const request=new Promise<boolean>(resolve=>wx.showModal({
    title:'允许制作“我的声音”？',
    content:'会把你这次录制的 5—15 秒单声道样本上传到微信云存储，并发送给腾讯云声音复刻服务，用来生成你主动制作的有声故事。声音样本不会用于文字 AI 或照片分析。你可以随时停用声音；样本删除和腾讯云音色删除会分别显示处理状态。不同意不会上传录音。',
    confirmText:'允许并录音',cancelText:'暂不使用',
    success:result=>{if(state?.scope===accountScope)state.decision=result.confirm;resolve(result.confirm);},
    fail:()=>resolve(false),
  }));
  state.pending=request;
  try{return await request;}finally{if(state?.scope===accountScope)state.pending=undefined;}
}
