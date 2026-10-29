import test from 'node:test';
import assert from 'node:assert/strict';
import {articleChapter,appendArticleText,changeArticleText,moveArticleModule,removeArticleModule,addArticlePhoto} from '../miniprogram/services/articleModules';
import {groupAccountActivity} from '../miniprogram/services/accountActivity';
const base=()=>articleChapter({id:'chapter-test',title:'纸船',memoryIds:[],content:[{text:'第一句'}]});
test('return creates distinct editable blocks, including duplicate and empty lines',()=>{
 const before=base(),id=before.content[0].blockId;
 const {chapter}=changeArticleText(before,id,'第一句\n第二句\n第二句\n');
 assert.deepEqual(chapter.content.map(b=>b.text),['第一句','第二句','第二句','']);
 assert.equal(new Set(chapter.content.map(b=>b.blockId)).size,4);
 assert.equal(chapter.content[0].blockId,id);assert.equal(chapter.content[1].parentBlockId,id);
 assert.equal(before.content.length,1);
});
test('each paragraph created by Return grows to fit wrapped text instead of clipping at the starter height',()=>{
 const before=base(),originalId=before.content[0].blockId,longLine='上下移动和光标定位'.repeat(8);
 const {chapter}=changeArticleText(before,originalId,`原文\n${longLine}`);
 const added=chapter.content[1],module=chapter.layout.pages.flatMap(page=>page.modules).find(item=>item.kind==='text'&&'blockId'in item.bind&&item.bind.blockId===added.blockId);
 if(!module||module.kind!=='text')throw new Error('expected the new paragraph to have a text module');
 assert.equal(chapter.content[0].blockId,originalId);
 assert.ok(module&&module.rect.height>130,'wrapped paragraph must be taller than the 130px starter box');
 assert.equal(module.contentHeight,module.rect.height);
 assert.equal(before.content.length,1,'the prior revision remains unchanged');
});
test('move and resize preserve content and clamp geometry to the page',()=>{
 const before=base(),id=before.layout.pages[0].modules[0].id;
 const moved=moveArticleModule(before,id,10000,-10000);assert.equal(moved.layout.pages[0].modules[0].rect.x,96);assert.equal(moved.layout.pages[0].modules[0].rect.y,0);
 const resized=moveArticleModule(moved,id,-10000,10000,true);assert.equal(resized.layout.pages[0].modules[0].rect.width,100);assert.equal(resized.layout.pages[0].modules[0].rect.height,1200);
 assert.deepEqual(resized.content,before.content);
});
test('photo can be added, resized and removed without changing old versions',()=>{
 const before=base(),next=addArticlePhoto(before,'photo-example');
 const image=next.layout.pages[0].modules.find(m=>m.kind==='image')!;
 assert.equal(next.content.length,2);assert.equal(before.content.length,1);
 const removed=removeArticleModule(next,image.id);assert.equal(removed.content.length,1);assert.equal(next.content.length,2);
});
test('people with the same name remain separate accounts',()=>{
 const event={id:'1',accountKey:'one',name:'小满',verified:true,at:'',kind:'发来文章',title:'故事',text:'',imageCount:0,changes:[],comparisonAvailable:true,storyId:'',revisionId:''};
 assert.equal(groupAccountActivity([event,{...event,id:'2',accountKey:'two'}]).length,2);
});

test('removing the last text leaves an editable blank beside remaining photos',()=>{
 const chapter=addArticlePhoto(base(),'photo-keep');
 const removed=removeArticleModule(chapter,chapter.layout.pages[0].modules[0].id);
 assert.ok(removed.content.some(b=>b.photoId==='photo-keep'));
 assert.ok(removed.content.some(b=>b.text===''));
 assert.ok(removed.layout.pages.some(p=>p.modules.some(m=>m.kind==='text')));
});

test('generated image keeps AI attribution in the chapter package',()=>{
 const next=addArticlePhoto(base(),'photo-ai-example',true);
 assert.equal(Object.values(next.packageAssets!)[0].aiGenerated,true);
 assert.equal(base().content.length,1);
});

test('typing grows ordinary text space without mutating the previous version',()=>{
 const before=base();
 const after=changeArticleText(before,before.content[0].blockId,'纸船与灯塔'.repeat(35)).chapter;
 assert.ok(after.layout.pages[0].modules[0].rect.height>before.layout.pages[0].modules[0].rect.height);
 assert.equal(before.content[0].text,'第一句');
});
test('typing preserves manually arranged image and text geometry',()=>{
 const initial=addArticlePhoto(base(),'photo-layout');
 const positioned=moveArticleModule(initial,initial.layout.pages[0].modules[1].id,20,20);
 const after=changeArticleText(positioned,positioned.content[0].blockId,'很长的文字'.repeat(40)).chapter;
 assert.deepEqual(after.layout,positioned.layout);
});

 test('AI text appends without replacing original blocks or imported layout',()=>{
 const before=base();before.layout.pages[0].modules[0].rect.x=64;
 const after=appendArticleText(before,'新的故事'.repeat(30));
 assert.deepEqual(after.content[0],before.content[0]);
 assert.deepEqual(after.layout.pages[0].modules[0],before.layout.pages[0].modules[0]);
 const modules=after.layout.pages.flatMap(p=>p.modules);
 assert.ok(modules[modules.length-1].rect.height>110);
 assert.equal(before.content.length,1);
 });
