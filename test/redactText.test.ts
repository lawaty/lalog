import test from 'node:test';
import assert from 'node:assert/strict';
import { compileRedactPatterns, redactText } from '../src/capture/redactText';

test('compileRedactPatterns compiles valid patterns', () => {
  const pats = compileRedactPatterns(['TOKEN', 'KEY']);
  assert.equal(pats.length, 2);
  assert.ok(pats[0] instanceof RegExp);
  assert.ok(pats[1] instanceof RegExp);
});

test('compileRedactPatterns skips invalid regex', () => {
  const pats = compileRedactPatterns(['[invalid', 'VALID']);
  assert.equal(pats.length, 1);
});

test('redactText replaces matches case-insensitively', () => {
  const pats = compileRedactPatterns(['TOKEN', 'secret']);
  const result = redactText('my TOKEN and SECRET value', pats);
  assert.equal(result, 'my [REDACTED] and [REDACTED] value');
});

test('redactText handles global replacement', () => {
  const pats = compileRedactPatterns(['key']);
  const result = redactText('key1 key2 key3', pats);
  assert.equal(result, '[REDACTED]1 [REDACTED]2 [REDACTED]3');
});

test('redactText returns text unchanged when no patterns match', () => {
  const pats = compileRedactPatterns(['NOMATCH']);
  const result = redactText('hello world', pats);
  assert.equal(result, 'hello world');
});

test('redactText handles empty patterns array', () => {
  const result = redactText('hello world', []);
  assert.equal(result, 'hello world');
});
