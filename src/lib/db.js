// storage.local access + record CRUD + clock clamp. Spec §2.4, §2.7, §4.
import { ext } from './compat.js';
import { generateKeyBetween } from './fracidx.js';
import { getChildren, wouldCreateCycle } from './tree.js';
import { clampedNow, highestUpdatedAt, resolveTree, cascadeDelete } from './merge.js';

const ROOT_ID = 'root';

export const Keys = {
  STORE: 'store',
  DEVICE_ID: 'deviceId',
  TOKEN: 'token',
  GIST_ID: 'gistId',
  ETAG: 'etag',
  BASE_VERSION: 'baseVersion',
  DIRTY: 'dirty',
  LAST_SYNC_AT: 'lastSyncAt',
  LAST_ERROR: 'lastError',
  THEME: 'theme',
  DEVICE_FLOW: 'deviceFlow', // resumable device-code poll state, spec §13.3
};

function uuidv4() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function slugify(s) {
  return (
    String(s)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '')
      .slice(0, 24) || 'device'
  );
}

function emptyStore() {
  const now = Date.now();
  return {
    schema: 1,
    records: [
      {
        id: ROOT_ID,
        parentId: null,
        kind: 'folder',
        name: '~',
        position: 'a0',
        updatedAt: now,
        origin: 'seed',
        deleted: false,
      },
    ],
  };
}

async function get(keys) {
  return ext.storage.local.get(keys);
}
async function set(obj) {
  return ext.storage.local.set(obj);
}

export async function getDeviceId() {
  const { [Keys.DEVICE_ID]: existing } = await get(Keys.DEVICE_ID);
  if (existing) return existing;
  const slug = slugify(
    (typeof navigator !== 'undefined' && (navigator.platform || navigator.userAgent)) || 'device'
  );
  const id = `${slug}-${uuidv4().slice(0, 6)}`;
  await set({ [Keys.DEVICE_ID]: id });
  return id;
}

export async function loadStore() {
  const { [Keys.STORE]: store } = await get(Keys.STORE);
  if (store && Array.isArray(store.records) && store.records.length) return store;
  const fresh = emptyStore();
  await set({ [Keys.STORE]: fresh });
  return fresh;
}

export async function saveStore(store, { dirty = true } = {}) {
  await set({ [Keys.STORE]: store, ...(dirty ? { [Keys.DIRTY]: true } : {}) });
  return store;
}

/** highestUpdatedAtSeenAnywhere (spec §6.1) — the store itself always carries
 * the per-id winner, so its own max already reflects everything ever merged in. */
export function currentHighest(store) {
  return highestUpdatedAt(store.records);
}

export function normalizeTags(tags) {
  const set = new Set((tags || []).map((t) => String(t).trim().toLowerCase()).filter(Boolean));
  return Array.from(set).sort();
}

// Sibling ordering is unified per parent regardless of kind (spec §5), so
// "append at the end" for either a new folder or a new bookmark must look at
// *all* children of the parent, not just same-kind ones — otherwise a new
// record can land before existing siblings of the other kind that already
// sort later.
function lastSiblingPosition(records, parentId) {
  const siblings = getChildren(records, parentId);
  return siblings.length ? siblings[siblings.length - 1].position : null;
}

export function createFolder(store, { parentId, name, deviceId }) {
  const record = {
    id: uuidv4(),
    parentId,
    kind: 'folder',
    name,
    position: generateKeyBetween(lastSiblingPosition(store.records, parentId), null),
    updatedAt: clampedNow(currentHighest(store)),
    origin: deviceId,
    deleted: false,
  };
  store.records.push(record);
  resolveTree(store.records, { deviceId, highestSeen: currentHighest(store) });
  return { store, record };
}

