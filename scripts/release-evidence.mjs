import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

export const requiredFunctions=['getOpenId','recordAiConsent','storyBooks','chatInterview','organizeMemory','storyImages'];
export const requiredFlows=['book-read-write-restore','article-question','image-reference-and-layout','cover-and-spine'];
export const sha256=value=>crypto.createHash('sha256').update(value).digest('hex');
const git=(root,args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();

export function functionSources(root) {
  const tracked=git(root,['ls-files','-z','cloudfunctions']).split('\0');
  return Object.fromEntries(requiredFunctions.map(name=>{
    const prefix=`cloudfunctions/${name}/`;
    const files=tracked.filter(file=>file.startsWith(prefix) && /\.(js|json)$/.test(file) && !file.endsWith('/package-lock.json')).sort();
    if(!files.some(file=>file===prefix+'index.js')) throw new Error(`Missing cloud source: ${name}`);
    const hashes=Object.fromEntries(files.map(file=>{
      if(fs.lstatSync(path.join(root,file)).isSymbolicLink()) throw new Error('Cloud source symlinks are not supported');
      return [file.slice(prefix.length),sha256(fs.readFileSync(path.join(root,file)))];
    }));
    return [name,{digest:sha256(JSON.stringify(hashes)),files:hashes}];
  }));
}
export function configHashes(root) {
  const files=['project.config.json','miniprogram/config/runtime.ts','miniprogram/config/wechat-accounts.json','miniprogram/config/wechat-accounts.js'];
  if(fs.existsSync(path.join(root,'project.private.config.json'))) files.push('project.private.config.json');
  return Object.fromEntries(files.map(file=>[file,sha256(fs.readFileSync(path.join(root,file)))]));
}
function recent(value,now,label) {
  const time=Date.parse(value);
  if(!Number.isFinite(time)||time>now+60_000||now-time>24*60*60*1000) throw new Error(`${label} must be from the last 24 hours`);
}
export function validateEvidence({source,environment,acceptance,cloud,functions,configs,now=Date.now()}) {
  if(acceptance?.schemaVersion!==1 || acceptance.commit!==source.commit || acceptance.appId!==source.appId || acceptance.environment!==environment)
    throw new Error('Acceptance must match the exact commit, AppID and environment');
  recent(acceptance.completedAt,now,'Acceptance');
  if(!configs || !acceptance.configs || Object.keys(configs).length!==Object.keys(acceptance.configs).length ||
    !Object.entries(configs).every(([file,digest])=>acceptance.configs[file]===digest))
    throw new Error('Acceptance configuration must match the current configuration hashes');
  if(acceptance.cleanedUp!==true || acceptance.visualChecked!==true || !requiredFlows.every(flow=>acceptance.flows?.[flow]==='passed'))
    throw new Error('Complete all acceptance flows, visual checks and test-data cleanup first');
  if(cloud?.schemaVersion!==1 || cloud.environment!==environment || cloud.appId!==source.appId)
    throw new Error('Cloud evidence does not match the AppID and environment');
  recent(cloud.verifiedAt,now,'Cloud source verification');
  for(const name of requiredFunctions) {
    if(cloud.functions?.[name]?.digest!==functions[name].digest || cloud.functions[name].method!=='download-compare')
      throw new Error(`Cloud source evidence missing or mismatched: ${name}`);
  }
  return {
    acceptance:{commit:source.commit,configs,completedAt:acceptance.completedAt,cleanedUp:true,visualChecked:true,flows:Object.fromEntries(requiredFlows.map(flow=>[flow,'passed']))},
    cloud:{environment,appId:source.appId,verifiedAt:cloud.verifiedAt,functions:Object.fromEntries(requiredFunctions.map(name=>[name,{digest:functions[name].digest,method:'download-compare'}]))},
  };
}

/** Input is a freshly downloaded cloud snapshot, never a copy of the local source. */
export function compareCloudSnapshot(root,snapshot,environment) {
  const sources=functionSources(root);
  const appId=JSON.parse(fs.readFileSync(path.join(root,'project.config.json'),'utf8')).appid;
  const accounts=JSON.parse(fs.readFileSync(path.join(root,'miniprogram/config/wechat-accounts.json'),'utf8'));
  if(accounts[appId]!==environment) throw new Error('Snapshot environment does not match AppID');
  if(fs.realpathSync(snapshot)===fs.realpathSync(root)||fs.realpathSync(snapshot).startsWith(fs.realpathSync(root)+path.sep)) throw new Error('Use an external, downloaded snapshot');
  const snapshotFiles=(dir,prefix='')=>fs.readdirSync(dir,{withFileTypes:true}).flatMap(entry=>{
    if(entry.isSymbolicLink()) throw new Error('Downloaded source symlinks are not supported');
    if(entry.name==='node_modules') return [];
    const name=prefix+entry.name;
    return entry.isDirectory() ? snapshotFiles(path.join(dir,entry.name),name+'/')
      : /\.(js|json)$/.test(name)&&!name.endsWith('package-lock.json') ? [name] : [];
  });
  for(const [name,entry] of Object.entries(sources)) {
    const dir=path.join(snapshot,name);
    if(fs.lstatSync(dir).isSymbolicLink() || JSON.stringify(snapshotFiles(dir).sort())!==JSON.stringify(Object.keys(entry.files).sort()))
      throw new Error(`Downloaded source file set differs: ${name}`);
  }
  for(const [name,entry] of Object.entries(sources)) for(const [file,digest] of Object.entries(entry.files)) {
    const target=path.join(snapshot,name,file);
    if(!fs.existsSync(target)||fs.lstatSync(target).isSymbolicLink()||sha256(fs.readFileSync(target))!==digest)
      throw new Error(`Downloaded source differs: ${name}/${file}`);
  }
  return {schemaVersion:1,environment,appId,verifiedAt:new Date().toISOString(),
    functions:Object.fromEntries(requiredFunctions.map(name=>[name,{digest:sources[name].digest,method:'download-compare'}]))};
}

if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    const [snapshot,environment,output]=process.argv.slice(2);
    if(!snapshot||!environment||!output||process.argv.length!==5) throw new Error('Usage: node scripts/release-evidence.mjs SNAPSHOT_DIR ENV OUTPUT_JSON');
    const root=fileURLToPath(new URL('../',import.meta.url));
    const evidence=compareCloudSnapshot(root,path.resolve(snapshot),environment);
    fs.writeFileSync(output,JSON.stringify(evidence,null,2)+'\n',{flag:'wx'});
    console.log('Cloud source comparison recorded. Runtime settings and provider availability still require actual acceptance.');
  } catch(error) { console.error(error.message); process.exitCode=1; }
}
