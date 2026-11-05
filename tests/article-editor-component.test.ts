import test from 'node:test';
import assert from 'node:assert/strict';
import { articleChapter } from '../miniprogram/services/articleModules';

let componentDefinition: any;
async function loadComponentDefinition() {
  if (componentDefinition) return componentDefinition;
  const previous = (globalThis as any).Component;
  (globalThis as any).Component = (value: unknown) => { componentDefinition = value; };
  try { await import('../miniprogram/components/article-editor/article-editor'); }
  finally { (globalThis as any).Component = previous; }
  return componentDefinition;
}

test('typing updates layout geometry without resetting the native textarea value or caret', async () => {
  const definition = await loadComponentDefinition();
  const chapter = articleChapter({ id: 'chapter-editor', title: '长文测试', memoryIds: [], content: [{ text: '第一句' }] });
  const patches: Array<Record<string, unknown>> = [];
  const context: any = {
    data: { current: chapter, pages: [], selected: '', focused: '', focusRequest: '', cursor: 0, scale: 0.4, note: '' },
    properties: { paths: {}, width: 360 },
    setData(patch: Record<string, unknown>) { patches.push(patch); Object.assign(this.data, patch); },
    triggerEvent() {},
  };
  Object.assign(context, definition.methods);
  definition.methods.render.call(context);
  patches.length = 0;

  definition.methods.change.call(context, {
    currentTarget: { dataset: { block: chapter.content[0].blockId } },
    detail: { value: '第二句' + '文字'.repeat(5), cursor: 12 },
  });

  assert.ok(!patches.some(patch => Object.prototype.hasOwnProperty.call(patch, 'pages') || Object.keys(patch).some(key => /\.text$/.test(key))),
    'ordinary input must not set the pages array or textarea value');
  assert.equal(context.data.current.content[0].blockId, chapter.content[0].blockId);
  assert.equal(context.data.current.content[0].text, '第二句' + '文字'.repeat(5));
});

test('Return inserts a new module immediately after the source and focuses its beginning', async () => {
  const definition=await loadComponentDefinition();
  const chapter=articleChapter({id:'chapter-return',title:'',memoryIds:[],content:[{text:'first\nlast'},{text:'next block'}]});
  const patches:Array<Record<string,unknown>>=[];
  const context:any={data:{current:chapter,pages:[],scale:.4,textHeights:{}},properties:{paths:{},width:360},
    setData(patch:Record<string,unknown>,callback?:()=>void){patches.push(patch);Object.assign(this.data,patch);callback?.();},triggerEvent(){}};
  Object.assign(context,definition.methods);context.render();patches.length=0;
  const block=chapter.content[0].blockId;
  const previous=(globalThis as any).wx;let focus:()=>void=()=>{};
  (globalThis as any).wx={nextTick:(callback:()=>void)=>{focus=callback;}};
  try {context.change({currentTarget:{dataset:{block}},detail:{value:'first\n\nlast',cursor:7}});}
  finally {(globalThis as any).wx=previous;}
  assert.equal(context.data.focusRequest,'');focus();
  assert.deepEqual(context.data.current.content.map((b:any)=>b.text),['first\n','last','next block']);
  const newBlock=context.data.current.content[1].blockId;
  assert.equal(context.data.editingBlock,newBlock);assert.equal(context.data.caretCursor,0);
  assert.equal(context.data.focusRequest,newBlock);assert.equal(context.data.selectionCursor,0);
  assert.equal(context.data.current.content[0].blockId,block);
  context.change({currentTarget:{dataset:{block:newBlock}},detail:{value:'新last',cursor:1}});
  assert.equal(context.data.current.content[1].text,'新last');
  assert.equal(context.data.selectionCursor,-1);
});

