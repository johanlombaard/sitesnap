// Tests the pure record-mutation functions in db.js directly (no chrome.storage
// involved — those calls only happen in loadStore/saveStore/getDeviceId/etc,
// which this file doesn't exercise).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFolder, createBookmark, moveRecord, reorderWithinSiblings, deleteRecord, updateRecord } from '../src/lib/db.js';
import { getChildren } from '../src/lib/tree.js';

function freshStore() {
  return {
    schema: 1,
    records: [{ id: 'root', parentId: null, kind: 'folder', name: '~', position: 'a0', updatedAt: 1, origin: 'seed', deleted: false }],
  };
}

test('createBookmark assigns a real position (regression: used to be left undefined)', () => {
  const { store, record } = createBookmark(freshStore(), { parentId: 'root', title: 'Example', url: 'https://example.com', deviceId: 'dev-a' });
  assert.equal(typeof record.position, 'string');
  assert.ok(record.position.length > 0);
  assert.equal(getChildren(store.records, 'root').length, 1);
});

test('createFolder and createBookmark share one position axis per parent (unified sibling order)', () => {
  let store = freshStore();
  ({ store } = createFolder(store, { parentId: 'root', name: 'folder-1', deviceId: 'dev-a' }));
  ({ store } = createBookmark(store, { parentId: 'root', title: 'bm-1', url: 'https://a.example', deviceId: 'dev-a' }));
  ({ store } = createFolder(store, { parentId: 'root', name: 'folder-2', deviceId: 'dev-a' }));
  const siblings = getChildren(store.records, 'root');
  assert.deepEqual(
    siblings.map((r) => r.name || r.title),
    ['folder-1', 'bm-1', 'folder-2'],
    'each new record appends after every existing sibling regardless of kind'
  );
});

test('reorderWithinSiblings touches exactly one record among many siblings', () => {
  let store = freshStore();
  const ids = [];
  for (let i = 0; i < 50; i++) {
    const res = createBookmark(store, { parentId: 'root', title: `bm-${i}`, url: `https://${i}.example`, deviceId: 'dev-a' });
    store = res.store;
    ids.push(res.record.id);
  }
  const before = new Map(store.records.map((r) => [r.id, JSON.stringify(r)]));
  const target = ids[25];
  const res = reorderWithinSiblings(store, target, 'up', { deviceId: 'dev-a' });
  store = res.store;
  assert.equal(res.moved, true);

  const changed = store.records.filter((r) => before.get(r.id) !== JSON.stringify(r));
  assert.deepEqual(
    changed.map((r) => r.id),
    [target]
  );

  const order = getChildren(store.records, 'root').map((r) => r.id);
  assert.equal(order[24], target); // moved up one slot
});

test('moveRecord refuses to move a folder into its own descendant', () => {
  let store = freshStore();
  let a, b;
  ({ store, record: a } = createFolder(store, { parentId: 'root', name: 'A', deviceId: 'dev-a' }));
  ({ store, record: b } = createFolder(store, { parentId: a.id, name: 'B', deviceId: 'dev-a' }));
  assert.throws(() => moveRecord(store, a.id, { parentId: b.id }, { deviceId: 'dev-a' }));
});

test('moveRecord refuses to move root; deleteRecord refuses to delete root; updateRecord refuses to rename root', () => {
  const store = freshStore();
  assert.throws(() => moveRecord(store, 'root', { parentId: 'root' }, { deviceId: 'dev-a' }));
  assert.throws(() => deleteRecord(store, 'root', { deviceId: 'dev-a' }));
  assert.throws(() => updateRecord(store, 'root', { name: 'renamed' }, { deviceId: 'dev-a' }));
});

test('deleteRecord cascades tombstones through db.js (folder + nested bookmark)', () => {
  let store = freshStore();
  let folder, bm;
  ({ store, record: folder } = createFolder(store, { parentId: 'root', name: 'F', deviceId: 'dev-a' }));
  ({ store, record: bm } = createBookmark(store, { parentId: folder.id, title: 'bm', url: 'https://x.example', deviceId: 'dev-a' }));
  ({ store } = deleteRecord(store, folder.id, { deviceId: 'dev-a' }));
  const f = store.records.find((r) => r.id === folder.id);
  const b = store.records.find((r) => r.id === bm.id);
  assert.equal(f.deleted, true);
  assert.equal(b.deleted, true);
});
