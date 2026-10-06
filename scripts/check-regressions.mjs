import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

export const groups = {
  cover: ['tests/book-frame-color.test.ts','tests/book-cover-cache.test.ts','tests/book-image-renderer.test.ts','tests/story-cover.test.js'],
  images: ['tests/reference-photos.test.ts','tests/story-images.test.js','tests/story-images-page.test.ts','tests/chapter-backdrop.test.ts','tests/chapter-illustrations.test.ts'],
  questions: ['tests/daily-question.test.js','tests/daily-question-client.test.ts','tests/runtime-config.test.ts','tests/interview-service.test.ts'],
  storage: ['tests/cloud-save-regression.test.ts','tests/story-command-recovery.test.ts','tests/service-failure.test.ts','tests/story-state-transport.test.ts','tests/room-storage.test.ts','tests/page-handlers.test.ts','tests/architecture-boundaries.test.ts'],
};
export function regressionFiles(root, group) {
  if(group && !Object.hasOwn(groups,group)) throw new Error('Unknown regression group');
  const files=[...new Set(Object.values(group ? {[group]:groups[group]} : groups).flat())];
  for(const file of files) if(!fs.existsSync(path.join(root,file))) throw new Error(`Missing regression: ${file}`);
  return files;
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const root=fileURLToPath(new URL('../',import.meta.url));
  const files=regressionFiles(root,process.argv[2]);
  const result=spawnSync('npm',['run','test:files','--',...files],{cwd:root,stdio:'inherit',shell:false});
  process.exitCode=result.status ?? 1;
}
