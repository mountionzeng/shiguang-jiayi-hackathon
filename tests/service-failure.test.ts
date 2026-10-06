import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyServiceFailure, logServiceFailure } from '../miniprogram/services/serviceFailure';

test('only explicit missing-function evidence permits legacy fallback', () => {
  assert.equal(classifyServiceFailure({errCode: -501000}), 'unknown');
  assert.equal(classifyServiceFailure({errCode: -501000, errMsg: 'response size exceeded 1048576 bytes'}), 'response-too-large');
  assert.equal(classifyServiceFailure(new Error('document could not be found')), 'unknown');
  assert.equal(classifyServiceFailure({code: 'FUNCTION_NOT_FOUND'}), 'missing');
  assert.equal(classifyServiceFailure({errMsg: 'FunctionName parameter could not be found'}), 'missing');
  assert.equal(classifyServiceFailure({errCode: -504003}), 'timeout');
  assert.equal(classifyServiceFailure({code: 'PERMISSION_DENIED'}), 'permission');
  assert.equal(classifyServiceFailure({code: 'VERSION_CONFLICT'}), 'conflict');
});

test('diagnostics omit content and tolerate broken logging', t => {
  const rows: unknown[] = [];
  t.mock.method(console, 'warn', (...args: unknown[]) => { rows.push(args); });
  logServiceFailure('storyBooks', 'refresh', new Error('PRIVATE STORY: response size exceeded token=secret'));
  assert.match(JSON.stringify(rows), /response-too-large/);
  assert.doesNotMatch(JSON.stringify(rows), /PRIVATE|secret|token/);
  t.mock.method(console, 'warn', () => { throw new Error('logger unavailable'); });
  assert.doesNotThrow(() => logServiceFailure('chatInterview', 'ai', new Error('timeout')));
});
