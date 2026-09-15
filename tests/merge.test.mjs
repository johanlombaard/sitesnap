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
  normalizeLegacyRoot,
} from '../src/lib/merge.js';
import { generateKeyBetween } from '../src/lib/fracidx.js';

// No single root record — top-level items use parentId: null.
function record(overrides) {
  return {
    id: 'x',
    parentId: null,
    kind: 'folder',
    name: 'x',
    position: 'a0',
    updatedAt: 1,
    origin: 'device-a',
    deleted: false,
    ...overrides,
  };
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
  const bLocal = [record({ id: 'bm', kind: 'bookmark', updatedAt: 100, origin: 'device-b', title: 'from B (old)' })];
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
    record({ id: 'f1', parentId: null, name: 'f1' }),
    record({ id: 'f2', parentId: 'f1', name: 'f2' }),
    record({ id: 'bm1', parentId: 'f2', kind: 'bookmark', title: 'bm1' }),
    record({ id: 'bm2', parentId: null, kind: 'bookmark', title: 'bm2' }),
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
    record({ id: 'A', parentId: null, name: 'A', updatedAt: 1, origin: 'device-1' }),
    record({ id: 'B', parentId: null, name: 'B', updatedAt: 1, origin: 'device-1' }),
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
  const walkToTop = (id) => {
    const seen = new Set();
    let cur = byId[id];
    while (cur.parentId != null) {
      assert.ok(!seen.has(cur.id), `cycle detected reaching the top level from ${id}`);
      seen.add(cur.id);
      cur = byId[cur.parentId];
      assert.ok(cur, `dead parent reached from ${id}`);
    }
  };
  walkToTop('A');
  walkToTop('B');

  // Exactly one of A/B was displaced into __recovered (both can't keep the cyclic edge).
  const recovered = merged.find((r) => r.id === '__recovered');
  assert.ok(recovered, '__recovered folder should have been created');
  assert.equal(recovered.parentId, null); // top-level, since there is no single root
  const displaced = [byId.A, byId.B].filter((r) => r.parentId === '__recovered');
  assert.equal(displaced.length, 1);
});

test('resolveTree: orphan (dead parent) is reparented to __recovered', () => {
  const records = [record({ id: 'orphan', parentId: 'ghost', name: 'orphan' })];
  resolveTree(records, { deviceId: 'device-a', highestSeen: 5 });
  const orphan = records.find((r) => r.id === 'orphan');
  assert.equal(orphan.parentId, '__recovered');
});

test('resolveTree: a bookmark posing as a parent is reparented to __recovered', () => {
  const records = [
    record({ id: 'bm', parentId: null, kind: 'bookmark', title: 'bm' }),
    record({ id: 'child', parentId: 'bm', name: 'child' }),
  ];
  resolveTree(records, { deviceId: 'device-a', highestSeen: 5 });
  const child = records.find((r) => r.id === 'child');
  assert.equal(child.parentId, '__recovered');
});

test('resolveTree: multiple independent top-level folders are all valid (no single root required)', () => {
  const records = [
    record({ id: 'f1', parentId: null, name: 'f1' }),
    record({ id: 'f2', parentId: null, name: 'f2' }),
    record({ id: 'bm', parentId: 'f2', kind: 'bookmark', title: 'bm' }),
  ];
  resolveTree(records, { deviceId: 'device-a', highestSeen: 5 });
  const byId = Object.fromEntries(records.map((r) => [r.id, r]));
  assert.equal(byId.f1.parentId, null);
  assert.equal(byId.f2.parentId, null);
  assert.equal(byId.bm.parentId, 'f2');
  assert.ok(!records.some((r) => r.id === '__recovered'), 'nothing needed repairing');
});

test('compactTombstones: drops tombstones older than 30 days, keeps recent ones', () => {
  const now = Date.now();
  const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
  const records = [
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
    records: [record({ id: 'f', parentId: null, position: 'a0', updatedAt: 5, origin: 'device-a' })],
  };
  const remote = {
    schema: 1,
    records: [record({ id: 'f', parentId: null, position: generateKeyBetween('a0', null), updatedAt: 9, origin: 'device-b' })],
  };
  const result = merge(local, remote);
  const f = result.records.find((r) => r.id === 'f');
  assert.equal(f.updatedAt, 9);
  assert.equal(f.position, remote.records[0].position); // whole record from the winner, not a field mix
});

test('normalizeLegacyRoot: strips a legacy "root" record and reparents its children to the top level', () => {
  const records = [
    record({ id: 'root', parentId: null, name: '~' }),
    record({ id: 'f1', parentId: 'root', name: 'f1' }),
    record({ id: 'f2', parentId: 'f1', name: 'f2' }), // nested — untouched
  ];
  const { records: result, changed } = normalizeLegacyRoot(records);
  assert.equal(changed, true);
  assert.ok(!result.some((r) => r.id === 'root'));
  assert.equal(result.find((r) => r.id === 'f1').parentId, null);
  assert.equal(result.find((r) => r.id === 'f2').parentId, 'f1');
});

test('normalizeLegacyRoot: no-op once no "root" record remains', () => {
  const records = [record({ id: 'f1', parentId: null, name: 'f1' })];
  const { records: result, changed } = normalizeLegacyRoot(records);
  assert.equal(changed, false);
  assert.deepEqual(result, records);
});

test('merge(): also migrates a legacy "root" record arriving from an un-upgraded remote', () => {
  const local = { schema: 1, records: [record({ id: 'f1', parentId: null, name: 'f1', updatedAt: 5 })] };
  const remote = {
    schema: 1,
    records: [
      record({ id: 'root', parentId: null, name: '~', updatedAt: 1 }),
      record({ id: 'f2', parentId: 'root', name: 'f2', updatedAt: 5 }),
    ],
  };
  const result = merge(local, remote);
  assert.ok(!result.records.some((r) => r.id === 'root'));
  assert.equal(result.records.find((r) => r.id === 'f2').parentId, null);
});
