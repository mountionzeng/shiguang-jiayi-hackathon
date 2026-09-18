const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
test('audio deployment rules deny direct client access to sensitive records and works',()=>{
  const database=JSON.parse(fs.readFileSync('deploy/story-audio/database.rules.json','utf8'));
  for(const name of ['audio_operations','audio_works','voice_profiles'])assert.deepEqual(database.collections[name],{clientRead:false,clientWrite:false,serverOnly:true});
  const storage=JSON.parse(fs.readFileSync('deploy/story-audio/storage.rules.json','utf8'));
  assert.equal(storage.paths['story-audio/**'].clientRead,false);
});
