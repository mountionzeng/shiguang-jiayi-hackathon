import test from 'node:test';
import assert from 'node:assert/strict';
import { regressionFiles, groups } from '../scripts/check-regressions.mjs';
test('every historical regression group remains executable and missing files fail closed', () => {
  for(const group of Object.keys(groups)) assert.ok(regressionFiles(process.cwd(),group).length);
  assert.throws(()=>regressionFiles(process.cwd(),'typo'),/Unknown/);
  assert.throws(()=>regressionFiles('/nonexistent-regression-fixture'),/Missing/);
});
