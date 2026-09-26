import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const baseline = JSON.parse(fs.readFileSync(path.join(root, 'deploy/observed-cloud-baseline.json'), 'utf8'));
const drift = [];
for (const [name, entry] of Object.entries(baseline.functions)) {
  for (const [file, expected] of Object.entries(entry.files)) {
    const source = path.join(root, 'cloudfunctions', name, file);
    if (!fs.existsSync(source) || crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex') !== expected) drift.push(`${name}/${file}`);
  }
}
const dirty = git(['status', '--porcelain', '--untracked-files=all']);
console.log(JSON.stringify({ root, branch: git(['branch', '--show-current']), commit: git(['rev-parse', 'HEAD']),
  clean: !dirty, changedFiles: dirty ? dirty.split('\n').length : 0,
  observedCloudAt: baseline.observedAt, environment: baseline.environment, differsFromObservedCloud: drift,
  note: 'This checks the recorded cloud snapshot, not current live deployment or feature acceptance.' }, null, 2));
if (drift.length) process.exitCode = 1;
