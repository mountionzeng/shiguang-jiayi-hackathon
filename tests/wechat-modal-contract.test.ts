import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import ts from 'typescript';

test('native modal action labels respect WeChat’s four-character limit', () => {
  const errors: string[] = [];
  const scan = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) { scan(path); continue; }
      if (!path.endsWith('.ts')) continue;
      const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
      const labels = (node: ts.Node) => {
        if (ts.isStringLiteral(node) && Array.from(node.text).length > 4) {
          errors.push(`${path}: ${node.text}`);
        } else if (ts.isConditionalExpression(node)) { labels(node.whenTrue); labels(node.whenFalse); }
      };
      const visit = (node: ts.Node) => {
        if (ts.isPropertyAssignment(node) && /^(confirmText|cancelText)$/.test(node.name.getText(source))) labels(node.initializer);
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
  };
  scan('miniprogram');
  assert.deepEqual(errors, [], 'wx.showModal rejects oversized action labels before displaying a dialog');
});
