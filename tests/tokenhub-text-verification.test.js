const test=require('node:test');
const assert=require('node:assert/strict');
test('TokenHub verification is offline by default and never logs credentials',async()=>{
  const {verify}=await import('../scripts/verify-tokenhub-text.mjs');let calls=0;
  const plan=await verify(['--request-id','test-stable-001'],{TOKENHUB_MODEL:'chosen-model',TOKENHUB_API_KEY:'private-test-key'},async()=>{calls++;throw new Error('must not call');});
  assert.equal(calls,0);assert.equal(plan.execute,false);assert.ok(!JSON.stringify(plan).includes('private-test-key'));
  await assert.rejects(verify(['--execute'],{},async()=>{calls++;}),/request-id/);
  assert.equal(calls,0);
});
test('authorized verification uses one request with the selected model and stable trace id',async()=>{
  const {verify}=await import('../scripts/verify-tokenhub-text.mjs');let calls=0;
  const result=await verify(['--request-id','test-stable-002','--execute'],{TOKENHUB_MODEL:'chosen-model',TOKENHUB_API_KEY:'private-test-key'},async(url,request)=>{
    calls++;assert.equal(url,'https://tokenhub.tencentmaas.com/v1/chat/completions');
    assert.equal(request.headers['X-Request-ID'],'test-stable-002');assert.equal(JSON.parse(request.body).model,'chosen-model');
    return {ok:true,status:200,headers:{get:()=>null},json:async()=>({choices:[{message:{content:'{"ok":true}'}}]})};
  });assert.equal(calls,1);assert.equal(result.validated,true);
});
