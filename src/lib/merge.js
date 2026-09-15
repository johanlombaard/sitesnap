// Pure merge logic — no I/O, no storage, no network. Spec §6.
import { generateKeyBetween } from './fracidx.js';

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/** Whole-record last-write-wins. Never field-by-field (spec §2.5, §6.1). */
export function pickWinner(a, b) {
  if (!a) return b;
  if (!b) return a;
  if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt ? a : b;
  return a.origin > b.origin ? a : b; // deterministic tiebreak, never random
}

/** Highest updatedAt across a set of records, 0 if empty. */
export function highestUpdatedAt(records) {
  let max = 0;
  for (const r of records) if (r.updatedAt > max) max = r.updatedAt;
  return max;
}

/**
 * Clock clamp (spec §6.1): every locally-written updatedAt must exceed the
 * highest updatedAt this device has ever observed, local or remote, so a
 * fast local clock never loses and a slow one never wins by clock alone.
 */
export function clampedNow(highestSeen) {
  return Math.max(Date.now(), (highestSeen || 0) + 1);
}

/** Union records by id, picking a winner for each. Returns a plain array (unsorted). */
export function mergeRecords(localRecords, remoteRecords) {
  const byId = new Map();
  for (const r of localRecords) byId.set(r.id, r);
  for (const r of remoteRecords) {
    const existing = byId.get(r.id);
    byId.set(r.id, pickWinner(existing, r));
  }
  return Array.from(byId.values());
}

/**
 * merge(localStore, remoteStore) -> Store
 * Runs after every successful pull, before the merged result is written to
 * storage.local. Does NOT run the cycle-breaker or compaction — callers run
 * resolveTree() and compactTombstones() explicitly so the two concerns stay
 * separately testable.
 */
export function merge(localStore, remoteStore) {
  const records = mergeRecords(localStore.records, remoteStore.records);
  const { records: normalized } = normalizeLegacyRoot(records);
  return { schema: 1, records: normalized };
}

/**
 * Cycle-breaker (spec §6.3). Mutates and returns the same records array.
 * There is no single root record — any node may sit at the top level with
 * `parentId: null`. Any node that cannot walk up to a top-level node — cycle,
 * orphan, or a bookmark masquerading as a parent — is reparented to
 * `__recovered` (created lazily as a top-level folder) with a freshly
 * clamped updatedAt so the repair propagates to other devices instead of
 * being silently re-overwritten.
 */
export function resolveTree(records, { deviceId, highestSeen } = {}) {
  const live = records.filter((r) => !r.deleted);
  const byId = new Map(live.map((r) => [r.id, r]));
  const cap = live.length;

  const ensureRecovered = () => {
    let rec = byId.get('__recovered');
    if (rec) return rec;
    const now = clampedNow(highestSeen);
    rec = {
      id: '__recovered',
      parentId: null,
      kind: 'folder',
      name: '__recovered',
      position: generateKeyBetween(lastPositionIn(records, null), null),
      updatedAt: now,
      origin: deviceId || 'unknown',
      deleted: false,
    };
    records.push(rec);
    byId.set(rec.id, rec);
    live.push(rec);
    return rec;
  };

  for (const node of live) {
    const seen = new Set();
    let cur = node;
    let ok = false;
    let steps = 0;
    while (steps++ <= cap) {
      if (cur.parentId == null) {
        ok = true;
        break;
      }
      if (seen.has(cur.id)) {
        ok = false;
        break;
      }
      seen.add(cur.id);
      const parent = byId.get(cur.parentId);
      if (parent == null) {
        ok = false;
        break;
      }
      if (parent.kind !== 'folder') {
        ok = false;
        break;
      }
      cur = parent;
    }
    if (!ok) {
      const recovered = ensureRecovered();
      if (node.id === recovered.id) continue; // recovered itself always sits at the top level
      node.parentId = recovered.id;
      node.position = generateKeyBetween(lastPositionIn(records, recovered.id), null);
      node.updatedAt = clampedNow(highestSeen);
      node.origin = deviceId || node.origin;
    }
  }
  return records;
}

/**
 * Migration: earlier versions had a single fixed `"root"` folder record with
 * `parentId: null` and every top-level item parented to it. Strips that
 * record out and reparents its former children to the top level (`null`)
 * directly, so a store synced from an older device converges onto the
 * multi-root model. A no-op once no `"root"` record remains.
 */
export function normalizeLegacyRoot(records) {
  let changed = false;
  for (const r of records) {
    if (r.parentId === 'root') {
      r.parentId = null;
      changed = true;
    }
  }
  const filtered = records.filter((r) => r.id !== 'root');
  if (filtered.length !== records.length) changed = true;
  return { records: filtered, changed };
}

function lastPositionIn(records, parentId) {
  let last = null;
  for (const r of records) {
    if (r.deleted || r.parentId !== parentId) continue;
    if (last == null || r.position > last) last = r.position;
  }
  return last;
}

/**
 * Cascade-delete: tombstones `id` and every live descendant, each with its
 * own freshly clamped updatedAt (spec §6.2). Mutates in place.
 */
export function cascadeDelete(records, id, { deviceId, highestSeen } = {}) {
  const byParent = new Map();
  for (const r of records) {
    if (!byParent.has(r.parentId)) byParent.set(r.parentId, []);
    byParent.get(r.parentId).push(r);
  }
  const toDelete = [];
  const stack = [id];
  const seen = new Set();
  while (stack.length) {
    const cur = stack.pop();
    if (seen.has(cur)) continue;
    seen.add(cur);
    toDelete.push(cur);
    for (const child of byParent.get(cur) || []) stack.push(child.id);
  }
  const now = clampedNow(highestSeen);
  for (const r of records) {
    if (seen.has(r.id) && !r.deleted) {
      r.deleted = true;
      r.updatedAt = now;
      r.origin = deviceId || r.origin;
    }
  }
  return records;
}

/**
 * Drop tombstones older than 30 days (spec §6.2). Both devices converge
 * because both apply the same rule to the same updatedAt values.
 */
export function compactTombstones(records, now = Date.now()) {
  const cutoff = now - THIRTY_DAYS_MS;
  return records.filter((r) => !(r.deleted && r.updatedAt < cutoff));
}
