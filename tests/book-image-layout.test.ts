import test from 'node:test';
import assert from 'node:assert/strict';
import {wrapImageText,layoutTextImages,MAX_LONG_HEIGHT,PAGE_HEIGHT} from '../miniprogram/services/bookImageLayout';
const measure=(text:string,size:number)=>Array.from(text).length*size;
test('wrapping preserves Unicode, spaces, empty paragraphs and trailing newlines',()=>{
  for(const text of ['', ' 🌿\n\n尾字\n', '段落'.repeat(100)+'\n\n', 'a\r\nb\t c']) {
    const lines=wrapImageText(text,32,measure);
    assert.equal(lines.map(l=>l.text+(l.newline?'\n':'')).join(''),text);
    assert.ok(lines.every(l=>measure(l.text,32)<=630));
  }
});
test('pagination retains every body character across many pages and keeps rows clear of footer',()=>{
  const body='中文🌿'.repeat(6000);
  const pages=layoutTextImages('我的书',[{title:'章节一',text:body}], 'pages',32,measure);
  assert.ok(pages.length>30);
  assert.equal(pages.flatMap(p=>p.rows).filter(r=>!r.heading).map(r=>r.text).join(''),body);
  for(const page of pages){assert.equal(page.height,PAGE_HEIGHT);assert.ok(page.rows.every(r=>r.y+r.fontSize<=PAGE_HEIGHT-106));}
});
test('long images stay bounded and overflow rejects the whole layout without truncation',()=>{
  for(let size=10;size<1200;size+=10){
    const pages=layoutTextImages('书名',[{title:'章节',text:'字'.repeat(size)}],'long',32,measure);
    assert.equal(pages.length,1);assert.ok(pages[0].height<=MAX_LONG_HEIGHT);
  }
  assert.throws(()=>layoutTextImages('书名',[{title:'章节',text:'字'.repeat(6000)}],'long',32,measure),/不会截断/);
});
test('larger font changes pagination without changing body content',()=>{
  const chapters=[{title:'章节',text:'字'.repeat(4000)}];
  const small=layoutTextImages('书',chapters,'pages',28,measure), large=layoutTextImages('书',chapters,'pages',36,measure);
  assert.ok(large.length>small.length);
  assert.throws(()=>layoutTextImages('书'.repeat(1000),chapters,'pages',32,measure),/书名过长/);
});
