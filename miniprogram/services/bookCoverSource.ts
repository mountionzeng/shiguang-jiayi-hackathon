import type { BiographyDraft } from "../domain/biography";

/** A recipient's explicit choice takes priority over the received chapter cover. */
export function bookCoverSource(selectedImageId: string | undefined, draft?: BiographyDraft): string {
  if (selectedImageId) return selectedImageId;
  for (const chapter of draft?.chapters ?? []) {
    const photoId = chapter.packageCoverAssetId ? chapter.packageAssets?.[chapter.packageCoverAssetId]?.photoId : undefined;
    if (photoId) return photoId;
  }
  return "";
}
