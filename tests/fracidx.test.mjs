import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyBetween } from '../src/lib/fracidx.js';

test('generateKeyBetween(null, null) returns a valid first key', () => {
  const key = generateKeyBetween(null, null);
  assert.equal(typeof key, 'string');
  assert.ok(key.length > 0);
});

test('generateKeyBetween(a, null) sorts after a', () => {
  const a = generateKeyBetween(null, null);
  const after = generateKeyBetween(a, null);
  assert.ok(a < after);
});

test('generateKeyBetween(null, b) sorts before b', () => {
  const b = generateKeyBetween(null, null);
  const before = generateKeyBetween(null, b);
  assert.ok(before < b);
});

test('generateKeyBetween(a, b) sorts strictly between, including adjacent keys', () => {
  let a = generateKeyBetween(null, null);
  let b = generateKeyBetween(a, null);
  for (let i = 0; i < 50; i++) {
    const mid = generateKeyBetween(a, b);
    assert.ok(a < mid && mid < b, `expected ${a} < ${mid} < ${b}`);
    b = mid; // repeatedly insert immediately before b — the adjacent-key stress case
  }
});

test('keys compare correctly under plain lexicographic <', () => {
  const keys = [];
  let prev = null;
  for (let i = 0; i < 200; i++) {
    const next = generateKeyBetween(prev, null);
    keys.push(next);
    prev = next;
  }
  const sorted = [...keys].sort();
  assert.deepEqual(keys, sorted);
});

test('throws on invalid ordering (a >= b)', () => {
  const a = generateKeyBetween(null, null);
  assert.throws(() => generateKeyBetween(a, a));
});
