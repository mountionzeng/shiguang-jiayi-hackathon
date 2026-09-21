const test=require('node:test');
const assert=require('node:assert/strict');
const {copyFile,mkdtemp,mkdir,readdir,readFile,rename,rm,unlink,writeFile}=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');

test('account configuration switches the project while retaining the old environment mapping',async()=>{
  const {planWechatAccountConfiguration}=await import('../scripts/configure-wechat-account.mjs');
  const result=planWechatAccountConfiguration({project:{appid:'wx1111111111111111',setting:{minified:true}},accounts:{wx1111111111111111:'old-cloud'},appId:'wx2222222222222222',cloudEnvId:'new-cloud'});
  assert.equal(result.project.appid,'wx2222222222222222');
  assert.equal(result.project.setting.minified,true);
  assert.deepEqual(result.accounts,{wx1111111111111111:'old-cloud',wx2222222222222222:'new-cloud'});
  assert.equal(result.cloudConfigured,true);
  assert.equal(result.previousProjectAppId,'wx1111111111111111');
  assert.equal(result.previousCloudEnvId,null);
  assert.equal(result.operation,'add');
  assert.deepEqual(result.expectedChangedFiles,['project.config.json','miniprogram/config/wechat-accounts.json','miniprogram/config/wechat-accounts.js']);
  assert.deepEqual(result.retainedAppIds,['wx1111111111111111']);
});

test('pending account configuration switches the project without reusing the old cloud environment',async()=>{
  const {planWechatAccountConfiguration}=await import('../scripts/configure-wechat-account.mjs');
  const result=planWechatAccountConfiguration({project:{appid:'wx1111111111111111'},accounts:{wx1111111111111111:'old-cloud',wx2222222222222222:'stale-cloud'},appId:'wx2222222222222222',pending:true});
  assert.equal(result.project.appid,'wx2222222222222222');
  assert.deepEqual(result.accounts,{wx1111111111111111:'old-cloud'});
  assert.equal(result.cloudConfigured,false);
  assert.equal(result.previousCloudEnvId,'stale-cloud');
  assert.equal(result.operation,'remove');
  assert.deepEqual(result.rollbackCommands,[
    'npm run configure:wechat -- --appid wx2222222222222222 --env stale-cloud --write',
    'npm run configure:wechat -- --appid wx1111111111111111 --env old-cloud --write',
  ]);
  assert.throws(()=>planWechatAccountConfiguration({project:{},accounts:{},appId:'wx2222222222222222',cloudEnvId:'new-cloud',pending:true}),/CONFLICTING_CLOUD_ENVIRONMENT_MODE/);
});

test('command parser rejects unknown, duplicate, missing, and secret-like arguments',async()=>{
  const {parseArguments}=await import('../scripts/configure-wechat-account.mjs');
  assert.deepEqual(parseArguments(['--appid','wx2222222222222222','--pending','--write','--json']),{appId:'wx2222222222222222',cloudEnvId:undefined,pending:true,write:true,json:true});
  const optionSecret='--secret=accidental-private-value';
  const positionalSecret='accidental-private-value';
  for(const args of [
    ['--appid','wx2222222222222222','--pending',optionSecret],
    ['--appid','wx2222222222222222',positionalSecret],
  ]){
    assert.throws(()=>parseArguments(args),error=>error.message==='UNKNOWN_ARGUMENT'&&!error.message.includes('private-value'));
  }
  assert.throws(()=>parseArguments(['--appid']),/MISSING_ARGUMENT_VALUE:--appid/);
  assert.throws(()=>parseArguments(['--pending','--pending']),/DUPLICATE_ARGUMENT:--pending/);
  assert.throws(()=>parseArguments(['--env','one-cloud','--env','two-cloud']),/DUPLICATE_ARGUMENT:--env/);
  assert.throws(()=>parseArguments(['--env']),/MISSING_ARGUMENT_VALUE:--env/);
  assert.throws(()=>parseArguments(['--write','--write']),/DUPLICATE_ARGUMENT:--write/);
  assert.throws(()=>parseArguments(['--json','--json']),/DUPLICATE_ARGUMENT:--json/);
});

