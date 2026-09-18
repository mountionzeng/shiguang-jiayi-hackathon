const test=require('node:test');
const assert=require('node:assert/strict');
const {readFile}=require('node:fs/promises');
const path=require('node:path');

test('account configuration switches the project while retaining the old environment mapping',async()=>{
  const {planWechatAccountConfiguration}=await import('../scripts/configure-wechat-account.mjs');
  const result=planWechatAccountConfiguration({project:{appid:'wx1111111111111111',setting:{minified:true}},accounts:{wx1111111111111111:'old-cloud'},appId:'wx2222222222222222',cloudEnvId:'new-cloud'});
  assert.equal(result.project.appid,'wx2222222222222222');
  assert.equal(result.project.setting.minified,true);
  assert.deepEqual(result.accounts,{wx1111111111111111:'old-cloud',wx2222222222222222:'new-cloud'});
  assert.deepEqual(result.retainedAppIds,['wx1111111111111111']);
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
