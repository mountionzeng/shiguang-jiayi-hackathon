import {readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

export function planWechatAccountConfiguration({project,accounts,appId,cloudEnvId}) {
  if(!/^wx[0-9a-f]{16}$/.test(appId||''))throw new Error('INVALID_WECHAT_APP_ID');
  if(!/^[a-z][a-z0-9-]{5,63}$/i.test(cloudEnvId||''))throw new Error('INVALID_CLOUD_ENV_ID');
  return {
    project:{...project,appid:appId},
    accounts:{...accounts,[appId]:cloudEnvId},
    retainedAppIds:Object.keys(accounts).filter(value=>value!==appId),
  };
}

export function renderWechatAccountModule(accounts) {
  return `'use strict';\n\n// Generated alongside wechat-accounts.json by \`npm run configure:wechat\`.\n// Keep this as a JavaScript module because the WeChat device runtime does not\n// load JSON files through CommonJS require().\nmodule.exports = Object.freeze(${JSON.stringify(accounts,null,2)});\n`;
}

function argument(name,args){const index=args.indexOf(name);return index>=0?args[index+1]:undefined;}
export async function run(args=process.argv.slice(2),root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..')) {
  const projectPath=path.join(root,'project.config.json'),accountsPath=path.join(root,'miniprogram/config/wechat-accounts.json'),accountsModulePath=path.join(root,'miniprogram/config/wechat-accounts.js');
  const [project,accounts]=await Promise.all([readFile(projectPath,'utf8').then(JSON.parse),readFile(accountsPath,'utf8').then(JSON.parse)]);
  const planned=planWechatAccountConfiguration({project,accounts,appId:argument('--appid',args),cloudEnvId:argument('--env',args)});
  if(!args.includes('--write')){process.stdout.write(JSON.stringify({mode:'preview',appid:planned.project.appid,cloudEnvId:planned.accounts[planned.project.appid],retainedAppIds:planned.retainedAppIds},null,2)+'\n');return planned;}
  await Promise.all([writeFile(projectPath,JSON.stringify(planned.project,null,2)+'\n'),writeFile(accountsPath,JSON.stringify(planned.accounts,null,2)+'\n'),writeFile(accountsModulePath,renderWechatAccountModule(planned.accounts))]);
  process.stdout.write('已更新账号配置；旧 AppID 映射已保留。请运行 npm run check。\n');
  return planned;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))run().catch(error=>{process.stderr.write(String(error?.message||error)+'\n');process.exitCode=1;});
