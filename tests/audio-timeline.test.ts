import test from 'node:test';
import assert from 'node:assert/strict';
import {splitNarration,currentCue,shiftCues,validateTimeline,readingLines} from '../miniprogram/domain/audioTimeline';
const {splitNarration:splitCloudNarration}=require('../cloudfunctions/storyAudio/narration') as {splitNarration:(value:string,maxCodePoints?:number)=>Array<{text:string;start:number;end:number}>};

test('long Chinese text splits at natural punctuation without losing emoji',()=>{
  const source='外婆笑着说：“回来就好。”🙂后来我们一起吃饭。'.repeat(12);
  const parts=splitNarration(source,60);
  assert.ok(parts.length>1);
  assert.equal(parts.map(part=>part.text).join(''),source);
  assert.ok(parts.every(part=>Array.from(part.text).length<=60));
  assert.ok(parts.every((part,index)=>index===0 || part.start===parts[index-1].end));
  assert.equal(parts.some(part=>part.text.includes('\ud83d') && !part.text.includes('🙂')),false);
});

test('text offsets count Unicode code points instead of UTF-16 surrogate halves',()=>{
  const parts=splitNarration('甲🙂乙。丙🙂丁。戊🙂己。',10);
  assert.equal(parts[0].start,0);
  assert.equal(parts[parts.length-1]?.end,12);
  assert.ok(parts.every((part,index)=>index===0||part.start===parts[index-1].end));
  assert.deepEqual(shiftCues([{text:'🙂乙',beginMs:0,endMs:400,start:0,end:2}],500,1)[0],{text:'🙂乙',beginMs:500,endMs:900,start:1,end:3});
});

test('mini-program and worker split the same fixed snapshot identically',()=>{
  const source=('开头🙂。中间一段没有句号但有很多文字，最后回家！\n').repeat(20);
  assert.deepEqual(splitNarration(source),splitCloudNarration(source).map(({text,start,end})=>({text,start,end})));
});

test('timeline uses provider times and includes segment offsets',()=>{
  const shifted=shiftCues([{text:'第一句',beginMs:0,endMs:800,start:0,end:3}],1200,10);
  assert.deepEqual(shifted,[{text:'第一句',beginMs:1200,endMs:2000,start:10,end:13}]);
  assert.equal(currentCue(shifted,1500)?.text,'第一句');
  assert.equal(currentCue(shifted,2100),undefined);
});

test('invalid or overlapping provider timestamps cannot drive animation',()=>{
  assert.equal(validateTimeline([{text:'一',beginMs:0,endMs:500,start:0,end:1},{text:'二',beginMs:400,endMs:800,start:1,end:2}]),false);
  assert.equal(validateTimeline([{text:'一',beginMs:0,endMs:500,start:0,end:1},{text:'二',beginMs:500,endMs:800,start:1,end:2}]),true);
});

test('word-level subtitles form readable sentences and preserve all original punctuation and emoji',()=>{
  const text='🙂你好。\n我们回家！';
  const cues=Array.from(text).flatMap((char,index)=>char==='\n'?[]:[{text:char,start:index,end:index+1,beginMs:index*100,endMs:(index+1)*100}]);
  const lines=readingLines(text,cues);
  assert.deepEqual(lines,[{text:'🙂你好。',cueIndex:0,endCueIndex:3},{text:'\n我们回家！',cueIndex:4,endCueIndex:8}]);
  assert.equal(lines.map(line=>line.text).join(''),text);
});

test('reading lines bound long unpunctuated passages without inventing subtitle times',()=>{
  const text='字'.repeat(100),cues=Array.from(text).map((char,index)=>({text:char,start:index,end:index+1,beginMs:index*100,endMs:(index+1)*100}));
  const lines=readingLines(text,cues);
  assert.equal(lines.length,3);
  assert.equal(lines.map(line=>line.text).join(''),text);
  assert.equal(lines[1].cueIndex,48);
  assert.equal(lines[2].endCueIndex,99);
});
