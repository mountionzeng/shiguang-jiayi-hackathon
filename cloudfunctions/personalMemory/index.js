const {resolveActiveIdentity} = require('./aiGuard');
const {createRepository} = require('./personalMemoryRepository');
const {createMemoryService} = require('./service');
const {createExtractor} = require('./extraction');
async function main(event = {}, dependencies = {}) {
  const cloud = dependencies.cloud || require('wx-server-sdk');
  cloud.init?.({env:cloud.DYNAMIC_CURRENT_ENV});
  const db = dependencies.db || cloud.database();
  const identity = await resolveActiveIdentity(db,cloud.getWXContext());
  // Reading/forgetting/disabling stays available even if model processing is off.
  if (event.action==='extract' && process.env.PERSONAL_MEMORY_ENABLED!=='true') return {status:'disabled'};
  const service = createMemoryService(createRepository(db),{extract:dependencies.extract || createExtractor(db,cloud)});
  return service(identity,event);
}
module.exports = {main};
