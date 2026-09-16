/**
 * Reads the family's cloud photos through the photoAccess cloud function (problem nine),
 * which is the only place that checks who may read a photo. storyImages reads on behalf
 * of a user it has already verified, with a token only the two functions share.
 */
const PHOTO_STATUSES = ["ok", "not_uploaded", "deleted", "forbidden", "not_found", "too_large", "risky"];

function createPhotoReader({ callFunction, internalToken }) {
  async function read({ familyId, photoIds, variant, purpose, onBehalfOfOpenid }) {
    const response = await callFunction({
      name: "photoAccess",
      data: { action: "read", familyId, photoIds, variant, purpose, onBehalfOfOpenid, internalToken },
    });
    const result = response && response.result;
    if (!result || typeof result !== "object") {
      const error = new Error("PHOTO_ACCESS_MALFORMED");
      error.code = "PHOTO_ACCESS_MALFORMED";
      throw error;
    }
    if (result.error) {
      const error = new Error(String(result.error.message || result.error.code || "PHOTO_ACCESS_FAILED"));
      error.code = String(result.error.code || "PHOTO_ACCESS_FAILED");
      throw error;
    }
    if (!Array.isArray(result.photos)) {
      const error = new Error("PHOTO_ACCESS_MALFORMED");
      error.code = "PHOTO_ACCESS_MALFORMED";
      throw error;
    }
    // One entry per requested photo, in request order; anything missing or unknown is not found.
    const byId = new Map(result.photos.filter(photo => photo && typeof photo.photoId === "string").map(photo => [photo.photoId, photo]));
    return photoIds.map(photoId => {
      const photo = byId.get(photoId);
      if (!photo || !PHOTO_STATUSES.includes(photo.status)) return { photoId, status: "not_found" };
      return photo;
    });
  }
  return { read };
}

module.exports = { PHOTO_STATUSES, createPhotoReader };
