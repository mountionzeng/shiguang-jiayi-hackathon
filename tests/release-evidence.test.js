import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {requiredFunctions,requiredFlows,functionSources,configHashes,compareCloudSnapshot,validateEvidence} from '../scripts/release-evidence.mjs';
import {run,parseArgs} from '../scripts/wechat-preview.mjs';

function fixture(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'release-evidence-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const root=path.join(dir,'repo'),snapshot=path.join(dir,'downloaded'),out=path.join(dir,'out');
  fs.mkdirSync(root);
  const write=(file,value)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,value);};
  const json=(file,value)=>write(file,JSON.stringify(value));
  const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:'pipe'}).trim();
  git('init','-b','main');git('config','user.name','Fixture');git('config','user.email','test@example.invalid');
  json(path.join(root,'project.config.json'),{appid:'test-app'});
  json(path.join(root,'miniprogram/config/wechat-accounts.json'),{'test-app':'test-env'});
  write(path.join(root,'miniprogram/config/runtime.ts'),'export const FLAG=false;');
  write(path.join(root,'miniprogram/config/wechat-accounts.js'),'module.exports={};');
  for(const name of requiredFunctions) {
    write(path.join(root,'cloudfunctions',name,'index.js'),'exports.main=()=>true;');
    write(path.join(snapshot,name,'index.js'),'exports.main=()=>true;');
  }
  git('add','.');git('commit','-m','fixture');
  const source={commit:git('rev-parse','HEAD'),appId:'test-app'};
  const configs=configHashes(root);
  const acceptance={schemaVersion:1,...source,configs,environment:'test-env',completedAt:new Date().toISOString(),cleanedUp:true,visualChecked:true,flows:Object.fromEntries(requiredFlows.map(flow=>[flow,'passed']))};
  const cloud=compareCloudSnapshot(root,snapshot,'test-env');
  const acceptPath=path.join(dir,'acceptance.json'),cloudPath=path.join(dir,'cloud.json');
  json(acceptPath,acceptance);json(cloudPath,cloud);
  const args=['--execute','--env','test-env','--acceptance',acceptPath,'--cloud-evidence',cloudPath,'--output-dir',out];
  const runner=async(command,args)=>{
    if(command==='npm') return {exitCode:0,stdout:'tests passed',stderr:''};
    // Header fixture: actual image rendering belongs to DevTools acceptance, not this runner.
    const bytes=Buffer.alloc(2048);Buffer.from([255,216,255]).copy(bytes);bytes[2046]=255;bytes[2047]=217;
    fs.writeFileSync(args[args.indexOf('--qr-output')+1],bytes);
    return {exitCode:0,stdout:'✔ preview',stderr:''};
  };
  return {root,dir,snapshot,source,configs,acceptance,cloud,args,runner,json,acceptPath,cloudPath,functions:functionSources(root)};
}
test('preview records exact code/config/cloud/acceptance and a unique QR artifact',async t=>{
  const f=fixture(t);
  const first=await run(f.args,{root:f.root,runner:f.runner});
  const second=await run(f.args,{root:f.root,runner:f.runner});
  assert.notEqual(first.directory,second.directory);
  assert.equal(first.source.commit,f.source.commit);
  assert.equal(first.cloud.functions.storyBooks.digest,f.functions.storyBooks.digest);
  assert.equal(first.qr.sha256.length,64);
  assert.ok(fs.existsSync(path.join(first.directory,'manifest.json')));
  assert.equal(first.checks.passed,true);
});
test('stale, mismatched, incomplete or uncleaned acceptance cannot produce a preview',async t=>{
  const f=fixture(t);let calls=0;
  for(const patch of [{commit:'wrong'},{appId:'other'},{environment:'other'},{configs:{}},{completedAt:'2000-01-01'},
    {completedAt:'2099-01-01'},{cleanedUp:false},{visualChecked:false},{flows:{}}]) {
    f.json(f.acceptPath,{...f.acceptance,...patch});
    await assert.rejects(run(f.args,{root:f.root,runner:async()=>{calls++;}}));
  }
  assert.equal(calls,0);
});
test('missing, stale and mismatched cloud source evidence fails closed',t=>{
  const f=fixture(t);
  const input={source:f.source,environment:'test-env',acceptance:f.acceptance,functions:f.functions,configs:f.configs};
  for(const patch of [{environment:'other'},{verifiedAt:'2000-01-01'},{functions:{}},
    {functions:{...f.cloud.functions,storyBooks:{digest:'wrong',method:'download-compare'}}}]) {
    assert.throws(()=>validateEvidence({...input,cloud:{...f.cloud,...patch}}));
  }
  fs.writeFileSync(path.join(f.snapshot,'storyBooks/index.js'),'stale');
  assert.throws(()=>compareCloudSnapshot(f.root,f.snapshot,'test-env'),/differs/);
});
test('test failures, CLI false success, missing or invalid QR never write a manifest',async t=>{
  const f=fixture(t);
  for(const mode of ['tests','marker','missing','invalid']) {
    const runner=async(command,args)=>{
      if(command==='npm')return {exitCode:mode==='tests'?1:0,stdout:'',stderr:''};
      if(mode==='marker')return {exitCode:0,stdout:'',stderr:''};
      if(mode==='invalid')fs.writeFileSync(args[args.indexOf('--qr-output')+1],'old or broken image');
      return {exitCode:0,stdout:'✔ preview',stderr:''};
    };
    await assert.rejects(run(f.args,{root:f.root,runner}));
  }
  const out=path.join(f.dir,'out');
  assert.ok(fs.readdirSync(out).every(name=>!fs.existsSync(path.join(out,name,'manifest.json'))));
});
test('source drift during tests or preview blocks delivery',async t=>{
  const f=fixture(t);
  await assert.rejects(run(f.args,{root:f.root,runner:async(command,args)=>{
    const result=await f.runner(command,args);
    if(command!=='npm')fs.appendFileSync(path.join(f.root,'miniprogram/config/runtime.ts'),'// changed');
    return result;
  }}),/clean, committed|changed/);
});
test('preview arguments reject duplicates and unsupported flags',()=>{
  assert.throws(()=>parseArgs(['--execute','--execute']));
  assert.throws(()=>parseArgs(['--env','one','--env','two']));
  assert.throws(()=>parseArgs(['--skip-tests']));
});

test('cloud snapshot rejects extra business files and linked function directories',t=>{
  const f=fixture(t);
  const extra=path.join(f.snapshot,'storyBooks/obsolete.js');
  fs.writeFileSync(extra,'exports.old=true;');
  assert.throws(()=>compareCloudSnapshot(f.root,f.snapshot,'test-env'),/file set differs/);
  fs.unlinkSync(extra);
  fs.renameSync(path.join(f.snapshot,'storyBooks'),path.join(f.dir,'linked-function'));
  fs.symlinkSync(path.join(f.dir,'linked-function'),path.join(f.snapshot,'storyBooks'),'dir');
  assert.throws(()=>compareCloudSnapshot(f.root,f.snapshot,'test-env'),/file set differs/);
});
test('private configuration changed after acceptance blocks preview before any command',async t=>{
  const f=fixture(t);let calls=0;
  fs.writeFileSync(path.join(f.root,'.git/info/exclude'),'project.private.config.json\n');
  fs.writeFileSync(path.join(f.root,'project.private.config.json'),'{"setting":{"urlCheck":false}}');
  await assert.rejects(run(f.args,{root:f.root,runner:async()=>{calls++;}}),/configuration/);
  assert.equal(calls,0);
});
