import { discardLocalPhotos, saveLocalPhoto } from './bookImages';

export interface PhoneReferencePhoto { id: string; path: string }

/** Keep reference imports separate from the manuscript; the generation tap uploads them. */
export async function choosePhoneReferencePhotos(count: number): Promise<PhoneReferencePhoto[]> {
  if (count < 1) return [];
  const picked = await new Promise<WechatMiniprogram.ChooseMediaSuccessCallbackResult>((resolve, reject) =>
    wx.chooseMedia({ count, mediaType: ['image'], sourceType: ['album', 'camera'], sizeType: ['compressed'], success: resolve, fail: reject }));
  const files = picked.tempFiles || [];
  if (files.some(file => file.size > 10 * 1024 * 1024)) throw new Error('照片超过 10MB，请选小一些的照片');
  const photos: PhoneReferencePhoto[] = [];
  try {
    for (const file of files) photos.push(await saveLocalPhoto(file.tempFilePath, 'import'));
  } catch (error) {
    await discardLocalPhotos(photos);
    throw error;
  }
  return photos;
}

export function isPhotoPickerCancel(error: unknown): boolean {
  return /cancel/i.test(String((error as { errMsg?: string; message?: string })?.errMsg || (error as Error)?.message || ''));
}
