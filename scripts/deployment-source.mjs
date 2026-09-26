import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/** Check locally before making any cloud mutation. Never print credentials. */
export function inspectDeploymentSource(project, environment) {
  const root = fs.realpathSync(project);
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  if (fs.realpathSync(git(['rev-parse', '--show-toplevel'])) !== root) {
    throw new Error('Deploy from the project worktree root.');
  }
  if (git(['status', '--porcelain', '--untracked-files=all'])) {
    throw new Error('Deployment requires a clean, committed worktree. Save changes before deploying.');
  }
  try {
    git(['merge-base', '--is-ancestor', 'main', 'HEAD']);
  } catch {
    throw new Error('Deployment source is behind or diverged from main; integrate main first.');
  }
  const config = JSON.parse(fs.readFileSync(path.join(root, 'project.config.json'), 'utf8'));
  const accounts = JSON.parse(fs.readFileSync(path.join(root, 'miniprogram/config/wechat-accounts.json'), 'utf8'));
  if (!accounts[config.appid] || accounts[config.appid] !== environment) {
    throw new Error('Deployment environment does not match the project AppID mapping.');
  }
  return { commit: git(['rev-parse', 'HEAD']), branch: git(['branch', '--show-current']), appId: config.appid };
}