export function createBookmark(store, { parentId, title, url, description = '', tags = [], deviceId }) {
  const now = clampedNow(currentHighest(store));
  const record = {
    id: uuidv4(),
    parentId,
    kind: 'bookmark',
    title,
    url,
    description,
    tags: normalizeTags(tags),
    position: generateKeyBetween(lastSiblingPosition(store.records, parentId), null),
    createdAt: now,
    updatedAt: now,
    origin: deviceId,
    deleted: false,
    openCount: 0,
    lastOpenedAt: null,
  };
  store.records.push(record);
  resolveTree(store.records, { deviceId, highestSeen: currentHighest(store) });
  return { store, record };
}

export function updateRecord(store, id, patch, { deviceId }) {
  const record = store.records.find((r) => r.id === id && !r.deleted);
  if (!record) throw new Error(`record not found: ${id}`);
  if (id === ROOT_ID && (patch.name !== undefined || patch.parentId !== undefined)) {
    throw new Error('root cannot be renamed or moved');
  }
  Object.assign(record, patch);
  if (patch.tags) record.tags = normalizeTags(patch.tags);
  record.updatedAt = clampedNow(currentHighest(store));
  record.origin = deviceId;
  resolveTree(store.records, { deviceId, highestSeen: currentHighest(store) });
  return { store, record };
}

export function deleteRecord(store, id, { deviceId }) {
  if (id === ROOT_ID) throw new Error('root cannot be deleted');
  cascadeDelete(store.records, id, { deviceId, highestSeen: currentHighest(store) });
  return { store };
}

/** Move into `parentId`, positioned between sibling ids `prevId`/`nextId` (either may be null). */
export function moveRecord(store, id, { parentId, prevId = null, nextId = null }, { deviceId }) {
  const record = store.records.find((r) => r.id === id && !r.deleted);
  if (!record) throw new Error(`record not found: ${id}`);
  if (id === ROOT_ID) throw new Error('root cannot be moved');
  if (record.kind === 'folder' && wouldCreateCycle(store.records, id, parentId)) {
    throw new Error('cannot move a folder into itself or a descendant');
  }
  const siblings = getChildren(store.records, parentId).filter((r) => r.id !== id);
  const prev = prevId ? siblings.find((r) => r.id === prevId) : null;
  const next = nextId ? siblings.find((r) => r.id === nextId) : null;
  record.parentId = parentId;
  record.position = generateKeyBetween(prev ? prev.position : null, next ? next.position : null);
  record.updatedAt = clampedNow(currentHighest(store));
  record.origin = deviceId;
  resolveTree(store.records, { deviceId, highestSeen: currentHighest(store) });
  return { store, record };
}

/** Shift+Up / Shift+Down — moves one place among current siblings. Touches exactly one record. */
export function reorderWithinSiblings(store, id, direction, { deviceId }) {
  const record = store.records.find((r) => r.id === id && !r.deleted);
  if (!record) throw new Error(`record not found: ${id}`);
  const siblings = getChildren(store.records, record.parentId);
  const idx = siblings.findIndex((r) => r.id === id);
  if (idx === -1) return { store, record, moved: false };
  const targetIdx = direction === 'up' ? idx - 1 : idx + 1;
  if (targetIdx < 0 || targetIdx >= siblings.length) return { store, record, moved: false };

  let prev, next;
  if (direction === 'up') {
    prev = siblings[targetIdx - 1] || null;
    next = siblings[targetIdx];
  } else {
    prev = siblings[targetIdx];
    next = siblings[targetIdx + 1] || null;
  }
  record.position = generateKeyBetween(prev ? prev.position : null, next ? next.position : null);
  record.updatedAt = clampedNow(currentHighest(store));
  record.origin = deviceId;
  return { store, record, moved: true };
}

export function recordOpened(store, id, { deviceId }) {
  const record = store.records.find((r) => r.id === id && !r.deleted);
  if (!record || record.kind !== 'bookmark') return { store };
  record.openCount = (record.openCount || 0) + 1;
  record.lastOpenedAt = Date.now();
  record.updatedAt = clampedNow(currentHighest(store));
  record.origin = deviceId;
  return { store, record };
}

export async function getFlag(key) {
  const res = await get(key);
  return res[key];
}
export async function setFlag(key, value) {
  await set({ [key]: value });
}
export async function getFlags(keys) {
  return get(keys);
}
