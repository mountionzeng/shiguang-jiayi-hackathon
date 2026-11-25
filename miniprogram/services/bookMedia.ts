import type { ManuscriptChapter } from '../domain/biography';
import { chapterPhotoIds } from './chapterLayoutView';
import { isStoryImageReference, readLocalPhotos, storyImageReferenceId } from './bookImages';
import { storyImageApi, type StoryImage } from './storyImageService';
import { measurePerformance } from './performanceLog';

/** One media load per book opening. Page code decides whether images block editing. */
export function loadBookMedia(bookId: string, chapters: ManuscriptChapter[], coverImageId?: string) {
  const localPhotoIds = chapters.flatMap(chapterPhotoIds).filter(id => !isStoryImageReference(id));
  const storyImageReferences = new Set(chapters.flatMap(chapter => chapter.content)
    .flatMap(item => item.photoId && isStoryImageReference(item.photoId) ? [item.photoId] : []));
  const backdropImageIds = new Set(chapters.flatMap(chapter => chapter.backdropImageId ? [chapter.backdropImageId] : []));
  const cloudImages = storyImageReferences.size || backdropImageIds.size || coverImageId
    ? measurePerformance('book.images', () => storyImageApi.listStoryImages(bookId)).then(list => list.images).catch(() => [] as StoryImage[])
    : Promise.resolve([] as StoryImage[]);
  const images = Promise.all([
    measurePerformance('book.photos', () => readLocalPhotos(localPhotoIds)),
    cloudImages,
  ]).then(([{ photoPaths, imageIds }, cloudImages]) => {
    // Unavailable URLs retain their opaque recoverable markers in the editor.
    cloudImages.forEach(image => {
      const referenceId = storyImageReferenceId(image.imageId);
      if (storyImageReferences.has(referenceId) && image.url) {
        photoPaths[referenceId] = image.url;
        imageIds[image.url] = referenceId;
      }
    });
    const backdropUrls = Object.fromEntries(cloudImages
      .filter(image => backdropImageIds.has(image.imageId) && image.url)
      .map(image => [image.imageId, image.url]));
    return { photoPaths, imageIds, backdropUrls };
  });
  return { images, cloudImages };
}
