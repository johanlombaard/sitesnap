// Flat records array -> nested view helpers. Pure functions, no I/O.

/** Sibling ordering is always (position ASC, id ASC) — spec §5. */
export function siblingCompare(a, b) {
  if (a.position < b.position) return -1;
  if (a.position > b.position) return 1;
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

export function liveRecords(records) {
  return records.filter((r) => !r.deleted);
}

/** Sorted live children of `parentId`, folders and bookmarks alike. */
export function getChildren(records, parentId) {
  return liveRecords(records)
    .filter((r) => r.parentId === parentId)
    .sort(siblingCompare);
}

export function getFolders(records, parentId) {
  return getChildren(records, parentId).filter((r) => r.kind === 'folder');
}

export function getBookmarks(records, parentId) {
  return getChildren(records, parentId).filter((r) => r.kind === 'bookmark');
}

export function byId(records) {
  const map = new Map();
  for (const r of liveRecords(records)) map.set(r.id, r);
  return map;
}

/** All live descendant ids of `id` (not including `id` itself). */
export function descendantIds(records, id) {
  const byParent = new Map();
  for (const r of liveRecords(records)) {
    if (!byParent.has(r.parentId)) byParent.set(r.parentId, []);
    byParent.get(r.parentId).push(r.id);
  }
  const out = [];
  const stack = [...(byParent.get(id) || [])];
  while (stack.length) {
    const cur = stack.pop();
    out.push(cur);
    for (const child of byParent.get(cur) || []) stack.push(child);
  }
  return out;
}

/** True if moving `id` to become a child of `targetParentId` would create a cycle. */
export function wouldCreateCycle(records, id, targetParentId) {
  if (id === targetParentId) return true;
  return descendantIds(records, id).includes(targetParentId);
}

/** Recursive count of live bookmarks under `folderId` (includes nested folders). */
export function recursiveBookmarkCount(records, folderId) {
  let count = 0;
  for (const id of [folderId, ...descendantIds(records, folderId)]) {
    for (const r of getChildren(records, id)) {
      if (r.kind === 'bookmark') count++;
    }
  }
  return count;
}

/** Builds a nested tree of folders (bookmarks excluded) rooted at `rootId`. */
export function buildFolderTree(records, rootId = 'root') {
  const map = byId(records);
  const root = map.get(rootId);
  if (!root) return null;
  const node = { record: root, children: [] };
  const walk = (n) => {
    for (const child of getFolders(records, n.record.id)) {
      const childNode = { record: child, children: [] };
      n.children.push(childNode);
      walk(childNode);
    }
  };
  walk(node);
  return node;
}
