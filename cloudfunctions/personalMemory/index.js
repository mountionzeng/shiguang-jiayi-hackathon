const {resolveActiveIdentity} = require('./aiGuard');
const {createRepository} = require('./personalMemoryRepository');
const {createMemoryService} = require('./service');
const {createExtractor} = require('./extraction');
async function main(event = {}, dependencies = {}) {
  if (!dependencies.__billingScope) {
    const billing = require("./computeBilling");
    const box = billing.createScope({
      operationType: "personalMemory",
      requestId: event && (event.computeRequestId || event.requestId),
      post: dependencies.computePost,
      holdStore: dependencies.holdStore,
      env: process.env,
      db: dependencies.db,
    });
    return billing.runScope(box, () => main(event, { ...dependencies, __billingScope: box }));
  }
  const cloud = dependencies.cloud || require('wx-server-sdk');
  cloud.init?.({env:cloud.DYNAMIC_CURRENT_ENV});
  const db = dependencies.db || cloud.database();
  const identity = await resolveActiveIdentity(db,cloud.getWXContext());
  require("./computeBilling").noteBillingIdentity(identity, db);
  // Reading/forgetting/disabling stays available even if model processing is off.
  if (event.action==='extract' && process.env.PERSONAL_MEMORY_ENABLED!=='true') return {status:'disabled'};
  const service = createMemoryService(createRepository(db),{extract:dependencies.extract || createExtractor(db,cloud)});
  return service(identity,event);
}
module.exports = {main};