test('pending command previews without writes, then updates all account files consistently',async()=>{
  const {renderWechatAccountModule,run}=await import('../scripts/configure-wechat-account.mjs');
  const root=await mkdtemp(path.join(os.tmpdir(),'shiguang-wechat-config-'));
  const configDirectory=path.join(root,'miniprogram/config');
  const projectPath=path.join(root,'project.config.json');
  const accountsPath=path.join(configDirectory,'wechat-accounts.json');
  const modulePath=path.join(configDirectory,'wechat-accounts.js');
  const project={appid:'wx1111111111111111',setting:{minified:true}};
  const accounts={wx1111111111111111:'old-cloud',wx2222222222222222:'stale-cloud'};
  const originalModule=renderWechatAccountModule(accounts);
  await mkdir(configDirectory,{recursive:true});
  await Promise.all([
    writeFile(projectPath,JSON.stringify(project,null,2)+'\n'),
    writeFile(accountsPath,JSON.stringify(accounts,null,2)+'\n'),
    writeFile(modulePath,originalModule),
  ]);
  try {
    let previewOutput='';
    const preview=await run(['--appid','wx2222222222222222','--pending'],root,{output:value=>{previewOutput+=value;}});
    assert.equal(preview.cloudConfigured,false);
    assert.deepEqual(JSON.parse(previewOutput),{
      mode:'preview',
      appid:'wx2222222222222222',
      previousProjectAppId:'wx1111111111111111',
      previousCloudEnvId:'stale-cloud',
      cloudEnvId:null,
      cloudConfigured:false,
      operation:'remove',
      changedFiles:['project.config.json','miniprogram/config/wechat-accounts.json','miniprogram/config/wechat-accounts.js'],
      retainedAppIds:['wx1111111111111111'],
      rollbackCommands:[
        'npm run configure:wechat -- --appid wx2222222222222222 --env stale-cloud --write',
        'npm run configure:wechat -- --appid wx1111111111111111 --env old-cloud --write',
      ],
      verified:false,
    });
    assert.deepEqual(await Promise.all([
      readFile(projectPath,'utf8'),readFile(accountsPath,'utf8'),readFile(modulePath,'utf8'),
    ]),[
      JSON.stringify(project,null,2)+'\n',JSON.stringify(accounts,null,2)+'\n',originalModule,
    ]);

    let writeOutput='';
    await run(['--appid','wx2222222222222222','--pending','--write','--json'],root,{output:value=>{writeOutput+=value;}});
    assert.equal(JSON.parse(writeOutput).verified,true);
    const [writtenProject,writtenAccounts,writtenModule]=await Promise.all([
      readFile(projectPath,'utf8').then(JSON.parse),
      readFile(accountsPath,'utf8').then(JSON.parse),
      readFile(modulePath,'utf8'),
    ]);
    assert.equal(writtenProject.appid,'wx2222222222222222');
    assert.equal(writtenProject.setting.minified,true);
    assert.deepEqual(writtenAccounts,{wx1111111111111111:'old-cloud'});
    assert.equal(writtenModule,renderWechatAccountModule(writtenAccounts));

    await writeFile(modulePath,renderWechatAccountModule({...writtenAccounts,wx2222222222222222:'stale-cloud'}));
    let repairOutput='';
    await run(['--appid','wx2222222222222222','--pending','--write','--json'],root,{output:value=>{repairOutput+=value;}});
    const repair=JSON.parse(repairOutput);
    assert.equal(repair.operation,'noop');
    assert.deepEqual(repair.changedFiles,['miniprogram/config/wechat-accounts.js']);
    assert.equal(repair.verified,true);
    assert.equal(await readFile(modulePath,'utf8'),renderWechatAccountModule(writtenAccounts));
  } finally {
    await rm(root,{recursive:true,force:true});
  }
});

test('write keeps the established human-readable success output unless JSON is requested',async()=>{
  const {renderWechatAccountModule,run}=await import('../scripts/configure-wechat-account.mjs');
  const root=await mkdtemp(path.join(os.tmpdir(),'shiguang-wechat-output-'));
  const configDirectory=path.join(root,'miniprogram/config');
  await mkdir(configDirectory,{recursive:true});
  await Promise.all([
    writeFile(path.join(root,'project.config.json'),JSON.stringify({appid:'wx1111111111111111'},null,2)+'\n'),
    writeFile(path.join(configDirectory,'wechat-accounts.json'),JSON.stringify({wx1111111111111111:'old-cloud'},null,2)+'\n'),
    writeFile(path.join(configDirectory,'wechat-accounts.js'),renderWechatAccountModule({wx1111111111111111:'old-cloud'})),
  ]);
  try {
    let output='';
    await run(['--appid','wx2222222222222222','--env','new-cloud','--write'],root,{output:value=>{output+=value;}});
    assert.equal(output,'已更新账号配置；旧 AppID 映射已保留。请运行 npm run check。\n');
  } finally {
    await rm(root,{recursive:true,force:true});
  }
});

