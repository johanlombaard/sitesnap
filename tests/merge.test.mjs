import test from 'node:test';
import assert from 'node:assert/strict';
import {
  pickWinner,
  mergeRecords,
  merge,
  resolveTree,
  cascadeDelete,
  compactTombstones,
  clampedNow,
} from '../src/lib/merge.js';
import { generateKeyBetween } from '../src/lib/fracidx.js';

function record(overrides) {
  return {
    id: 'x',
    parentId: 'root',
    kind: 'folder',
    name: 'x',
    position: 'a0',
    updatedAt: 1,
    origin: 'device-a',
    deleted: false,
    ...overrides,
  };
}

function rootRecord() {
  return record({ id: 'root', parentId: null, name: '~' });
}

test('pickWinner: higher updatedAt wins', () => {
  const a = record({ updatedAt: 10 });
  const b = record({ updatedAt: 20 });
  assert.equal(pickWinner(a, b), b);
  assert.equal(pickWinner(b, a), b);
});

test('pickWinner: origin is the deterministic tiebreak on equal updatedAt', () => {
  const a = record({ updatedAt: 10, origin: 'device-a' });
  const b = record({ updatedAt: 10, origin: 'device-b' });
  assert.equal(pickWinner(a, b), b); // 'device-b' > 'device-a'
  assert.equal(pickWinner(b, a), b);
});

test('pickWinner: null on either side returns the other', () => {
  const a = record({});
  assert.equal(pickWinner(null, a), a);
  assert.equal(pickWinner(a, null), a);
});

test('mergeRecords: unions by id and keeps the winner per id', () => {
  const local = [record({ id: '1', updatedAt: 5, name: 'local-1' }), record({ id: '2', updatedAt: 5, name: 'local-2' })];
  const remote = [record({ id: '1', updatedAt: 9, name: 'remote-1' }), record({ id: '3', updatedAt: 5, name: 'remote-3' })];
  const merged = mergeRecords(local, remote);
  const byId = Object.fromEntries(merged.map((r) => [r.id, r]));
  assert.equal(byId['1'].name, 'remote-1'); // newer wins
  assert.equal(byId['2'].name, 'local-2'); // only on local
  assert.equal(byId['3'].name, 'remote-3'); // only on remote
});

test('clampedNow: never goes below highestSeen + 1', () => {
  const farFuture = Date.now() + 1000 * 60 * 60 * 2; // clock 2h fast
  const clamped = clampedNow(farFuture);
  assert.ok(clamped > farFuture);
});

test('clock clamp acceptance scenario: slow device still wins after a later edit', () => {
  // Device A has a clock 2 hours fast; its edit wins the first round.
  const fastDeviceNow = Date.now() + 2 * 60 * 60 * 1000;
  const bookmark = record({ id: 'bm', kind: 'bookmark', updatedAt: fastDeviceNow, origin: 'device-a', title: 'from A' });

  // Device B pulls, merges, and its highestSeen now reflects A's fast clock.
  const bLocal = [rootRecord(), record({ id: 'bm', kind: 'bookmark', updatedAt: 100, origin: 'device-b', title: 'from B (old)' })];
  const bMerged = mergeRecords(bLocal, [bookmark]);
  const highestSeen = Math.max(...bMerged.map((r) => r.updatedAt));
  assert.equal(highestSeen, fastDeviceNow);

  // Device B (real clock) edits later; clamp must still exceed A's timestamp.
  const bEditTime = clampedNow(highestSeen);
  assert.ok(bEditTime > fastDeviceNow);
  const bEdit = record({ id: 'bm', kind: 'bookmark', updatedAt: bEditTime, origin: 'device-b', title: 'from B (new)' });

  const finalMerge = mergeRecords(bMerged, [bEdit]);
  const winner = finalMerge.find((r) => r.id === 'bm');
  assert.equal(winner.title, 'from B (new)');
});

test('cascadeDelete: tombstones a folder and every descendant', () => {
  const records = [
    rootRecord(),
    record({ id: 'f1', parentId: 'root', name: 'f1' }),
    record({ id: 'f2', parentId: 'f1', name: 'f2' }),
    record({ id: 'bm1', parentId: 'f2', kind: 'bookmark', title: 'bm1' }),
    record({ id: 'bm2', parentId: 'root', kind: 'bookmark', title: 'bm2' }),
  ];
  cascadeDelete(records, 'f1', { deviceId: 'device-a', highestSeen: 5 });
  const byId = Object.fromEntries(records.map((r) => [r.id, r]));
  assert.equal(byId.f1.deleted, true);
  assert.equal(byId.f2.deleted, true);
  assert.equal(byId.bm1.deleted, true);
  assert.equal(byId.bm2.deleted, false); // sibling untouched
});

