const CORE_COLLECTIONS = [
  // 家庭文档写入前的留底。刻意不带 familyId 字段（用 snapshotOfFamilyId），
  // 任何按 familyId 的清扫都扫不到它，快照因此能在它所防范的那次清空里幸存。
  "family_snapshots",
  "stories",
  "story_names",
  "story_operations",
  "story_principals",
  "story_identity_aliases",
  "story_principal_spaces",
  "story_grants",
  "story_source_policies",
  "story_copies",
  "story_excerpt_operations",
  "story_collaboration_operations",
  "story_copy_requests",
  "story_copy_edits",
  "story_returns",
  "story_return_indexes",
  "story_desktop_grants",
  "story_desktop_nonces",
  "story_desktop_operations",
  "story_copy_media",
  "story_copy_assets",
  "story_invitations",
  "story_invite_indexes",
  "story_invite_rates",
  "story_migration_items",
  "families",
  "family_members",
  "source_records",
  "memories",
  "biography_drafts",
  "generated_artifacts",
  "image_jobs",
  "story_images",
  "story_image_links",
  "story_image_job_links",
  "audio_operations",
  "voice_profiles",
  "audio_works",
  "photos",
  "photo_caption_logs",
  "user_accounts",
  "family_invitations",
  "family_access",
];

function isAuthorizedBootstrap(event, expectedToken) {
  return (
    typeof expectedToken === "string" &&
    expectedToken.length >= 24 &&
    typeof event?.bootstrapToken === "string" &&
    event.bootstrapToken === expectedToken
  );
}

function collectionAlreadyExists(error) {
  const message = String(error && error.errMsg ? error.errMsg : error);
  return (
    message.includes("collection already exists") ||
    message.includes("Collection already exists") ||
    message.includes("ResourceUnavailable.ResourceExist") ||
    message.includes("Table exist") ||
    message.includes("Table already exist") ||
    message.includes("DATABASE_COLLECTION_EXIST") ||
    message.includes("DATABASE_COLLECTION_ALREADY_EXIST")
  );
}

async function ensureCollections(db) {
  const results = [];

  for (const name of CORE_COLLECTIONS) {
    try {
      await db.createCollection(name);
      results.push({ name, status: "created" });
    } catch (error) {
      if (!collectionAlreadyExists(error)) throw error;
      results.push({ name, status: "existing" });
    }
  }

  return results;
}

module.exports = {
  CORE_COLLECTIONS,
  collectionAlreadyExists,
  ensureCollections,
  isAuthorizedBootstrap,
};
