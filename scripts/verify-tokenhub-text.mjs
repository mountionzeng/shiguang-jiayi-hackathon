// Offline by default. --execute is reserved for an explicitly authorized paid test.
import {pathToFileURL} from 'node:url';
export async function verify(args, env = process.env, fetchImpl = globalThis.fetch) {
  let execute = false, requestId = '';
  for (let i=0;i<args.length;i++) {
    if (args[i]==='--execute' && !execute) execute=true;
    else if (args[i]==='--request-id' && !requestId) requestId=args[++i] || '';
    else throw new Error('Unknown or duplicate argument');
  }
  if (!/^[a-zA-Z0-9-]{8,100}$/.test(requestId)) throw new Error('Provide a stable --request-id (8–100 letters, digits or hyphens)');
  const model=env.TOKENHUB_MODEL || '';
  const plan={execute,requestId,model,endpoint:'https://tokenhub.tencentmaas.com/v1/chat/completions',hasApiKey:Boolean(env.TOKENHUB_API_KEY)};
  if (!execute) return plan;
  if (!model || !env.TOKENHUB_API_KEY) throw new Error('TOKENHUB_MODEL and TOKENHUB_API_KEY are required');
  const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),20000);const start=Date.now();
  try {
    const response=await fetchImpl(plan.endpoint,{method:'POST',signal:controller.signal,headers:{Authorization:'Bearer '+env.TOKENHUB_API_KEY,'Content-Type':'application/json','X-Request-ID':requestId},body:JSON.stringify({model,messages:[{role:'user',content:'请只输出 JSON：{"ok":true}。不要输出其他内容。'}]})});
    if (!response.ok) throw new Error('TokenHub HTTP '+response.status);
    const payload=await response.json();
    const content=payload?.choices?.[0]?.message?.content;
    if(typeof content!=='string' || JSON.parse(content).ok!==true) throw new Error('TokenHub response failed JSON validation');
    return {...plan,status:response.status,elapsedMs:Date.now()-start,providerRequestId:response.headers.get('x-request-id'),usage:payload.usage || null,validated:true};
  } finally {clearTimeout(timeout);}
}
if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(await verify(process.argv.slice(2)),null,2)); }
  catch (error) { console.error(error.name==='AbortError'?'Request timed out; verify provider logs before retrying':error.message);process.exitCode=1; }
}
