const test = require("node:test");
const assert = require("node:assert/strict");
const { createTextChecker } = require("../cloudfunctions/storyImages/textCheck");

test("caption/art direction daily quota uses paid moderation on the same text", async () => {
  let sent;
  const checker = createTextChecker({
    msgSecCheck: async () => { throw { errCode: 45009 }; },
    paidCheck: async input => { sent = input.content; return {available:true, status:"pass"}; },
  });
  assert.equal((await checker.check({text:"一本浅绿封面的书",openid:"test"})).ok,true);
  assert.equal(sent,"一本浅绿封面的书");
});

test("WeChat pass or review never asks a second provider to change the verdict", async () => {
  for (const suggest of ["pass", "review", "risky"]) {
    let calls=0;
    const checker = createTextChecker({msgSecCheck:async()=>({result:{suggest}}),paidCheck:async()=>{calls++; return {available:true,status:"pass"};}});
    assert.equal((await checker.check({text:"test"})).ok,suggest==="pass");
    assert.equal(calls,0);
  }
});

test("paid rejection and unavailable or malformed responses remain closed", async () => {
  for (const verdict of [{available:true,status:"reject"},{available:false},{available:true,status:"unknown"},null]) {
    const checker=createTextChecker({msgSecCheck:async()=>{throw {errCode:45009};},paidCheck:async()=>verdict});
    const result=await checker.check({text:"test"});
    assert.equal(result.ok,false);
    if(verdict?.status==="reject") assert.equal(result.risky,true);
  }
});

test("paid service failure preserves original diagnostic without exposing text", async()=>{
  const checker=createTextChecker({msgSecCheck:async()=>{throw {errCode:45009};},paidCheck:async()=>{throw Error("private body");}});
  assert.deepEqual(await checker.check({text:"private text"}),{ok:false,errorCode:"45009"});
});

test("WeChat content rejection error 87014 never falls back", async()=>{
  let calls=0;
  const checker=createTextChecker({msgSecCheck:async()=>{throw {errCode:87014};},paidCheck:async()=>{calls++;return {available:true,status:"pass"};}});
  assert.deepEqual(await checker.check({text:"test"}),{ok:false,risky:true,errorCode:"TEXT_RISKY"});
  assert.equal(calls,0);
});
