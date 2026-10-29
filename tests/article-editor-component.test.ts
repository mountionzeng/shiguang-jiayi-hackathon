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

test('Return creates a sized next paragraph and focuses its caret at the end', async () => {
  const definition = await loadComponentDefinition();
  const chapter = articleChapter({ id: 'chapter-return', title: '回车测试', memoryIds: [], content: [{ text: '第一句' }] });
  const context: any = {
    data: { current: chapter, pages: [], selected: '', focused: '', focusRequest: '', cursor: 0, scale: 0.4, note: '' },
    properties: { paths: {}, width: 360 },
    setData(patch: Record<string, unknown>) { Object.assign(this.data, patch); },
    triggerEvent() {},
  };
  Object.assign(context, definition.methods);
  definition.methods.render.call(context);
  const longLine = '新段落不能裁切'.repeat(8);
  definition.methods.change.call(context, {
    currentTarget: { dataset: { block: chapter.content[0].blockId } },
    detail: { value: `第一句\n${longLine}`, cursor: longLine.length + 4 },
  });

  const added = context.data.current.content[1];
  const module = context.data.current.layout.pages.flatMap((page: any) => page.modules)
    .find((item: any) => item.kind === 'text' && 'blockId' in item.bind && item.bind.blockId === added.blockId);
  assert.equal(context.data.focusRequest, added.blockId);
  assert.equal(context.data.cursor, longLine.length);
  assert.ok(module.rect.height > 130);
  assert.equal(context.data.pages.flatMap((page: any) => page.modules).find((item: any) => item.blockId === added.blockId).text, longLine);
});

test('a caret before the remaining text stays at that offset after Return splits the paragraph', async () => {
  const definition = await loadComponentDefinition();
  const chapter = articleChapter({ id: 'chapter-return-middle', title: '回车光标测试', memoryIds: [], content: [{ text: '前后文字' }] });
  const context: any = {
    data: { current: chapter, pages: [], selected: '', focused: '', focusRequest: '', cursor: 0, scale: 0.4, note: '' },
    properties: { paths: {}, width: 360 },
    setData(patch: Record<string, unknown>) { Object.assign(this.data, patch); },
    triggerEvent() {},
  };
  Object.assign(context, definition.methods);
  definition.methods.render.call(context);
  definition.methods.change.call(context, {
    currentTarget: { dataset: { block: chapter.content[0].blockId } },
    detail: { value: '前\n后文字', cursor: 2 },
  });

  assert.equal(context.data.cursor, 0, 'the new paragraph caret belongs before its remaining text');
});