test('run reports drift repairs without mutating the configuration plan',async()=>{
  const {renderWechatAccountModule,run}=await import('../scripts/configure-wechat-account.mjs');
  const root=await mkdtemp(path.join(os.tmpdir(),'shiguang-wechat-drift-'));
  const configDirectory=path.join(root,'miniprogram/config');
  const projectPath=path.join(root,'project.config.json');
  const accountsPath=path.join(configDirectory,'wechat-accounts.json');
  const modulePath=path.join(configDirectory,'wechat-accounts.js');
  const appId='wx2222222222222222';
  const accounts={[appId]:'new-cloud'};
  await mkdir(configDirectory,{recursive:true});
  await Promise.all([
    writeFile(projectPath,JSON.stringify({appid:appId},null,2)+'\n'),
    writeFile(accountsPath,JSON.stringify(accounts,null,2)+'\n'),
    writeFile(modulePath,renderWechatAccountModule({...accounts,wx1111111111111111:'stale-cloud'})),
  ]);
  try {
    let output='';
    const planned=await run(['--appid',appId,'--env','new-cloud'],root,{output:value=>{output+=value;}});
    assert.equal(planned.operation,'noop');
    assert.deepEqual(planned.expectedChangedFiles,[]);
    assert.deepEqual(JSON.parse(output).changedFiles,['miniprogram/config/wechat-accounts.js']);
  } finally {
    await rm(root,{recursive:true,force:true});
  }
});

test('configuration transaction waits for staging writes before cleaning up a failure',async()=>{
  const {replaceConfigurationFiles}=await import('../scripts/configure-wechat-account.mjs');
  const root=await mkdtemp(path.join(os.tmpdir(),'shiguang-wechat-stage-'));
  const paths=['first.json','second.json'].map(name=>path.join(root,name));
  await Promise.all(paths.map((file,index)=>writeFile(file,`old-${index}`)));
  const operations={readFile,rename,unlink,writeFile:async(file,content,options)=>{
    if(file.includes('first.json.')&&file.endsWith('.tmp'))throw new Error('INJECTED_STAGE_FAILURE');
    if(file.endsWith('.bak'))await new Promise(resolve=>setTimeout(resolve,10));
    return writeFile(file,content,options);
  }};
  try {
    await assert.rejects(
      replaceConfigurationFiles(paths.map((file,index)=>({path:file,content:`new-${index}`})),operations),
      /INJECTED_STAGE_FAILURE/,
    );
    assert.deepEqual((await readdir(root)).sort(),['first.json','second.json']);
    assert.deepEqual(await Promise.all(paths.map(file=>readFile(file,'utf8'))),['old-0','old-1']);
  } finally {
    await rm(root,{recursive:true,force:true});
  }
});

test('configuration transaction restores every original when one replacement fails',async()=>{
  const {replaceConfigurationFiles}=await import('../scripts/configure-wechat-account.mjs');
  const root=await mkdtemp(path.join(os.tmpdir(),'shiguang-wechat-rollback-'));
  const paths=['project.json','accounts.json','accounts.js'].map(name=>path.join(root,name));
  await Promise.all(paths.map((file,index)=>writeFile(file,`old-${index}`)));
  let failed=false;
  const operations={readFile,writeFile,unlink,rename:async(from,to)=>{
    if(!failed&&from.endsWith('.tmp')&&to===paths[1]){failed=true;throw new Error('INJECTED_RENAME_FAILURE');}
    return rename(from,to);
  }};
  try {
    await assert.rejects(
      replaceConfigurationFiles(paths.map((file,index)=>({path:file,content:`new-${index}`})),operations),
      /INJECTED_RENAME_FAILURE/,
    );
    assert.deepEqual(await Promise.all(paths.map(file=>readFile(file,'utf8'))),['old-0','old-1','old-2']);
  } finally {
    await rm(root,{recursive:true,force:true});
  }
});

test('configuration transaction rolls back after committed-content verification fails',async()=>{
  const {replaceConfigurationFiles}=await import('../scripts/configure-wechat-account.mjs');
  const root=await mkdtemp(path.join(os.tmpdir(),'shiguang-wechat-commit-verify-'));
  const target=path.join(root,'project.json');
  await writeFile(target,'old-content');
  let targetReads=0;
  const operations={
    writeFile,rename,unlink,
    readFile:async(file,encoding)=>{
      if(file===target){
        targetReads+=1;
        if(targetReads===3)return 'corrupted-content';
      }
      return readFile(file,encoding);
    },
  };
  try {
    await assert.rejects(
      replaceConfigurationFiles([{path:target,content:'new-content'}],operations),
      /CONFIGURATION_COMMIT_VERIFICATION_FAILED/,
    );
    assert.equal(await readFile(target,'utf8'),'old-content');
    assert.deepEqual(await readdir(root),['project.json']);
  } finally {
    await rm(root,{recursive:true,force:true});
  }
});

