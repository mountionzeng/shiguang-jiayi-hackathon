const cloud = require("wx-server-sdk");
const { ensureCollections, isAuthorizedBootstrap } = require("./bootstrap");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

async function main(event) {
  if (!isAuthorizedBootstrap(event, process.env.COLLECTION_BOOTSTRAP_TOKEN)) {
    throw new Error("COLLECTION_BOOTSTRAP_FORBIDDEN");
  }
  const collections = await ensureCollections(cloud.database());
  return { ok: true, collections };
}

module.exports = { main };
