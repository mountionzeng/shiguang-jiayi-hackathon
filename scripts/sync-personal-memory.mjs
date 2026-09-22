import {readFileSync,writeFileSync} from 'node:fs';
const root=new URL('../',import.meta.url);
for(const name of ['aiGuard.js','httpFetch.js']) writeFileSync(new URL('cloudfunctions/personalMemory/'+name,root),readFileSync(new URL('cloudfunctions/chatInterview/'+name,root)));
for(const target of ['chatInterview','organizeMemory']) for(const name of ['personalMemoryCore.js','personalMemoryRepository.js','personalMemoryContext.js']) {
  writeFileSync(new URL('cloudfunctions/'+target+'/'+name,root),readFileSync(new URL('cloudfunctions/personalMemory/'+name,root)));
}
