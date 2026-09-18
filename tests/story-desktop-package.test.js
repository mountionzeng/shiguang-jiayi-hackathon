const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

test('desktop authority packages transitive siblings and loads without the checkout', async () => {
  const { packageStoryDesktopAccess } = await import('../scripts/package-story-desktop-access.mjs');
  const result = packageStoryDesktopAccess();
  try {
    assert.ok(result.files.includes('storyBooks/exports.js'));
    assert.ok(result.files.includes('storyBooks/copyAssets.js'));
    assert.ok(result.files.includes('drinkingTimeBridge/core.js'));
    assert.ok(!result.files.includes('storyBooks/index.js'));
    assert.ok(!result.files.some(file => file.includes('node_modules') || file.includes('.env')));
    const check = `
      const assert = require('node:assert/strict');
      const Module = require('node:module'), original = Module._load;
      Module._load = function(name, ...args) {
        if (name === 'wx-server-sdk') return {init(){}, database(){return {};}};
        return original.call(this, name, ...args);
      };
      delete process.env.STORY_DESKTOP_ACCESS_ENABLED;
      const {main} = require('./index.js');
      // Deferred card/media imports must also resolve in the isolated artifact.
      require('./modules/storyBooks/exports.js');
      require('./modules/storyBooks/copyAssets.js');
      main({}).then(result => assert.equal(result.statusCode, 404));
    `;
    execFileSync(process.execPath, ['-e', check], { cwd: result.output, env: { PATH: process.env.PATH }, stdio: 'pipe' });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(result.output, 'config.json'))).permissions.openapi, ['security.msgSecCheck']);
  } finally { fs.rmSync(path.dirname(result.output), { recursive: true, force: true }); }
});

test('packaging rejects missing, dynamic, escaping, and undeclared dependencies', async () => {
  const { packageStoryDesktopAccess } = await import('../scripts/package-story-desktop-access.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'story-package-test-'));
  const dir = path.join(root, 'storyDesktopAccess');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'package.json'), '{"dependencies":{}}');
  fs.writeFileSync(path.join(dir, 'config.json'), '{}');
  try {
    for (const source of ["require('./missing')", 'require(process.env.MODULE)', "require('undeclared-sdk')", "import('./module.js')"]) {
      fs.writeFileSync(path.join(dir, 'index.js'), source);
      assert.throws(() => packageStoryDesktopAccess(root));
    }
    fs.writeFileSync(path.join(dir, 'index.js'), "require('./escape.js')");
    fs.symlinkSync(__filename, path.join(dir, 'escape.js'));
    assert.throws(() => packageStoryDesktopAccess(root), /outside the cloud source boundary/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
