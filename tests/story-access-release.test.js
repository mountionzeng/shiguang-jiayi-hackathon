const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const json = name => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));

test('native sharing pages do not declare unsupported enableShareAppMessage config', () => {
  for (const page of ['invite', 'read', 'card']) assert.equal(Object.hasOwn(json(`miniprogram/packages/story-sharing/pages/${page}/index.json`), 'enableShareAppMessage'), false);
});

test('every identity/grant collection is bootstrapped and has client-deny rules', () => {
  const manifest = json('deploy/wechat-cloud.manifest.json');
  const rules = json('deploy/story-sharing/database.rules.json');
  const { CORE_COLLECTIONS } = require('../cloudfunctions/ensureCloudCollections/bootstrap');
  for (const name of ['story_principals', 'story_identity_aliases', 'story_principal_spaces', 'story_grants', 'story_invitations', 'story_invite_indexes', 'story_invite_rates', 'story_source_policies', 'story_copies', 'story_excerpt_operations', 'story_collaboration_operations', 'story_copy_requests', 'story_copy_edits', 'story_returns', 'story_return_indexes', 'story_desktop_grants', 'story_desktop_nonces', 'story_desktop_operations', 'story_copy_media', 'story_copy_assets']) {
    assert.ok(CORE_COLLECTIONS.includes(name), name);
    assert.ok(manifest.collections[name], name);
    assert.deepEqual(rules.collections[name], { read: false, write: false });
  }
  assert.deepEqual(rules.collections.user_accounts, { read: false, write: false }, 'identity bootstrap input must be server-only too');
  const storage = json('deploy/story-sharing/storage.rules.json');
  assert.deepEqual(storage.rule, { read: false, write: false });
  assert.equal(storage.freeTierCanaryFallback.platformPreset, 'creator-only');
  for (const control of ['cloud-function-created-object','random-128-bit-attempt-path','server-only-asset-record','authorization-recheck-before-temporary-url','five-minute-maximum-requested-url-ttl']) {
    assert.ok(storage.freeTierCanaryFallback.requiredServerControls.includes(control), control);
  }
});

test('release manifest records gated switches and applicable rule files, not secrets', () => {
  const entry = json('deploy/wechat-cloud.manifest.json').cloudFunctions.storyBooks;
  for (const name of ['STORY_ACCESS_ENABLED', 'STORY_ACCESS_RULES_READY', 'STORY_IDENTITY_BOOTSTRAP_APP_ID', 'STORY_ACCESS_CANARY_FAMILY_IDS', 'STORY_INVITATIONS_ENABLED', 'STORY_SHARED_MEDIA_ENABLED', 'STORY_SHARED_EDIT_ENABLED', 'STORY_COPY_RECEIVE_ENABLED', 'STORY_SHARE_CARD_ENABLED']) {
    assert.ok(entry.environmentVariables.includes(name), name);
  }
  assert.equal(entry.databaseRulesFile, 'deploy/story-sharing/database.rules.json');
  assert.equal(entry.storageRulesFile, 'deploy/story-sharing/storage.rules.json');
  assert.deepEqual(json('deploy/wechat-cloud.manifest.json').cloudFunctions.storyDesktopAccess.environmentVariables,
    ['STORY_DESKTOP_ACCESS_ENABLED','STORY_DESKTOP_AUTHORITY_SECRET','STORY_SHARE_CARD_ENABLED']);
});
