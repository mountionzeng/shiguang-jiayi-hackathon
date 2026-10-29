import type { ManuscriptChapter } from '../domain/biography';
import { currentFamilyId } from './cloudRoomStorage';
import { isStoryImageReference, readLocalPhoto } from './bookImages';

export function chapterPhotoIds(chapter: ManuscriptChapter): string[] {
  return [...new Set([...chapter.content.flatMap(block => block.photoId ? [block.photoId] : []),
    ...Object.values(chapter.packageAssets || {}).map(asset => asset.photoId)])].filter(id => !isStoryImageReference(id));
}
export interface GalleryPhoto { photoId: string; url: string; uploaderLabel: string }
/** Read through the existing authorization endpoint; never fall back to cached content after a denial. */
export async function galleryPhotos(ids: string[], restricted = false): Promise<Record<string, GalleryPhoto>> {
  const result: Record<string, GalleryPhoto> = {};
  const unique = [...new Set(ids)];
  const familyId = wx.cloud && unique.length ? await currentFamilyId() : '';
  for (let offset = 0; offset < unique.length; offset += 9) {
    const batch = unique.slice(offset, offset + 9);
    let photos: Array<{photoId: string; status: string; url?: string; uploaderLabel?: string}> = [];
    if (wx.cloud) {
      const response = await wx.cloud.callFunction({name:'photoAccess',data:{action:'read',familyId,photoIds:batch,variant:'display',purpose:'view'}});
      photos = (response.result as {photos?: typeof photos})?.photos || [];
    }
    for (const id of batch) {
      const photo = photos.find(item => item.photoId === id);
      const denied = photo && ['forbidden','risky','deleted'].includes(photo.status);
      const url = photo?.status === 'ok' ? photo.url || '' : !restricted && !denied ? await readLocalPhoto(id) : '';
      result[id] = {photoId:id,url,uploaderLabel:photo?.status === 'ok' ? photo.uploaderLabel || '未记录' : '未记录'};
    }
  }
  return result;
}