test('configuration transaction preserves a failed rollback backup and the original cause',async()=>{
  const {replaceConfigurationFiles}=await import('../scripts/configure-wechat-account.mjs');
  const root=await mkdtemp(path.join(os.tmpdir(),'shiguang-wechat-recovery-'));
  const paths=['project.json','accounts.json'].map(name=>path.join(root,name));
  await Promise.all(paths.map((file,index)=>writeFile(file,`old-${index}`)));
  let replacementFailed=false;
  const operations={readFile,writeFile,unlink,copyFile:async(from,to)=>{
    if(replacementFailed&&from.endsWith('.bak')&&to===paths[1])throw new Error('INJECTED_ROLLBACK_FAILURE');
    return copyFile(from,to);
  },rename:async(from,to)=>{
    if(!replacementFailed&&from.endsWith('.tmp')&&to===paths[1]){
      replacementFailed=true;
      throw new Error('INJECTED_REPLACEMENT_FAILURE');
    }
    return rename(from,to);
  }};
  try {
    let recoveryError;
    await assert.rejects(
      replaceConfigurationFiles(paths.map((file,index)=>({path:file,content:`new-${index}`})),operations),
      error=>{
        recoveryError=error;
        return /^CONFIGURATION_RECOVERY_REQUIRED:/.test(error.message);
      },
    );
    assert.equal(recoveryError.cause?.message,'INJECTED_REPLACEMENT_FAILURE');
    const remaining=await readdir(root);
    const backups=remaining.filter(name=>name.endsWith('.bak'));
    assert.equal(backups.length,2);
    const accountBackup=backups.find(name=>/^accounts\.json\..+\.bak$/.test(name));
    assert.ok(accountBackup);
    assert.equal(await readFile(path.join(root,accountBackup),'utf8'),'old-1');
    assert.equal(remaining.some(name=>name.endsWith('.tmp')),false);
    assert.equal(await readFile(paths[0],'utf8'),'old-0');
  } finally {
    await rm(root,{recursive:true,force:true});
  }
});

test('write lock rejects a second writer and stale transaction snapshots are never committed',async()=>{
  const {renderWechatAccountModule,replaceConfigurationFiles,run}=await import('../scripts/configure-wechat-account.mjs');
  const root=await mkdtemp(path.join(os.tmpdir(),'shiguang-wechat-contention-'));
  const configDirectory=path.join(root,'miniprogram/config');
  const projectPath=path.join(root,'project.config.json');
  await mkdir(configDirectory,{recursive:true});
  await Promise.all([
    writeFile(projectPath,JSON.stringify({appid:'wx1111111111111111'},null,2)+'\n'),
    writeFile(path.join(configDirectory,'wechat-accounts.json'),JSON.stringify({wx1111111111111111:'old-cloud'},null,2)+'\n'),
    writeFile(path.join(configDirectory,'wechat-accounts.js'),renderWechatAccountModule({wx1111111111111111:'old-cloud'})),
  ]);
  let releaseFirst;
  const firstMayContinue=new Promise(resolve=>{releaseFirst=resolve;});
  let firstHasLock;
  const lockAcquired=new Promise(resolve=>{firstHasLock=resolve;});
  try {
    const first=run(['--appid','wx2222222222222222','--env','first-cloud','--write'],root,{
      output:()=>{},
      afterLockAcquired:async()=>{firstHasLock();await firstMayContinue;},
    });
    await lockAcquired;
    await assert.rejects(
      run(['--appid','wx3333333333333333','--env','second-cloud','--write'],root,{output:()=>{}}),
      error=>error.message==='CONFIGURATION_WRITE_IN_PROGRESS'&&!error.message.includes('second-cloud'),
    );
    releaseFirst();
    await first;

    const snapshot=await readFile(projectPath,'utf8');
    await writeFile(projectPath,'externally-changed');
    await assert.rejects(
      replaceConfigurationFiles([{path:projectPath,content:'unwanted',original:snapshot}]),
      error=>error.message==='CONFIGURATION_STALE_SNAPSHOT'&&!error.message.includes('externally-changed'),
    );
    assert.equal(await readFile(projectPath,'utf8'),'externally-changed');
  } finally {
    releaseFirst?.();
    await rm(root,{recursive:true,force:true});
  }
});