test('resolveTree: cycle test — A into B on one machine, B into A on another, both converge', () => {
  const base = () => [
    rootRecord(),
    record({ id: 'A', parentId: 'root', name: 'A', updatedAt: 1, origin: 'device-1' }),
    record({ id: 'B', parentId: 'root', name: 'B', updatedAt: 1, origin: 'device-1' }),
  ];

  // Machine 1 (offline): moves A into B.
  const m1 = base();
  m1.find((r) => r.id === 'A').parentId = 'B';
  m1.find((r) => r.id === 'A').updatedAt = 10;
  m1.find((r) => r.id === 'A').origin = 'device-1';

  // Machine 2 (offline): moves B into A.
  const m2 = base();
  m2.find((r) => r.id === 'B').parentId = 'A';
  m2.find((r) => r.id === 'B').updatedAt = 10;
  m2.find((r) => r.id === 'B').origin = 'device-2';

  // Both machines eventually merge the same union of writes and run the cycle-breaker.
  const merged = mergeRecords(m1, m2);
  resolveTree(merged, { deviceId: 'device-1', highestSeen: 10 });

  const byId = Object.fromEntries(merged.map((r) => [r.id, r]));
  const walkToRoot = (id) => {
    const seen = new Set();
    let cur = byId[id];
    while (cur.parentId != null) {
      assert.ok(!seen.has(cur.id), `cycle detected reaching root from ${id}`);
      seen.add(cur.id);
      cur = byId[cur.parentId];
      assert.ok(cur, `dead parent reached from ${id}`);
    }
    assert.equal(cur.id, 'root');
  };
  walkToRoot('A');
  walkToRoot('B');

  // Exactly one of A/B was displaced into __recovered (both can't keep the cyclic edge).
  const recovered = merged.find((r) => r.id === '__recovered');
  assert.ok(recovered, '__recovered folder should have been created');
  const displaced = [byId.A, byId.B].filter((r) => r.parentId === '__recovered');
  assert.equal(displaced.length, 1);
});

test('resolveTree: orphan (dead parent) is reparented to __recovered', () => {
  const records = [rootRecord(), record({ id: 'orphan', parentId: 'ghost', name: 'orphan' })];
  resolveTree(records, { deviceId: 'device-a', highestSeen: 5 });
  const orphan = records.find((r) => r.id === 'orphan');
  assert.equal(orphan.parentId, '__recovered');
});

test('resolveTree: a bookmark posing as a parent is reparented to __recovered', () => {
  const records = [
    rootRecord(),
    record({ id: 'bm', parentId: 'root', kind: 'bookmark', title: 'bm' }),
    record({ id: 'child', parentId: 'bm', name: 'child' }),
  ];
  resolveTree(records, { deviceId: 'device-a', highestSeen: 5 });
  const child = records.find((r) => r.id === 'child');
  assert.equal(child.parentId, '__recovered');
});

test('compactTombstones: drops tombstones older than 30 days, keeps recent ones', () => {
  const now = Date.now();
  const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
  const records = [
    rootRecord(),
    record({ id: 'old', deleted: true, updatedAt: now - THIRTY_DAYS - 1000 }),
    record({ id: 'recent', deleted: true, updatedAt: now - 1000 }),
    record({ id: 'live', deleted: false, updatedAt: now }),
  ];
  const result = compactTombstones(records, now);
  const ids = result.map((r) => r.id);
  assert.ok(!ids.includes('old'));
  assert.ok(ids.includes('recent'));
  assert.ok(ids.includes('live'));
});

test('merge(): whole-record LWW keeps parentId and position travelling together', () => {
  const local = {
    schema: 1,
    records: [rootRecord(), record({ id: 'f', parentId: 'root', position: 'a0', updatedAt: 5, origin: 'device-a' })],
  };
  const remote = {
    schema: 1,
    records: [rootRecord(), record({ id: 'f', parentId: 'root', position: generateKeyBetween('a0', null), updatedAt: 9, origin: 'device-b' })],
  };
  const result = merge(local, remote);
  const f = result.records.find((r) => r.id === 'f');
  assert.equal(f.updatedAt, 9);
  assert.equal(f.position, remote.records[1].position); // whole record from the winner, not a field mix
});
