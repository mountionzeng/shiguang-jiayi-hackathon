const test=require('node:test');
const assert=require('node:assert/strict');
test('TokenHub verification is offline by default and never logs credentials',async()=>{
  const {verify}=await import('../scripts/verify-tokenhub-text.mjs');let calls=0;
  const plan=await verify(['--request-id','test-stable-001'],{TOKENHUB_MODEL:'chosen-model',TOKENHUB_API_KEY:'private-test-key'},async()=>{calls++;throw new Error('must not call');});
  assert.equal(calls,0);assert.equal(plan.execute,false);assert.ok(!JSON.stringify(plan).includes('private-test-key'));
  await assert.rejects(verify(['--execute'],{},async()=>{calls++;}),/request-id/);
  assert.equal(calls,0);
});
test('failed verification retains safe diagnostics without retrying or exposing secrets',async()=>{
  const {verify}=await import('../scripts/verify-tokenhub-text.mjs');let calls=0;
  await assert.rejects(verify(['--request-id','test-failure-001','--execute'],{TOKENHUB_MODEL:'chosen-model',TOKENHUB_API_KEY:'private-test-key'},async()=>{
    calls++;
    return {ok:false,status:400,headers:{get:()=> 'provider-trace-001'},json:async()=>({error:{code:'invalid_parameter',message:'Unsupported parameter\nprivate-test-key sk-another-secret'},unrelated:'never retain this'})};
  }),error=>{
    assert.match(error.message,/invalid_parameter/);assert.match(error.message,/provider-trace-001/);
    assert.ok(!error.message.includes('private-test-key'));assert.ok(!error.message.includes('sk-another-secret'));assert.ok(!error.message.includes('never retain this'));
    return true;
  });
  assert.equal(calls,1);
});
test('authorized verification uses one request with the selected model and stable trace id',async()=>{
  const {verify}=await import('../scripts/verify-tokenhub-text.mjs');let calls=0;
  const result=await verify(['--request-id','test-stable-002','--execute'],{TOKENHUB_MODEL:'chosen-model',TOKENHUB_API_KEY:'private-test-key'},async(url,request)=>{
    calls++;assert.equal(url,'https://tokenhub.tencentmaas.com/v1/chat/completions');
    assert.equal(request.headers['X-Request-ID'],'test-stable-002');assert.equal(JSON.parse(request.body).model,'chosen-model');
    assert.equal(JSON.parse(request.body).max_tokens,512);
    return {ok:true,status:200,headers:{get:()=>null},json:async()=>({choices:[{message:{content:'{"ok":true}'}}]})};
  });assert.equal(calls,1);assert.equal(result.validated,true);
});