test('next write recovers an interrupted transaction after one target replacement',async()=>{
  const {renderWechatAccountModule,run}=await import('../scripts/configure-wechat-account.mjs');
  const root=await mkdtemp(path.join(os.tmpdir(),'shiguang-wechat-interrupted-'));
  const configDirectory=path.join(root,'miniprogram/config');
  const targets=[
    path.join(root,'project.config.json'),
    path.join(configDirectory,'wechat-accounts.json'),
    path.join(configDirectory,'wechat-accounts.js'),
  ];
  const oldAccounts={wx1111111111111111:'old-cloud'};
  const originals=[JSON.stringify({appid:'wx1111111111111111'},null,2)+'\n',JSON.stringify(oldAccounts,null,2)+'\n',renderWechatAccountModule(oldAccounts)];
  const transactionId='configure-wechat-999-12345678-1234-1234-1234-123456789abc';
  await mkdir(configDirectory,{recursive:true});
  await Promise.all(targets.map((target,index)=>writeFile(target,originals[index])));
  const entries=targets.map((target,index)=>({
    path:target,
    stagedPath:`${target}.${transactionId}.tmp`,
    backupPath:`${target}.${transactionId}.bak`,
    replacement:`interrupted-${index}`,
  }));
  await Promise.all(entries.flatMap((entry,index)=>[
    writeFile(entry.backupPath,originals[index]),
    writeFile(entry.stagedPath,entry.replacement),
  ]));
  await rename(entries[0].stagedPath,entries[0].path);
  await writeFile(path.join(root,'.configure-wechat-account.transaction.json'),JSON.stringify({
    version:1,
    transactionId,
    entries:entries.map(({path,stagedPath,backupPath})=>({path,stagedPath,backupPath})),
  },null,2)+'\n');
  try {
    await run(['--appid','wx2222222222222222','--env','new-cloud','--write'],root,{output:()=>{}});
    const [project,accounts,moduleSource]=await Promise.all([
      readFile(targets[0],'utf8').then(JSON.parse),
      readFile(targets[1],'utf8').then(JSON.parse),
      readFile(targets[2],'utf8'),
    ]);
    assert.equal(project.appid,'wx2222222222222222');
    assert.deepEqual(accounts,{wx1111111111111111:'old-cloud',wx2222222222222222:'new-cloud'});
    assert.equal(moduleSource,renderWechatAccountModule(accounts));
    assert.equal((await readdir(root)).some(name=>name.includes(transactionId)||name.includes('transaction')),false);
  } finally {
    await rm(root,{recursive:true,force:true});
  }
});

test('account configuration rejects malformed identifiers and never accepts secret input',async()=>{
  const {planWechatAccountConfiguration}=await import('../scripts/configure-wechat-account.mjs');
  assert.throws(()=>planWechatAccountConfiguration({project:{},accounts:{},appId:'old-app',cloudEnvId:'cloud-a'}),/APP_ID/);
  assert.throws(()=>planWechatAccountConfiguration({project:{},accounts:{},appId:'wx2222222222222222',cloudEnvId:'../secret'}),/ENV_ID/);
});

test('account configuration renders the same safe mapping for the device runtime',async()=>{
  const {renderWechatAccountModule}=await import('../scripts/configure-wechat-account.mjs');
  const rendered=renderWechatAccountModule({wx1111111111111111:'old-cloud'});
  assert.match(rendered,/module\.exports = Object\.freeze/);
  assert.match(rendered,/"wx1111111111111111": "old-cloud"/);
  assert.doesNotMatch(rendered,/require\([^)]*\.json/);
});

test('mini-program runtime loads account mapping from a script module',async()=>{
  const runtime=await readFile(path.join(__dirname,'../miniprogram/config/runtime.ts'),'utf8');
  assert.doesNotMatch(runtime,/require\(["'][^"']+\.json["']\)/,'微信小程序真机不能把 JSON 配置当作运行时模块加载');
  assert.match(runtime,/require\(["']\.\/wechat-accounts\.js["']\)/);
});

test('enterprise mini-program uses only its own registered cloud environment',async()=>{
  const [project,accounts,runtimeAccounts]=await Promise.all([
    readFile(path.join(__dirname,'../project.config.json'),'utf8').then(JSON.parse),
    readFile(path.join(__dirname,'../miniprogram/config/wechat-accounts.json'),'utf8').then(JSON.parse),
    import('../miniprogram/config/wechat-accounts.js'),
  ]);
  assert.equal(project.appid,'wx86ae3e9d507ce52d');
  assert.equal(accounts[project.appid],'cloud1-d5ghzk30ve609f544');
  assert.notEqual(accounts[project.appid],accounts.wx6be512f0fe129b62);
  assert.deepEqual(runtimeAccounts.default,accounts);
});
