import { FamilyRoomState } from '../domain/biography';
import { cachedAccountScope } from './cloudRoomStorage';
import { BookPerson } from './storySharing';

interface Entry { storyId:string; familyId:string; title:string; people:BookPerson[]; scope:string|undefined; at:number }
let entry:Entry|undefined;
export function stageBookPeople(state:FamilyRoomState|undefined,storyId:string) {
  entry=undefined;
  const story=state?.stories?.find(item=>item.id===storyId && !item.deletedAt);
  if(!state || !story)return;
  const ids=new Set(story.protagonistMemberIds);
  if(story.legacy?.memberId)ids.add(story.legacy.memberId);
  for(const memory of state.contributions)if(!memory.deletedAt && story.memoryIds.includes(memory.id)) {
    ids.add(memory.authorMemberId);
    for(const id of memory.relatedMemberIds || [])ids.add(id);
  }
  entry={storyId,familyId:story.familyId,title:story.title,scope:cachedAccountScope(),at:Date.now(),
    people:state.members.filter(member=>!member.deletedAt && ids.has(member.id)).map(member=>({
      id:member.id,name:member.name,relation:member.relation,avatarText:member.avatarText,isOwner:member.role==='owner',
    }))};
}
export function takeBookPeople(storyId:string):Entry|undefined {
  const value=entry;entry=undefined;
  return value?.storyId===storyId && value.scope && value.scope===cachedAccountScope() && Date.now()-value.at<30_000?value:undefined;
}
