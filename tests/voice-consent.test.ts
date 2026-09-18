import test from 'node:test';
import assert from 'node:assert/strict';

test('voice consent is separate, session-scoped and fails closed',async context=>{
  const previous=(globalThis as any).wx;
  const decisions=[false,true];let modalCalls=0;
  (globalThis as any).wx={showModal:({success}:{success:(result:{confirm:boolean})=>void})=>{success({confirm:decisions[modalCalls++]});}};
  context.after(()=>{(globalThis as any).wx=previous;});
  const consent=await import('../miniprogram/services/voiceConsent');
  consent.clearVoiceConsent();
  assert.equal(await consent.requestVoiceConsent('account-a'),false);
  assert.equal(await consent.requestVoiceConsent('account-a'),false);
  assert.equal(modalCalls,1);
  consent.clearVoiceConsent();
  assert.equal(await consent.requestVoiceConsent('account-a'),true);
  assert.equal(modalCalls,2);
});

test('voice consent modal failure is denial and can be asked again',async context=>{
  const previous=(globalThis as any).wx;let calls=0;
  (globalThis as any).wx={showModal:({fail}:{fail:()=>void})=>{calls++;fail();}};
  context.after(()=>{(globalThis as any).wx=previous;});
  const consent=await import('../miniprogram/services/voiceConsent');
  consent.clearVoiceConsent();
  assert.equal(await consent.requestVoiceConsent('account-a'),false);
  assert.equal(await consent.requestVoiceConsent('account-a'),false);
  assert.equal(calls,2);
});

test('voice consent decisions never cross account scopes',async context=>{
  const previous=(globalThis as any).wx;let calls=0;
  (globalThis as any).wx={showModal:({success}:{success:(result:{confirm:boolean})=>void})=>{calls++;success({confirm:true});}};
  context.after(()=>{(globalThis as any).wx=previous;});
  const consent=await import('../miniprogram/services/voiceConsent');
  consent.clearVoiceConsent();
  assert.equal(await consent.requestVoiceConsent('account-a'),true);
  assert.equal(await consent.requestVoiceConsent('account-a'),true);
  assert.equal(await consent.requestVoiceConsent('account-b'),true);
  assert.equal(calls,2);
});
