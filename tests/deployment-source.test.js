import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { inspectDeploymentSource } from '../scripts/deployment-source.mjs';

test('deployment checks committed source, main ancestry and account environment', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deployment-source-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe', encoding: 'utf8' }).trim();
  git('init', '-b', 'main');
  git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
  fs.mkdirSync(path.join(root, 'miniprogram/config'), { recursive: true });
  fs.writeFileSync(path.join(root, 'project.config.json'), JSON.stringify({ appid: 'test-app' }));
  fs.writeFileSync(path.join(root, 'miniprogram/config/wechat-accounts.json'), JSON.stringify({ 'test-app': 'test-env' }));
  git('add', '.'); git('commit', '-m', 'test fixture');
  const first = git('rev-parse', 'HEAD');
  assert.equal(inspectDeploymentSource(root, 'test-env').commit, first);
  assert.throws(() => inspectDeploymentSource(root, 'wrong-env'), /does not match/);
  fs.writeFileSync(path.join(root, 'uncommitted.js'), 'pending');
  assert.throws(() => inspectDeploymentSource(root, 'test-env'), /clean, committed/);
  git('add', 'uncommitted.js'); git('commit', '-m', 'advance main');
  git('checkout', '-b', 'stale', first);
  assert.throws(() => inspectDeploymentSource(root, 'test-env'), /integrate main first/);
});