test('native height changes patch geometry without replacing input, and stale measurements are ignored', async () => {
  const definition = await loadComponentDefinition();
  const chapter = articleChapter({id:'native-height',title:'',memoryIds:[],content:[{text:'文字'.repeat(80)}]});
  const patches: Array<Record<string,unknown>> = [];
  const context:any = {data:{current:chapter,pages:[],scale:.4,textHeights:{}},properties:{paths:{}},
    setData(patch:Record<string,unknown>) {patches.push(patch);Object.assign(this.data,patch);}};
  Object.assign(context,definition.methods);
  context.render();patches.length=0;
  const module=context.data.pages[0].modules[0];
  context.textLineChange({currentTarget:{dataset:{id:module.id,measure:module.measurementKey}},detail:{height:400}});
  assert.ok(patches.length);
  assert.ok(!patches.some(patch => 'pages' in patch || Object.keys(patch).some(key=>/\.text$/.test(key))));
  const measurement=context.data.textHeights[module.id];
  context.textLineChange({currentTarget:{dataset:{id:module.id,measure:'old-width-or-text'}},detail:{height:10}});
  assert.equal(context.data.textHeights[module.id],measurement);
});


async function caretEditor() {
  const definition = await loadComponentDefinition();
  const chapter = articleChapter({id:'caret-scroll',title:'',memoryIds:[],content:[{text:'开头，中间，最后一行'}]});
  const queries:Array<{selectors:string[];callback:(results:any[])=>void}>=[];
  const events:any[]=[];
  const context:any={data:{...structuredClone(definition.data),current:chapter,scale:.4},
    properties:{paths:{},keyboardHeight:300},
    setData(patch:any,callback?:()=>void){Object.assign(this.data,patch);callback?.();},
    triggerEvent(name:string,detail:any){events.push({name,detail});},
    createSelectorQuery(){const selectors:string[]=[];return {select(selector:string){selectors.push(selector);return this;},boundingClientRect(){return this;},exec(callback:any){queries.push({selectors,callback});}};}};
  Object.assign(context,definition.methods);context.render();
  return {context,chapter,queries,events,definition};
}

test('focused article measures the prefix at the native cursor, not the end of a long paragraph', async () => {
  const {context,chapter,queries,events}=await caretEditor();
  const previous=(globalThis as any).wx;
  (globalThis as any).wx={getSelectedTextRange:({success}:any)=>success({start:3,end:3})};
  try {context.beginEditing({currentTarget:{dataset:{block:chapter.content[0].blockId}}});}
  finally {(globalThis as any).wx=previous;}
  assert.equal(context.data.caretMeasureText,'开头，\u200b');
  const query=queries[queries.length - 1];
  assert.match(query.selectors[0],/^#article-input-text-/);
  query.callback([{top:400,height:120},{height:30.72}]);
  const event=events.find(item=>item.name==='caret');
  assert.equal(event.detail.chapterId,chapter.id);
  assert.equal(event.detail.top,400);
  assert.equal(event.detail.bottom,430.72);
});

test('Return measures the actual caret prefix, including earlier newlines', async () => {
  const {context,chapter,queries,events}=await caretEditor();
  const block=chapter.content[0].blockId;
  context.change({currentTarget:{dataset:{block}},detail:{value:'first\n\nlast',cursor:7}});
  assert.equal(context.data.editingBlock,block);
  assert.equal(context.data.caretMeasureText,'first\n\n\u200b');
  queries[queries.length-1].callback([{top:480,height:90},{height:61.44}]);
  assert.equal(events.filter(e=>e.name==='caret').slice(-1)[0].detail.bottom,541.44);
});

test('outdated caret geometry and delayed focus ranges cannot override newer typing or blur', async () => {
  const {context,chapter,queries,events}=await caretEditor();
  const block=chapter.content[0].blockId;
  const previous=(globalThis as any).wx;let focusRange:any;
  (globalThis as any).wx={getSelectedTextRange:({success}:any)=>{focusRange=success;}};
  try {context.beginEditing({currentTarget:{dataset:{block}}});}
  finally {(globalThis as any).wx=previous;}
  context.change({currentTarget:{dataset:{block}},detail:{value:'新输入的文字',cursor:6}});
  const first=queries[queries.length - 1];
  focusRange({start:0,end:0});
  assert.equal(context.data.caretCursor,6);
  context.change({currentTarget:{dataset:{block}},detail:{value:'继续输入的文字',cursor:7}});
  first.callback([{top:500,height:60},{height:60}]);
  assert.equal(events.filter(item=>item.name==='caret').length,0);
  context.finishEditing({currentTarget:{dataset:{block}}});
  queries[queries.length - 1].callback([{top:500,height:60},{height:60}]);
  assert.equal(events.filter(item=>item.name==='caret').length,0);
});
