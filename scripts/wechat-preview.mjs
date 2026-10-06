import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {inspectDeploymentSource} from './deployment-source.mjs';
import {functionSources,configHashes,validateEvidence,sha256} from './release-evidence.mjs';

export function parseArgs(argv) {
  const result={execute:false};
  for(let index=0;index<argv.length;index++) {
    const key=argv[index];
    if(key==='--execute' && !result.execute) {result.execute=true;continue;}
    if(!['--env','--acceptance','--cloud-evidence','--output-dir'].includes(key)||result[key]||!argv[index+1]||argv[index+1].startsWith('--'))
      throw new Error('Use --env, --acceptance, --cloud-evidence, --output-dir and optional --execute');
    result[key]=argv[++index];
  }
  for(const key of ['--env','--acceptance','--cloud-evidence','--output-dir']) if(!result[key]) throw new Error(`Required: ${key}`);
  return result;
}
function runner(command,args,{cwd}) {
  return new Promise((resolve,reject)=>{
    const child=spawn(command,args,{cwd,stdio:['ignore','pipe','pipe'],timeout:180_000});
    let stdout='',stderr='';
    child.stdout.on('data',value=>{stdout+=value;});child.stderr.on('data',value=>{stderr+=value;});
    child.on('error',reject);child.on('close',exitCode=>resolve({exitCode,stdout,stderr}));
  });
}
export function validQr(bytes) {
  return bytes.length>1024 && (bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ||
    (bytes[0]===255&&bytes[1]===216&&bytes[2]===255&&bytes.at(-2)===255&&bytes.at(-1)===217));
}
export async function run(argv=process.argv.slice(2),options={}) {
  const args=parseArgs(argv),root=options.root||fileURLToPath(new URL('../',import.meta.url));
  const environment=args['--env'];
  const source=inspectDeploymentSource(root,environment);
  const configs=configHashes(root),functions=functionSources(root);
  const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
  const evidence=validateEvidence({source,environment,functions,configs,acceptance:read(args['--acceptance']),cloud:read(args['--cloud-evidence'])});
  if(!args.execute) return {mode:'check-only',source,environment,configs,...evidence};
  const output=path.resolve(args['--output-dir']);
  fs.mkdirSync(output,{recursive:true});
  if(fs.realpathSync(output)===fs.realpathSync(root)||fs.realpathSync(output).startsWith(fs.realpathSync(root)+path.sep))
    throw new Error('Preview artifacts must be outside the source worktree');
  const execute=options.runner||runner;
  const checked=await execute('npm',['run','check'],{cwd:root});
  if(checked.exitCode!==0) throw new Error('Typecheck or regression tests failed; preview stopped');
  const assertUnchanged=()=>{
    if(inspectDeploymentSource(root,environment).commit!==source.commit||JSON.stringify(configHashes(root))!==JSON.stringify(configs))
      throw new Error('Source or configuration changed during preview');
  };
  assertUnchanged();
  const dir=fs.mkdtempSync(path.join(output,`preview-${source.commit.slice(0,7)}-`));
  const qr=path.join(dir,'qr.jpg'),info=path.join(dir,'cli-info.json');
  const result=await execute(options.cli||'/Applications/wechatwebdevtools.app/Contents/MacOS/cli',
    ['preview','--project',root,'--qr-format','image','--qr-output',qr,'--info-output',info],{cwd:root});
  if(result.exitCode!==0||!/✔\s*preview\b/i.test(result.stdout+'\n'+result.stderr)||!fs.existsSync(qr)||!validQr(fs.readFileSync(qr)))
    throw new Error('CLI did not produce a successful preview and fresh QR image');
  assertUnchanged();
  const manifest={schemaVersion:1,createdAt:new Date().toISOString(),source,environment,configs,...evidence,
    checks:{command:'npm run check',passed:true},qr:{file:'qr.jpg',sha256:sha256(fs.readFileSync(qr))}};
  fs.writeFileSync(path.join(dir,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
  return {mode:'preview',directory:dir,...manifest};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) run().then(result=>console.log(JSON.stringify(result,null,2)))
  .catch(error=>{console.error(error.message);process.exitCode=1;});
