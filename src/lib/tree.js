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

/** Builds one nested tree node (bookmarks excluded), recursing through `folder`'s descendants. */
function buildFolderNode(records, folder) {
  const node = { record: folder, children: [] };
  for (const child of getFolders(records, folder.id)) {
    node.children.push(buildFolderNode(records, child));
  }
  return node;
}

/**
 * Builds a forest of folder trees for every top-level folder (parentId === null).
 * There is no single root record — a store can have any number of top-level folders.
 */
export function buildFolderForest(records) {
  return getFolders(records, null).map((f) => buildFolderNode(records, f));
}
