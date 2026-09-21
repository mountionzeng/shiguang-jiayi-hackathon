import {randomUUID} from 'node:crypto';
import {copyFile,open,readFile,rename,unlink,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const CONFIGURATION_FILES=[
  'project.config.json',
  'miniprogram/config/wechat-accounts.json',
  'miniprogram/config/wechat-accounts.js',
];

function configureCommand(appId,cloudEnvId) {
  return `npm run configure:wechat -- --appid ${appId} ${cloudEnvId?`--env ${cloudEnvId}`:'--pending'} --write`;
}

export function planWechatAccountConfiguration({project,accounts,appId,cloudEnvId,pending=false}) {
  if(!/^wx[0-9a-f]{16}$/.test(appId||''))throw new Error('INVALID_WECHAT_APP_ID');
  if(pending&&cloudEnvId)throw new Error('CONFLICTING_CLOUD_ENVIRONMENT_MODE');
  if(!pending&&!/^[a-z][a-z0-9-]{5,63}$/i.test(cloudEnvId||''))throw new Error('INVALID_CLOUD_ENV_ID');
  const previousProjectAppId=project.appid;
  const previousCloudEnvId=accounts[appId];
  const nextAccounts={...accounts};
  if(pending)delete nextAccounts[appId];
  else nextAccounts[appId]=cloudEnvId;
  const nextCloudEnvId=nextAccounts[appId];
  const operation=previousCloudEnvId===nextCloudEnvId?'noop':nextCloudEnvId===undefined?'remove':previousCloudEnvId===undefined?'add':'replace';
  const expectedChangedFiles=[
    ...(previousProjectAppId===appId?[]:[CONFIGURATION_FILES[0]]),
    ...(operation==='noop'?[]:CONFIGURATION_FILES.slice(1)),
  ];
  const rollbackCommands=[configureCommand(appId,previousCloudEnvId)];
  if(previousProjectAppId&&previousProjectAppId!==appId)rollbackCommands.push(configureCommand(previousProjectAppId,accounts[previousProjectAppId]));
  return {
    project:{...project,appid:appId},
    accounts:nextAccounts,
    cloudConfigured:Boolean(nextAccounts[appId]),
    previousProjectAppId,
    previousCloudEnvId:previousCloudEnvId||null,
    operation,
    expectedChangedFiles,
    rollbackCommands,
    retainedAppIds:Object.keys(accounts).filter(value=>value!==appId),
  };
}

export function renderWechatAccountModule(accounts) {
  return `'use strict';\n\n// Generated alongside wechat-accounts.json by \`npm run configure:wechat\`.\n// Keep this as a JavaScript module because the WeChat device runtime does not\n// load JSON files through CommonJS require().\nmodule.exports = Object.freeze(${JSON.stringify(accounts,null,2)});\n`;
}

export function parseArguments(args) {
  const parsed={appId:undefined,cloudEnvId:undefined,pending:false,write:false,json:false};
  for(let index=0;index<args.length;index+=1){
    const token=args[index];
    if(token==='--appid'||token==='--env'){
      const key=token==='--appid'?'appId':'cloudEnvId';
      if(parsed[key]!==undefined)throw new Error(`DUPLICATE_ARGUMENT:${token}`);
      const value=args[index+1];
      if(!value||value.startsWith('--'))throw new Error(`MISSING_ARGUMENT_VALUE:${token}`);
      parsed[key]=value;
      index+=1;
      continue;
    }
    if(token==='--pending'||token==='--write'||token==='--json'){
      const key=token.slice(2);
      if(parsed[key])throw new Error(`DUPLICATE_ARGUMENT:${token}`);
      parsed[key]=true;
      continue;
    }
    throw new Error('UNKNOWN_ARGUMENT');
  }
  return parsed;
}

const defaultFileOperations={copyFile,open,readFile,rename,unlink,writeFile};
const LOCK_NAME='.configure-wechat-account.lock';
const JOURNAL_NAME='.configure-wechat-account.transaction.json';

async function syncFile(file,fileOperations=defaultFileOperations) {
  if(!fileOperations.open)return;
  const handle=await fileOperations.open(file,'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

async function syncDirectory(directory,fileOperations=defaultFileOperations) {
  if(!fileOperations.open)return;
  const handle=await fileOperations.open(directory,'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

async function removeIfPresent(file,fileOperations=defaultFileOperations) {
  try { await fileOperations.unlink(file); } catch(error) { if(error?.code!=='ENOENT')throw error; }
}

export async function recoverConfigurationTransaction(root,fileOperations=defaultFileOperations) {
  const journalPath=path.join(root,JOURNAL_NAME);
  let journal;
  try { journal=JSON.parse(await fileOperations.readFile(journalPath,'utf8')); }
  catch(error) { if(error?.code==='ENOENT')return false; throw new Error('CONFIGURATION_RECOVERY_FAILED'); }
  if(journal?.version!==1||!Array.isArray(journal.entries))throw new Error('CONFIGURATION_RECOVERY_FAILED');
  try {
    if(!/^configure-wechat-[0-9]+-[0-9a-f-]+$/.test(journal.transactionId||''))throw new Error('invalid journal');
    const allowedTargets=new Set(CONFIGURATION_FILES.map(name=>path.join(root,name)));
    for(const entry of journal.entries){
      if(typeof entry?.path!=='string'||typeof entry?.backupPath!=='string'||typeof entry?.stagedPath!=='string')throw new Error('invalid journal');
      if(!allowedTargets.has(entry.path)||entry.backupPath!==`${entry.path}.${journal.transactionId}.bak`||entry.stagedPath!==`${entry.path}.${journal.transactionId}.tmp`)throw new Error('invalid journal');
      await fileOperations.copyFile(entry.backupPath,entry.path);
      await syncFile(entry.path,fileOperations);
    }
    for(const entry of journal.entries)await removeIfPresent(entry.stagedPath,fileOperations);
    for(const entry of journal.entries)await removeIfPresent(entry.backupPath,fileOperations);
    await removeIfPresent(journalPath,fileOperations);
    await syncDirectory(root,fileOperations);
    return true;
  } catch {
    throw new Error('CONFIGURATION_RECOVERY_FAILED');
  }
}

async function withConfigurationLock(root,fileOperations,callback) {
  const lockPath=path.join(root,LOCK_NAME);
  const acquire=async()=>{
    try { await fileOperations.writeFile(lockPath,`${process.pid}\n`,{flag:'wx'}); }
    catch(error) {
      if(error?.code!=='EEXIST')throw new Error('CONFIGURATION_LOCK_FAILED');
      let owner;
      try { owner=Number((await fileOperations.readFile(lockPath,'utf8')).trim()); } catch { throw new Error('CONFIGURATION_WRITE_IN_PROGRESS'); }
      if(Number.isSafeInteger(owner)&&owner>0){
        try { process.kill(owner,0); throw new Error('CONFIGURATION_WRITE_IN_PROGRESS'); }
        catch(ownerError) { if(ownerError?.message==='CONFIGURATION_WRITE_IN_PROGRESS'||ownerError?.code==='EPERM')throw new Error('CONFIGURATION_WRITE_IN_PROGRESS'); }
      }
      await removeIfPresent(lockPath,fileOperations);
      try { await fileOperations.writeFile(lockPath,`${process.pid}\n`,{flag:'wx'}); }
      catch { throw new Error('CONFIGURATION_WRITE_IN_PROGRESS'); }
    }
  };
  await acquire();
  try {
    await syncFile(lockPath,fileOperations);
    await syncDirectory(root,fileOperations);
    return await callback();
  } finally {
    await removeIfPresent(lockPath,fileOperations).catch(()=>{});
    await syncDirectory(root,fileOperations).catch(()=>{});
  }
}

/** Stage and verify every file before replacing any target; restore all originals if replacement fails. */
export async function replaceConfigurationFiles(entries,fileOperations=defaultFileOperations,options={}) {
  if(entries.length===0)return;
  const root=options.root||path.dirname(entries[0].path);
  const journalPath=path.join(root,JOURNAL_NAME);
  const transactionId=`configure-wechat-${process.pid}-${randomUUID()}`;
  const prepared=await Promise.all(entries.map(async entry=>{
    const current=await fileOperations.readFile(entry.path,'utf8');
    if(entry.original!==undefined&&current!==entry.original)throw new Error('CONFIGURATION_STALE_SNAPSHOT');
    return {...entry,original:current,stagedPath:`${entry.path}.${transactionId}.tmp`,backupPath:`${entry.path}.${transactionId}.bak`};
  }));
  let preserveBackups=false;
  let commitStarted=false;
  try {
    const staging=await Promise.allSettled(prepared.flatMap(entry=>[
      fileOperations.writeFile(entry.stagedPath,entry.content,{flag:'wx'}),
      fileOperations.writeFile(entry.backupPath,entry.original,{flag:'wx'}),
    ]));
    const stagingFailure=staging.find(result=>result.status==='rejected');
    if(stagingFailure)throw stagingFailure.reason;
    await Promise.all(prepared.flatMap(entry=>[syncFile(entry.stagedPath,fileOperations),syncFile(entry.backupPath,fileOperations)]));
    const stagedContents=await Promise.all(prepared.map(entry=>fileOperations.readFile(entry.stagedPath,'utf8')));
    if(stagedContents.some((content,index)=>content!==prepared[index].content))throw new Error('CONFIGURATION_STAGE_VERIFICATION_FAILED');
    const currentContents=await Promise.all(prepared.map(entry=>fileOperations.readFile(entry.path,'utf8')));
    if(currentContents.some((content,index)=>content!==prepared[index].original))throw new Error('CONFIGURATION_STALE_SNAPSHOT');
    const journal=JSON.stringify({version:1,transactionId,entries:prepared.map(({path,stagedPath,backupPath})=>({path,stagedPath,backupPath}))},null,2)+'\n';
    await fileOperations.writeFile(journalPath,journal,{flag:'wx'});
    await syncFile(journalPath,fileOperations);
    await syncDirectory(root,fileOperations);
    commitStarted=true;
    for(const entry of prepared){await fileOperations.rename(entry.stagedPath,entry.path);await syncDirectory(path.dirname(entry.path),fileOperations);}
    const committedContents=await Promise.all(prepared.map(entry=>fileOperations.readFile(entry.path,'utf8')));
    if(committedContents.some((content,index)=>content!==prepared[index].content))throw new Error('CONFIGURATION_COMMIT_VERIFICATION_FAILED');
  } catch(error) {
    if(!commitStarted)throw error;
    // Copy, rather than rename, so every backup remains available if one
    // rollback step fails. The journal can then retry the entire recovery.
    const copy=fileOperations.copyFile||defaultFileOperations.copyFile;
    const rollback=await Promise.allSettled(prepared.map(async entry=>{
      await copy(entry.backupPath,entry.path);
      await syncFile(entry.path,fileOperations);
    }));
    const failedBackups=prepared.filter((_,index)=>rollback[index].status==='rejected').map(entry=>entry.backupPath);
    if(failedBackups.length){
      preserveBackups=true;
      throw new Error(`CONFIGURATION_RECOVERY_REQUIRED:${failedBackups.join(',')}`,{cause:error});
    }
    throw error;
  } finally {
    await Promise.allSettled(prepared.flatMap(entry=>[
      fileOperations.unlink(entry.stagedPath),
      ...(preserveBackups?[]:[fileOperations.unlink(entry.backupPath)]),
    ]));
    if(!preserveBackups)await removeIfPresent(journalPath,fileOperations);
  }
}

function resultFor(planned,mode,actualChangedFiles) {
  return {
    mode,
    appid:planned.project.appid,
    previousProjectAppId:planned.previousProjectAppId||null,
    previousCloudEnvId:planned.previousCloudEnvId,
    cloudEnvId:planned.accounts[planned.project.appid]||null,
    cloudConfigured:planned.cloudConfigured,
    operation:planned.operation,
    changedFiles:actualChangedFiles,
    retainedAppIds:planned.retainedAppIds,
    rollbackCommands:planned.rollbackCommands,
    verified:mode==='write',
  };
}

export async function run(args=process.argv.slice(2),root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),runtimeOptions={}) {
  const output=runtimeOptions.output||((value)=>process.stdout.write(value));
  const fileOperations=runtimeOptions.fileOperations||defaultFileOperations;
  const parsed=parseArguments(args);
  if(parsed.write)return withConfigurationLock(root,fileOperations,async()=>{
    if(runtimeOptions.afterLockAcquired)await runtimeOptions.afterLockAcquired();
    await recoverConfigurationTransaction(root,fileOperations);
    return runConfiguration(parsed,root,fileOperations,output);
  });
  return runConfiguration(parsed,root,fileOperations,output);
}

async function runConfiguration(parsed,root,fileOperations,output) {
  const projectPath=path.join(root,'project.config.json'),accountsPath=path.join(root,'miniprogram/config/wechat-accounts.json'),accountsModulePath=path.join(root,'miniprogram/config/wechat-accounts.js');
  const [projectSource,accountsSource,accountsModuleSource]=await Promise.all([
    fileOperations.readFile(projectPath,'utf8'),
    fileOperations.readFile(accountsPath,'utf8'),
    fileOperations.readFile(accountsModulePath,'utf8'),
  ]);
  const project=JSON.parse(projectSource),accounts=JSON.parse(accountsSource);
  const planned=planWechatAccountConfiguration({project,accounts,appId:parsed.appId,cloudEnvId:parsed.cloudEnvId,pending:parsed.pending});
  const contentByName={
    [CONFIGURATION_FILES[0]]:JSON.stringify(planned.project,null,2)+'\n',
    [CONFIGURATION_FILES[1]]:JSON.stringify(planned.accounts,null,2)+'\n',
    [CONFIGURATION_FILES[2]]:renderWechatAccountModule(planned.accounts),
  };
  const currentByName={
    [CONFIGURATION_FILES[0]]:projectSource,
    [CONFIGURATION_FILES[1]]:accountsSource,
    [CONFIGURATION_FILES[2]]:accountsModuleSource,
  };
  const actualChangedFiles=CONFIGURATION_FILES.filter(name=>currentByName[name]!==contentByName[name]);
  if(!parsed.write){output(JSON.stringify(resultFor(planned,'preview',actualChangedFiles),null,2)+'\n');return planned;}
  await replaceConfigurationFiles(actualChangedFiles.map(name=>({path:path.join(root,name),content:contentByName[name],original:currentByName[name]})),fileOperations,{root});
  const finalContents=await Promise.all(CONFIGURATION_FILES.map(name=>fileOperations.readFile(path.join(root,name),'utf8')));
  if(finalContents.some((content,index)=>content!==contentByName[CONFIGURATION_FILES[index]]))throw new Error('CONFIGURATION_FINAL_VERIFICATION_FAILED');
  output(parsed.json
    ? JSON.stringify(resultFor(planned,'write',actualChangedFiles),null,2)+'\n'
    : '已更新账号配置；旧 AppID 映射已保留。请运行 npm run check。\n');
  return planned;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))run().catch(error=>{process.stderr.write(String(error?.message||error)+'\n');process.exitCode=1;});
