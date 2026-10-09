import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

function sources(dir: string): string[] {
  return fs.readdirSync(dir, {withFileTypes:true}).flatMap(entry => entry.isDirectory()
    ? sources(path.join(dir,entry.name)) : /\.[jt]s$/.test(entry.name) ? [path.join(dir,entry.name)] : []);
}
test('domain stays independent and services do not depend on page implementations', () => {
  for(const layer of ['domain','services','config']) for(const file of sources('miniprogram/'+layer)) {
    const ast=ts.createSourceFile(file,fs.readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true);
    function check(node: ts.Node) {
      let specifier: string | undefined, typeOnly=false;
      if(ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        specifier=node.moduleSpecifier.text; typeOnly=!!node.importClause?.isTypeOnly;
      } else if(ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        specifier=node.moduleSpecifier.text; typeOnly=node.isTypeOnly;
      } else if(ts.isCallExpression(node) && node.arguments.length && ts.isStringLiteral(node.arguments[0]) &&
        (node.expression.kind===ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression)&&node.expression.text==='require'))) specifier=node.arguments[0].text;
      if(specifier?.startsWith('.')) {
        const target=path.relative('miniprogram',path.resolve(path.dirname(file),specifier)).split(path.sep).join('/');
        assert.ok(!/^(pages|components)\//.test(target), `${file} must not import ${target}`);
        if(layer==='domain'||layer==='config') assert.ok(!/^(services|app(?:\.|$))/.test(target), `${file} must remain pure: ${target}`);
        if(target==='app') assert.ok(typeOnly, `${file} may import App types only`);
      }
      ts.forEachChild(node,check);
    }
    check(ast);
  }
});

test('client and deployed story domain rules must stay identical', () => {
  assert.equal(fs.readFileSync('miniprogram/domain/storyBookCore.js','utf8'),fs.readFileSync('cloudfunctions/storyBooks/core.js','utf8'),
    'Run node scripts/sync-story-core.mjs after changing shared story rules');
});

// 微信开发者工具会把 import() 当成运行时 URL 请求，Node 测试不会暴露此问题。
test('story lifecycle actions use packaged imports in the mini-program runtime', () => {
  const file = 'miniprogram/services/roomRepository.ts';
  const ast = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  function check(node: ts.Node) {
    if (ts.isCallExpression(node)) {
      assert.notEqual(node.expression.kind, ts.SyntaxKind.ImportKeyword,
        'roomRepository must use packaged static imports for story deletion and restoration');
    }
    ts.forEachChild(node, check);
  }
  check(ast);
});
