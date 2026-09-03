const CORE_COLLECTIONS = [
  "families",
  "family_members",
  "source_records",
  "memories",
  "biography_drafts",
  "generated_artifacts",
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
