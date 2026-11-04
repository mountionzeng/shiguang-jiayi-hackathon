const test = require('node:test');
const assert = require('node:assert/strict');
const {searchWritingSources,searchSources} = require('../cloudfunctions/chatInterview/writingSupport');
const chat = require('../cloudfunctions/chatInterview');
const result = (content='满城街道的公开资料[1]。',sources=[{index:1,name:'档案资料',url:'https://example.org/archive'}],finish_reason='stop') =>
  ({ok:true,json:async()=>({choices:[{finish_reason,message:{content,search_results:sources}}]})});

test('search sends only the reviewed query and accepts provider citations, never a client history',async()=>{
  let request;
  const value=await searchWritingSources({query:'河北满城街道',baseUrl:'https://tokenhub.tencentmaas.com/v1',apiKey:'test',model:'test',
    sourceText:'private photo text',conversation:['private'],fetcher:async(url,options)=>{request=JSON.parse(options.body);return result();}});
  assert.deepEqual(request.web_search_options,{enable:true,search_source:'lite'});
  assert.equal(request.messages[1].content,'河北满城街道');
  assert.doesNotMatch(JSON.stringify(request),/private/);
  assert.equal(value.sources[0].url,'https://example.org/archive');
});
test('search refuses unsupported, empty, truncated and invented citations without a paid retry',async()=>{
  for(const response of [{ok:false,status:403},result('查到了',[]),result('',undefined),result('部分',undefined,'length'),result('捏造引用[99]')]) {
    let calls=0;
    await assert.rejects(searchWritingSources({query:'满城',fetcher:async()=>{calls++;return response;}}),/WRITING_SEARCH_/);
    assert.equal(calls,1);
  }
  for(const query of ['',null,'x'.repeat(301)]) await assert.rejects(searchWritingSources({query,fetcher:()=>assert.fail()}),/QUERY_INVALID/);
});
test('citation links reject executable schemes, credentials, private addresses and duplicate indices',()=>{
  const urls=['javascript:alert(1)','file:///tmp/a','https://user:pass@example.org','http://127.0.0.1/a','http://192.168.0.1/a','http://localhost/a'];
  assert.equal(searchSources(urls.map((url,index)=>({index:index+1,url}))).length,0);
  assert.deepEqual(searchSources([{index:1,url:'https://example.org/a',name:'A'},{index:1,url:'https://example.org/b'},{index:2,url:'https://example.org/a'}]),[{index:1,url:'https://example.org/a',title:'A'}]);
});
test('writing guide handles unknowns, article author identity, current corrections and honest search boundaries',()=>{
  const messages=chat._test.buildOutputMessages({answer:'我没有概念',history:[],memoryType:'note'});
  const system=messages[0].content;
  assert.match(system,/一次只问一个/);assert.match(system,/主动给出/);assert.match(system,/属于原作者/);
  assert.match(system,/本轮立即调整/);assert.match(system,/没有联网工具/);
  assert.equal(chat._test.parseInterviewPrompt(JSON.stringify({dimension:'event',text:'甲'.repeat(500)}),'event').text.length,500);
});
