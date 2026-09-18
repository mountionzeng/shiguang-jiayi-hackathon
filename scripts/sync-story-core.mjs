import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const source = fileURLToPath(new URL('../miniprogram/domain/storyBookCore.js', import.meta.url));
const target = fileURLToPath(new URL('../cloudfunctions/storyBooks/core.js', import.meta.url));
mkdirSync(fileURLToPath(new URL('../cloudfunctions/storyBooks/', import.meta.url)), {recursive:true});
writeFileSync(target, readFileSync(source));
