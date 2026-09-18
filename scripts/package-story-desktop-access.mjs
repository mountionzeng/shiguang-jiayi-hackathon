import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const defaultRoot = fileURLToPath(new URL('../cloudfunctions/', import.meta.url));

// Only literal CommonJS dependencies are supported. Never upload a whole worktree
// (which could contain credentials, user data, or unrelated function changes).
export function packageStoryDesktopAccess(cloudRoot = defaultRoot) {
  const root = realpathSync(cloudRoot);
  const packageJson = readFileSync(path.join(root, 'storyDesktopAccess/package.json'), 'utf8');
  const configJson = readFileSync(path.join(root, 'storyDesktopAccess/config.json'), 'utf8');
  const dependencies = JSON.parse(packageJson).dependencies || {};
  const files = new Map();
  function visit(candidate) {
    const absolute = realpathSync(candidate);
    const relative = path.relative(root, absolute);
    if (relative.startsWith('..') || path.isAbsolute(relative) || !/\.(js|json)$/.test(relative)) {
      throw new Error('Dependency is outside the cloud source boundary or has an unsupported extension');
    }
    if (files.has(relative)) return;
    const source = readFileSync(absolute, 'utf8');
    files.set(relative, source);
    if (relative.endsWith('.json')) { JSON.parse(source); return; }
    const tree = ts.createSourceFile(relative, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    if (tree.parseDiagnostics.length) throw new Error(`Invalid JavaScript: ${relative}`);
    function walk(node) {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require') {
        if (node.arguments.length !== 1 || !ts.isStringLiteral(node.arguments[0])) {
          throw new Error(`Dynamic require is unsupported: ${relative}`);
        }
        const name = node.arguments[0].text;
        if (name.startsWith('.')) {
          const target = path.resolve(path.dirname(absolute), name);
          visit(path.extname(target) ? target : `${target}.js`);
        } else if (!isBuiltin(name) && !Object.hasOwn(dependencies, name)) {
          throw new Error(`Undeclared package dependency in ${relative}: ${name}`);
        }
      }
      if (ts.isImportDeclaration(node) || (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword)) {
        throw new Error(`ES imports are unsupported in this CommonJS package: ${relative}`);
      }
      ts.forEachChild(node, walk);
    }
    walk(tree);
  }
  // Resolve everything before producing any artifact; missing siblings fail locally.
  visit(path.join(root, 'storyDesktopAccess/index.js'));
  const output = path.join(mkdtempSync(path.join(tmpdir(), 'shiguang-desktop-package-')), 'storyDesktopAccess');
  mkdirSync(output);
  for (const [relative, source] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    const destination = path.join(output, 'modules', relative);
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, source);
  }
  writeFileSync(path.join(output, 'index.js'), "module.exports = require('./modules/storyDesktopAccess/index.js');\n");
  writeFileSync(path.join(output, 'package.json'), packageJson);
  writeFileSync(path.join(output, 'config.json'), configJson);
  return { output, files: [...files.keys()].sort() };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(packageStoryDesktopAccess(), null, 2));
}
