import { ext } from '../lib/compat.js';
import { Keys } from '../lib/db.js';
import {
  getChildren,
  getFolders,
  getBookmarks,
  buildFolderTree,
  recursiveBookmarkCount,
  wouldCreateCycle,
  liveRecords,
} from '../lib/tree.js';
import { resolveTree } from '../lib/merge.js';

const STORAGE_KEYS = [
  Keys.STORE,
  Keys.DEVICE_ID,
  Keys.TOKEN,
  Keys.GIST_ID,
  Keys.ETAG,
  Keys.BASE_VERSION,
  Keys.DIRTY,
  Keys.LAST_SYNC_AT,
  Keys.LAST_ERROR,
  Keys.THEME,
  Keys.DEVICE_FLOW,
  'rateLimit',
  'pendingQuickAdd',
];

const S = {
  store: { schema: 1, records: [] },
  deviceId: null,
  token: null,
  gistId: null,
  dirty: false,
  lastSyncAt: null,
  lastError: null,
  rateLimit: null,
  baseVersion: null,
  deviceFlow: null,
  theme: 'p1',
  screen: 'browser', // 'browser' | 'auth' | 'sync-status'
  selectedFolderId: 'root',
  collapsed: new Set(),
  selectedTileId: null,
  markedTileIds: new Set(),
  focusPane: 'tree',
  filterText: '',
  filterScope: 'folder',
  visibleTreeIds: [],
  visibleTileIds: [],
};

const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, attrs = {}, children = []) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
};

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function indexLabel(n) {
  let s = '';
  n++;
  while (n > 0) {
    n--;
    s = String.fromCharCode(97 + (n % 26)) + s;
    n = Math.floor(n / 26);
  }
  return s;
}

function fmtTime(ts) {
  if (!ts) return 'never';
  return new Date(ts).toLocaleString();
}

function isTypingTarget(elTarget) {
  return elTarget && (elTarget.tagName === 'INPUT' || elTarget.tagName === 'TEXTAREA' || elTarget.isContentEditable);
}

function sendMessage(msg) {
  return ext.runtime.sendMessage(msg);
}
function sendMutate(op, args) {
  return sendMessage({ type: 'mutate', op, args }).then((r) => {
    if (r && r.ok === false) toast(r.error);
    return r;
  });
}

function toast(message) {
  const root = $('#toast-root');
  root.textContent = '';
  const node = el('div', { class: 'toast' }, message);
  root.append(node);
  setTimeout(() => node.remove(), 3500);
}

function getFolderPath(records, folderId) {
  const byId = new Map(liveRecords(records).map((r) => [r.id, r]));
  const parts = [];
  let cur = byId.get(folderId);
  while (cur) {
    parts.unshift(cur.id === 'root' ? '~' : cur.name);
    cur = cur.parentId ? byId.get(cur.parentId) : null;
  }
  return parts.join(' / ');
}

function flattenFolders(records, { excludeIds = new Set() } = {}) {
  const tree = buildFolderTree(records, 'root');
  const out = [];
  const walk = (node, depth) => {
    if (excludeIds.has(node.record.id)) return;
    out.push({ id: node.record.id, name: node.record.id === 'root' ? '~' : node.record.name, depth });
    for (const child of node.children) walk(child, depth + 1);
  };
  if (tree) walk(tree, 0);
  return out;
}

// ---------------------------------------------------------------- storage --

async function refreshFromStorage() {
  const data = await ext.storage.local.get(STORAGE_KEYS);
  S.store = data[Keys.STORE] || S.store;
  S.deviceId = data[Keys.DEVICE_ID] || S.deviceId;
  S.token = data[Keys.TOKEN] || null;
  S.gistId = data[Keys.GIST_ID] || null;
  S.dirty = !!data[Keys.DIRTY];
  S.lastSyncAt = data[Keys.LAST_SYNC_AT] || null;
  S.lastError = data[Keys.LAST_ERROR] || null;
  S.rateLimit = data.rateLimit || null;
  S.baseVersion = data[Keys.BASE_VERSION] || null;
  S.deviceFlow = data[Keys.DEVICE_FLOW] || null;
  S.theme = data[Keys.THEME] || 'p1';
  document.documentElement.dataset.theme = S.theme;
  $('#theme-toggle').textContent = S.theme.toUpperCase();

  if (S.deviceFlow) {
    S.screen = 'auth';
  } else if (S.screen === 'auth' && S.token) {
    // Device flow just completed successfully (auth.js clears the flow
    // record the moment it stores the token, with no transitional
    // "success" state persisted) — head back to the browser.
    S.screen = 'browser';
  }

  if (data.pendingQuickAdd) {
    const qa = data.pendingQuickAdd;
    await ext.storage.local.remove('pendingQuickAdd');
    openBookmarkEditor({ parentId: S.selectedFolderId, prefill: qa });
  }

  render();
}

ext.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  refreshFromStorage();
});

// ------------------------------------------------------------------ render --

function render() {
  renderTopbar();
  if (S.screen === 'auth') {
    renderFullscreen(renderAuthScreen());
  } else if (S.screen === 'sync-status') {
    renderFullscreen(renderSyncStatusScreen());
  } else {
    renderBrowserScreen();
  }
  renderStatusbar();
}

function renderFullscreen(node) {
  $('#app').classList.add('screen-covered');
  const main = $('main.panes');
  main.innerHTML = '';
  main.style.display = 'block';
  main.append(node);
}

function renderBrowserScreen() {
  const main = $('main.panes');
  main.style.display = 'flex';
  main.innerHTML = '';
  const tree = el('nav', { class: 'pane tree-pane', tabindex: '0', id: 'tree-pane' });
  const tiles = el('section', { class: 'pane tiles-pane', tabindex: '0', id: 'tiles-pane' });
  main.append(tree, tiles);
  renderTree(tree);
  renderTiles(tiles);
}

function renderTopbar() {
  const crumb = $('#breadcrumb');
  if (S.screen === 'browser') {
    crumb.textContent =
      S.filterScope === 'global' && S.filterText
        ? `// ${S.filterText}`
        : getFolderPath(S.store.records, S.selectedFolderId) || '~';
  } else {
    crumb.textContent = S.screen === 'auth' ? 'connect github' : 'sync status';
  }
  const pill = $('#sync-pill');
  pill.classList.toggle('dirty', S.dirty);
  pill.classList.toggle('error', !!S.lastError);
  if (!S.token) pill.textContent = 'offline';
  else if (S.lastError) pill.textContent = 'sync error';
  else if (S.dirty) pill.textContent = 'sync pending';
  else pill.textContent = S.lastSyncAt ? `synced ${new Date(S.lastSyncAt).toLocaleTimeString()}` : 'sync';
}

function renderTree(root) {
  S.visibleTreeIds = [];
  const tree = buildFolderTree(S.store.records, 'root');
  if (!tree) return;
  const walk = (node, depth) => {
    const hasChildren = node.children.length > 0;
    const collapsed = S.collapsed.has(node.record.id);
    S.visibleTreeIds.push(node.record.id);
    const row = el(
      'div',
      {
        class: `tree-row${node.record.id === S.selectedFolderId ? ' selected' : ''}`,
        style: `padding-left:${0.5 + depth * 1.4}ch`,
        'data-id': node.record.id,
        onclick: () => selectFolder(node.record.id),
      },
      [
        el('span', {
          class: 'marker',
          onclick: (e) => {
            e.stopPropagation();
            toggleCollapse(node.record.id);
          },
          html: hasChildren ? (collapsed ? '+' : '-') : '&nbsp;',
        }),
        el('span', { class: 'name' }, node.record.id === 'root' ? '~' : node.record.name),
        el('span', { class: 'count' }, String(recursiveBookmarkCount(S.store.records, node.record.id))),
      ]
    );
    root.append(row);
    if (hasChildren && !collapsed) {
      for (const child of node.children) walk(child, depth + 1);
    }
  };
  walk(tree, 0);
}

function matchesFilter(record, needle) {
  if (!needle) return true;
  const hay = `${record.title} ${record.description} ${record.url} ${(record.tags || []).join(' ')}`.toLowerCase();
  return hay.includes(needle);
}

function currentTiles() {
  const needle = S.filterText.trim().toLowerCase();
  let bookmarks;
  if (S.filterScope === 'global') {
    bookmarks = liveRecords(S.store.records).filter((r) => r.kind === 'bookmark');
  } else {
    bookmarks = getBookmarks(S.store.records, S.selectedFolderId);
  }
  if (needle) bookmarks = bookmarks.filter((r) => matchesFilter(r, needle));
  return bookmarks;
}

function renderTiles(root) {
  const toolbar = el('div', { class: 'tiles-toolbar' });
  const filterBox = el('input', {
    type: 'text',
    id: 'filter-input',
    placeholder: '/ filter this folder, // search everywhere',
    value: S.filterScope === 'global' ? `//${S.filterText}` : S.filterText,
    oninput: onFilterInput,
    onkeydown: onFilterKeydown,
  });
  toolbar.append(filterBox);
  root.append(toolbar);

  const grid = el('div', { class: 'tile-grid', id: 'tile-grid' });
  root.append(grid);
  renderTileGrid(grid);
}

// Rebuilds only the grid contents (not the filter input itself), so typing a
// filter never steals focus/caret from the input the keystroke came from.
function renderTileGrid(grid) {
  const bookmarks = currentTiles();
  S.visibleTileIds = bookmarks.map((b) => b.id);

  grid.innerHTML = '';
  if (bookmarks.length === 0) {
    grid.append(el('div', { class: 'empty-state' }, S.filterText ? 'no matches' : 'empty — N to add a bookmark'));
  }
  bookmarks.forEach((b, i) => {
    const selected = b.id === S.selectedTileId;
    const marked = S.markedTileIds.has(b.id);
    const tile = el(
      'div',
      {
        class: `tile${selected ? ' selected' : ''}${marked ? ' marked' : ''}`,
        'data-id': b.id,
        tabindex: '-1',
        onclick: () => {
          S.focusPane = 'tiles';
          S.selectedTileId = b.id;
          render();
        },
        ondblclick: () => openBookmark(b),
      },
      [
        el('div', { class: 'row1' }, [el('span', { class: 'idx' }, indexLabel(i)), el('span', { class: 'title' }, b.title || b.url)]),
        el('div', { class: 'host annot' }, S.filterScope === 'global' ? `${hostOf(b.url)} · ${getFolderPath(S.store.records, b.parentId)}` : hostOf(b.url)),
        b.description ? el('div', { class: 'desc' }, b.description) : null,
      ]
    );
    grid.append(tile);
  });
}

function renderStatusbar() {
  const hints = $('#keyhints');
  if (S.screen === 'browser') {
    hints.innerHTML = '';
    const items = [
      ['F2', 'rename'],
      ['F4', 'edit'],
      ['F9', 'move'],
      ['F', 'new folder'],
      ['F8', 'delete'],
      ['N', 'new bookmark'],
      ['/', 'find'],
      ['^S', 'sync'],
    ];
    for (const [k, label] of items) {
      hints.append(el('span', {}, [el('kbd', {}, k), ' ' + label]));
    }
  } else {
    hints.textContent = 'Esc back';
  }
  $('#statusmsg').textContent = S.lastError || '';
}

// -------------------------------------------------------------- selection --

function selectFolder(id) {
  S.selectedFolderId = id;
  S.selectedTileId = null;
  S.markedTileIds.clear();
  S.focusPane = 'tree';
  render();
}

function toggleCollapse(id) {
  if (S.collapsed.has(id)) S.collapsed.delete(id);
  else S.collapsed.add(id);
  render();
}

function onFilterInput(e) {
  const raw = e.target.value;
  if (raw.startsWith('//')) {
    S.filterScope = 'global';
    S.filterText = raw.slice(2);
  } else {
    S.filterScope = 'folder';
    S.filterText = raw;
  }
  renderTopbar();
  const grid = document.getElementById('tile-grid');
  if (grid) renderTileGrid(grid); // leaves the input node (and its focus/caret) untouched
}

function onFilterKeydown(e) {
  if (e.key === 'Escape') {
    S.filterText = '';
    S.filterScope = 'folder';
    render();
    $('#tiles-pane')?.focus();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    S.focusPane = 'tiles';
    if (S.visibleTileIds.length) S.selectedTileId = S.visibleTileIds[0];
    render();
    $('#tiles-pane')?.focus();
  }
}

function openBookmark(record) {
  ext.tabs.create({ url: record.url });
  sendMutate('recordOpened', { id: record.id });
}

// ----------------------------------------------------------------- modals --

function openModal(bodyNode, { title, onClose } = {}) {
  const root = $('#modal-root');
  root.innerHTML = '';
  const dialog = el('div', { class: 'dialog', role: 'dialog', 'aria-modal': 'true' }, [
    el('div', { class: 'dlg-title' }, [el('span', {}, title || ''), el('button', { onclick: () => closeModal() }, '×')]),
    el('div', { class: 'dlg-body' }, bodyNode),
  ]);
  const backdrop = el(
    'div',
    {
      class: 'modal-backdrop',
      onkeydown: (e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          closeModal();
        }
      },
    },
    dialog
  );
  root.append(backdrop);
  root._onClose = onClose;
  // Scoped to dlg-body: the dlg-title's "x" close button would otherwise
  // win as the first focusable element in DOM order.
  const first = dialog.querySelector('.dlg-body input,.dlg-body select,.dlg-body textarea,.dlg-body button');
  first?.focus();
}

function closeModal() {
  const root = $('#modal-root');
  root._onClose?.();
  root.innerHTML = '';
}

function isModalOpen() {
  return $('#modal-root').children.length > 0;
}

// --- bookmark editor ---

function openBookmarkEditor({ id = null, parentId, prefill } = {}) {
  const existing = id ? S.store.records.find((r) => r.id === id) : null;
  const initial = existing || {
    title: prefill?.title || '',
    url: prefill?.url || '',
    description: '',
    tags: [],
    parentId,
    createdAt: null,
    openCount: 0,
    lastOpenedAt: null,
  };

  const titleInput = el('input', { type: 'text', value: initial.title });
  const urlInput = el('input', { type: 'url', value: initial.url, placeholder: 'https://…' });
  const descInput = el('textarea', {}, initial.description || '');
  descInput.value = initial.description || '';
  const tagsInput = el('input', { type: 'text', value: (initial.tags || []).join(', ') });
  const excludeIds = new Set();
  const folderOptions = flattenFolders(S.store.records, { excludeIds });
  const folderSelect = el(
    'select',
    {},
    folderOptions.map((f) => el('option', { value: f.id, selected: f.id === initial.parentId ? 'selected' : false }, `${'—'.repeat(f.depth)} ${f.name}`))
  );
  folderSelect.value = initial.parentId;

  const body = [
    el('div', { class: 'field' }, [el('label', {}, 'Title'), titleInput]),
    el('div', { class: 'field' }, [el('label', {}, 'Address'), urlInput]),
    el('div', { class: 'field' }, [el('label', {}, 'Description'), descInput]),
    el('div', { class: 'field-row' }, [
      el('div', { class: 'field' }, [el('label', {}, 'Folder'), folderSelect]),
      el('div', { class: 'field' }, [el('label', {}, 'Tags (comma-separated)'), tagsInput]),
    ]),
    existing
      ? el('div', { class: 'stat-row' }, [
          el('span', {}, `added ${fmtTime(existing.createdAt)}`),
          el('span', {}, `opened ${existing.openCount || 0}×`),
          el('span', {}, `last opened ${fmtTime(existing.lastOpenedAt)}`),
        ])
      : null,
    el('div', { class: 'dlg-actions' }, [
      el('button', { onclick: () => closeModal() }, 'Cancel (Esc)'),
      el(
        'button',
        {
          class: 'reverse',
          onclick: async () => {
            const title = titleInput.value.trim();
            const url = urlInput.value.trim();
            if (!title || !url) {
              toast('title and address are required');
              return;
            }
            const tags = tagsInput.value.split(',').map((t) => t.trim()).filter(Boolean);
            const newParentId = folderSelect.value;
            if (existing) {
              await sendMutate('update', { id: existing.id, patch: { title, url, description: descInput.value, tags } });
              if (newParentId !== existing.parentId) {
                await moveIntoFolder(existing.id, newParentId);
              }
            } else {
              const res = await sendMutate('createBookmark', { parentId: newParentId, title, url, description: descInput.value, tags });
              if (res?.ok) S.selectedTileId = res.record.id;
            }
            closeModal();
          },
        },
        'Save'
      ),
    ]),
  ];
  openModal(body, { title: existing ? 'Edit bookmark' : 'New bookmark' });
}

// --- new folder ---

function openNewFolderDialog(parentId) {
  const nameInput = el('input', { type: 'text', placeholder: 'folder name' });
  const body = [
    el('div', { class: 'field' }, [el('label', {}, `New folder in ${getFolderPath(S.store.records, parentId)}`), nameInput]),
    el('div', { class: 'dlg-actions' }, [
      el('button', { onclick: () => closeModal() }, 'Cancel (Esc)'),
      el(
        'button',
        {
          class: 'reverse',
          onclick: async () => {
            const name = nameInput.value.trim();
            if (!name) return toast('name is required');
            await sendMutate('createFolder', { parentId, name });
            closeModal();
          },
        },
        'Create'
      ),
    ]),
  ];
  openModal(body, { title: 'New folder' });
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('#modal-root .reverse')?.click();
  });
}

// --- rename ---

function openRenameDialog(record) {
  const nameInput = el('input', { type: 'text', value: record.kind === 'folder' ? record.name : record.title });
  const body = [
    el('div', { class: 'field' }, [el('label', {}, 'Name'), nameInput]),
    el('div', { class: 'dlg-actions' }, [
      el('button', { onclick: () => closeModal() }, 'Cancel (Esc)'),
      el(
        'button',
        {
          class: 'reverse',
          onclick: async () => {
            const value = nameInput.value.trim();
            if (!value) return toast('name is required');
            const patch = record.kind === 'folder' ? { name: value } : { title: value };
            await sendMutate('update', { id: record.id, patch });
            closeModal();
          },
        },
        'Rename'
      ),
    ]),
  ];
  openModal(body, { title: `Rename ${record.kind}` });
  nameInput.select();
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('#modal-root .reverse')?.click();
  });
}

// --- move picker (F9) ---

function openMovePicker(ids) {
  const records = ids.map((id) => S.store.records.find((r) => r.id === id)).filter(Boolean);
  const isFolderMove = records.some((r) => r.kind === 'folder');
  const excludeIds = new Set();
  if (isFolderMove) {
    for (const r of records) {
      if (r.kind !== 'folder') continue;
      excludeIds.add(r.id);
      for (const f of flattenFolders(S.store.records)) {
        if (wouldCreateCycle(S.store.records, r.id, f.id)) excludeIds.add(f.id);
      }
    }
  }
  const options = flattenFolders(S.store.records, { excludeIds });
  let chosen = options[0]?.id || 'root';

  const list = el('div', { class: 'folder-picker-list' });
  const renderList = () => {
    list.innerHTML = '';
    for (const f of options) {
      list.append(
        el(
          'div',
          {
            class: `tree-row${f.id === chosen ? ' selected' : ''}`,
            style: `padding-left:${0.5 + f.depth * 1.4}ch`,
            onclick: () => {
              chosen = f.id;
              renderList();
            },
            ondblclick: () => confirm(),
          },
          f.name
        )
      );
    }
  };
  renderList();

  const confirm = async () => {
    // Re-read after each move (not just filter the stale snapshot) so each
    // subsequent item appends after the one that was *just* placed —
    // otherwise two moved items can both compute the same insertion point
    // and collide on position.
    for (const id of ids) {
      const targetSiblings = getChildren(S.store.records, chosen);
      const prevId = targetSiblings[targetSiblings.length - 1]?.id || null;
      await sendMutate('move', { id, target: { parentId: chosen, prevId, nextId: null } });
      const fresh = await ext.storage.local.get(Keys.STORE);
      S.store = fresh[Keys.STORE];
    }
    S.markedTileIds.clear();
    closeModal();
  };

  const body = [
    el('div', { class: 'field' }, [el('label', {}, `Move ${ids.length} item(s) to`)]),
    list,
    el('div', { class: 'dlg-actions' }, [el('button', { onclick: () => closeModal() }, 'Cancel (Esc)'), el('button', { class: 'reverse', onclick: confirm }, 'Move here')]),
  ];
  openModal(body, { title: 'Move' });
}

async function moveIntoFolder(id, parentId) {
  const siblings = getChildren(S.store.records, parentId).filter((r) => r.id !== id);
  const prevId = siblings[siblings.length - 1]?.id || null;
  return sendMutate('move', { id, target: { parentId, prevId, nextId: null } });
}

// --- delete confirm ---

function openDeleteConfirm(records) {
  const label = records.length === 1 ? (records[0].kind === 'folder' ? records[0].name : records[0].title) : `${records.length} items`;
  const body = [
    el('div', { class: 'field' }, `Delete '${label}'? This cannot be undone from the UI.`),
    el('div', { class: 'dlg-actions' }, [
      el('button', { onclick: () => closeModal() }, 'Cancel (Esc)'),
      el(
        'button',
        {
          class: 'reverse',
          onclick: async () => {
            for (const r of records) await sendMutate('delete', { id: r.id });
            S.selectedTileId = null;
            S.markedTileIds.clear();
            closeModal();
          },
        },
        'Delete (Y)'
      ),
    ]),
  ];
  const onKey = (e) => {
    if (e.key.toLowerCase() === 'y') $('#modal-root .reverse')?.click();
    if (e.key.toLowerCase() === 'n') closeModal();
  };
  openModal(body, { title: 'Confirm delete', onClose: () => document.removeEventListener('keydown', onKey) });
  document.addEventListener('keydown', onKey);
}

// ------------------------------------------------------------ auth screen --

function renderAuthScreen() {
  const container = el('div', { class: 'fullscreen' });
  if (!S.deviceFlow) {
    container.append(
      el('div', { class: 'brand', style: 'font-size:1.6em' }, 'Connect GitHub'),
      el('div', { class: 'dim' }, 'Sync your bookmarks through a private Gist.'),
      el(
        'button',
        {
          class: 'reverse',
          onclick: async () => {
            const res = await sendMessage({ type: 'auth-start' });
            if (!res.ok) toast(res.error);
          },
        },
        'Start device sign-in'
      ),
      el('button', { onclick: () => (S.screen = 'browser') || render() }, 'Back (Esc)')
    );
    return container;
  }

  const { status, userCode, verificationUri } = S.deviceFlow;
  if (status === 'success') {
    S.screen = 'browser';
    render();
    return el('div');
  }
  container.append(
    el('div', { class: 'dim' }, 'Enter this code on github.com'),
    el('div', { class: 'user-code' }, userCode || '……'),
    el('button', { onclick: () => navigator.clipboard?.writeText(userCode || '') }, 'Copy code'),
    el('div', {}, [el('a', { href: verificationUri, target: '_blank' }, verificationUri || '')]),
    el('div', { class: 'dim' }, statusMessage(status, S.deviceFlow.message), el('span', { class: 'caret' })),
    el(
      'button',
      {
        onclick: async () => {
          await sendMessage({ type: 'auth-cancel' });
          S.screen = 'browser';
          render();
        },
      },
      'Cancel (Esc)'
    )
  );
  return container;
}

function statusMessage(status, message) {
  switch (status) {
    case 'pending':
      return 'waiting for authorization…';
    case 'expired':
      return 'code expired — start again';
    case 'denied':
      return 'authorization declined';
    case 'error':
      return message || 'unexpected error';
    default:
      return '';
  }
}

// ------------------------------------------------------------ sync status --

function computeConsistency(records) {
  const clone = JSON.parse(JSON.stringify(records));
  resolveTree(clone, { deviceId: S.deviceId, highestSeen: Date.now() });
  const before = new Map(records.map((r) => [r.id, r.parentId]));
  let repaired = 0;
  for (const r of clone) if (before.has(r.id) && before.get(r.id) !== r.parentId) repaired++;
  return repaired === 0 ? 'OK — every node reaches root' : `${repaired} node(s) would be repaired into __recovered`;
}

function deviceTable(records) {
  const byOrigin = new Map();
  for (const r of liveRecords(records)) {
    if (r.origin === 'seed') continue; // synthetic root origin, not a real device
    const cur = byOrigin.get(r.origin) || 0;
    if (r.updatedAt > cur) byOrigin.set(r.origin, r.updatedAt);
  }
  return Array.from(byOrigin.entries()).sort((a, b) => b[1] - a[1]);
}

function renderSyncStatusScreen() {
  const records = S.store.records;
  const live = liveRecords(records);
  const folders = live.filter((r) => r.kind === 'folder').length;
  const bookmarks = live.filter((r) => r.kind === 'bookmark').length;
  const tombstones = records.filter((r) => r.deleted).length;

  const container = el('div', { class: 'sync-status-screen' });
  container.append(el('h2', {}, 'Sync status'));

  const kv = el('dl', { class: 'kv' });
  const rows = [
    ['GitHub', S.token ? 'connected' : 'not connected'],
    ['Gist ID', S.gistId || '—'],
    ['Base version', S.baseVersion || '—'],
    ['Last sync', fmtTime(S.lastSyncAt)],
    ['Pending push', S.dirty ? 'yes' : 'no'],
    ['Last error', S.lastError || 'none'],
    ['Rate limit', S.rateLimit ? `${S.rateLimit.remaining}/${S.rateLimit.limit} (resets ${fmtTime(S.rateLimit.resetAt)})` : '—'],
    ['Records', `${folders} folders, ${bookmarks} bookmarks, ${tombstones} tombstones`],
    ['Tree consistency', computeConsistency(records)],
  ];
  for (const [k, v] of rows) kv.append(el('dt', {}, k), el('dd', {}, v));
  container.append(kv);

  container.append(el('h2', {}, 'Devices (from record activity)'));
  const table = el('table', { class: 'table' }, [
    el('thead', {}, el('tr', {}, [el('th', {}, 'origin'), el('th', {}, 'last seen')])),
    el(
      'tbody',
      {},
      deviceTable(records).map(([origin, ts]) => el('tr', {}, [el('td', {}, origin === S.deviceId ? `${origin} (this device)` : origin), el('td', {}, fmtTime(ts))]))
    ),
  ]);
  container.append(table);

  const actions = el('div', { class: 'dlg-actions', style: 'justify-content:flex-start; margin-top:1em' });
  if (!S.token) {
    actions.append(
      el('button', { class: 'reverse', onclick: () => ((S.screen = 'auth'), render()) }, 'Sign in with GitHub')
    );
  } else {
    actions.append(
      el(
        'button',
        {
          onclick: async () => {
            const res = await sendMessage({ type: 'sync-now' });
            if (!res.ok) toast(res.error);
            else toast('sync complete');
          },
        },
        'Sync now'
      ),
      el(
        'button',
        {
          onclick: async () => {
            await ext.storage.local.set({ [Keys.TOKEN]: null });
            toast('signed out');
          },
        },
        'Sign out'
      )
    );
  }
  actions.append(
    el('button', { onclick: exportStore }, 'Export JSON'),
    el('button', { onclick: importStore }, 'Import JSON'),
    el('button', { onclick: () => ((S.screen = 'browser'), render()) }, 'Back (Esc)')
  );
  container.append(actions);
  container.append(el('div', { class: 'dim annot' }, 'Secret gists are unlisted, not private — anyone with the URL can read it.'));
  return container;
}

function exportStore() {
  const blob = new Blob([JSON.stringify(S.store, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: `sitesnap-export-${new Date().toISOString().slice(0, 10)}.json` });
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function importStore() {
  const input = el('input', { type: 'file', accept: 'application/json' });
  input.addEventListener('change', async () => {
    const file = input.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      if (!parsed || !Array.isArray(parsed.records)) throw new Error('not a valid SiteSnap export');
      if (!confirm(`Import ${parsed.records.length} record(s)? This replaces your local store.`)) return;
      const res = await sendMessage({ type: 'import', store: { schema: 1, records: parsed.records } });
      if (!res.ok) toast(res.error);
      else toast('import complete');
    } catch (err) {
      toast(`import failed: ${err.message}`);
    }
  });
  input.click();
}

// -------------------------------------------------------------- keyboard --

function visibleFolderNeighbors(delta) {
  const idx = S.visibleTreeIds.indexOf(S.selectedFolderId);
  const next = S.visibleTreeIds[idx + delta];
  return next || S.selectedFolderId;
}

function moveTileSelection(dx, dy) {
  const cols = window.matchMedia('(max-width: 900px)').matches ? 2 : 3;
  const ids = S.visibleTileIds;
  if (!ids.length) return;
  let idx = ids.indexOf(S.selectedTileId);
  if (idx === -1) {
    S.selectedTileId = ids[0];
    render();
    return;
  }
  let next = idx;
  if (dx) next = idx + dx;
  if (dy) next = idx + dy * cols;
  next = Math.max(0, Math.min(ids.length - 1, next));
  S.selectedTileId = ids[next];
  render();
}

document.addEventListener('keydown', (e) => {
  const typing = isTypingTarget(e.target);

  if (e.key === 'Escape') {
    if (isModalOpen()) return closeModal();
    if (typing) return; // filter input handles its own Escape
    if (S.screen !== 'browser') {
      S.screen = 'browser';
      render();
    }
    return;
  }

  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault();
    sendMessage({ type: 'sync-now' }).then((r) => {
      if (!r.ok) toast(r.error);
    });
    return;
  }

  if (S.screen !== 'browser' || isModalOpen() || typing) return;

  // Deliberately NOT Ctrl+N/F6/F7 as spec §11 originally listed: those are
  // hard-reserved by both Chrome and Firefox (Ctrl+N opens a new browser
  // window; F6 refocuses the address bar; F7 pops a "turn on caret
  // browsing?" prompt) and a page's preventDefault() cannot stop them. Bare,
  // unmodified letter/F keys are never bound by browser chrome, so those are
  // used instead — same mnemonics, but they actually work.
  if (e.key.toLowerCase() === 'n') {
    e.preventDefault();
    openBookmarkEditor({ parentId: S.selectedFolderId });
    return;
  }

  if (e.key === '/') {
    e.preventDefault();
    $('#filter-input')?.focus();
    return;
  }

  if (e.key === 'Tab') {
    e.preventDefault();
    S.focusPane = S.focusPane === 'tree' ? 'tiles' : 'tree';
    render();
    document.getElementById(S.focusPane === 'tree' ? 'tree-pane' : 'tiles-pane')?.focus();
    return;
  }

  if (e.key === 'F2') {
    e.preventDefault();
    const record = currentSelectionRecords()[0];
    if (record && record.id !== 'root') openRenameDialog(record);
    return;
  }

  if (e.key === 'F4') {
    e.preventDefault();
    if (S.focusPane === 'tiles' && S.selectedTileId) {
      openBookmarkEditor({ id: S.selectedTileId });
    }
    return;
  }

  if (e.key === 'F9') {
    e.preventDefault();
    const ids = selectionIds();
    if (ids.length) openMovePicker(ids);
    return;
  }

  if (e.key.toLowerCase() === 'f') {
    e.preventDefault();
    openNewFolderDialog(S.selectedFolderId);
    return;
  }

  if (e.key === 'F8') {
    e.preventDefault();
    const records = currentSelectionRecords();
    if (records.length) openDeleteConfirm(records);
    return;
  }

  if (e.key === ' ') {
    if (S.focusPane === 'tiles' && S.selectedTileId) {
      e.preventDefault();
      if (S.markedTileIds.has(S.selectedTileId)) S.markedTileIds.delete(S.selectedTileId);
      else S.markedTileIds.add(S.selectedTileId);
      render();
    }
    return;
  }

  if (e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
    e.preventDefault();
    const direction = e.key === 'ArrowUp' ? 'up' : 'down';
    if (S.focusPane === 'tiles' && S.selectedTileId) {
      sendMutate('reorder', { id: S.selectedTileId, direction });
    } else if (S.focusPane === 'tree' && S.selectedFolderId !== 'root') {
      sendMutate('reorder', { id: S.selectedFolderId, direction });
    }
    return;
  }

  if (e.key === 'Enter') {
    if (S.focusPane === 'tiles' && S.selectedTileId) {
      const record = S.store.records.find((r) => r.id === S.selectedTileId);
      if (record) openBookmark(record);
    }
    return;
  }

  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
    e.preventDefault();
    if (S.focusPane === 'tree') {
      if (e.key === 'ArrowUp') S.selectedFolderId = visibleFolderNeighbors(-1);
      else if (e.key === 'ArrowDown') S.selectedFolderId = visibleFolderNeighbors(1);
      else if (e.key === 'ArrowRight') S.collapsed.delete(S.selectedFolderId);
      else if (e.key === 'ArrowLeft') {
        const record = S.store.records.find((r) => r.id === S.selectedFolderId);
        if (!S.collapsed.has(S.selectedFolderId) && hasFolderChildren(S.selectedFolderId)) S.collapsed.add(S.selectedFolderId);
        else if (record?.parentId) S.selectedFolderId = record.parentId;
      }
      S.selectedTileId = null;
      S.markedTileIds.clear();
      render();
    } else {
      if (e.key === 'ArrowUp') moveTileSelection(0, -1);
      else if (e.key === 'ArrowDown') moveTileSelection(0, 1);
      else if (e.key === 'ArrowLeft') moveTileSelection(-1, 0);
      else if (e.key === 'ArrowRight') moveTileSelection(1, 0);
    }
  }
});

function hasFolderChildren(id) {
  return getFolders(S.store.records, id).length > 0;
}

function selectionIds() {
  if (S.focusPane === 'tiles') {
    return S.markedTileIds.size ? Array.from(S.markedTileIds) : S.selectedTileId ? [S.selectedTileId] : [];
  }
  return S.selectedFolderId !== 'root' ? [S.selectedFolderId] : [];
}

function currentSelectionRecords() {
  return selectionIds()
    .map((id) => S.store.records.find((r) => r.id === id))
    .filter(Boolean);
}

// ------------------------------------------------------------------ init --

$('#theme-toggle').addEventListener('click', async () => {
  const next = S.theme === 'p1' ? 'p3' : 'p1';
  await ext.storage.local.set({ [Keys.THEME]: next });
});

$('#sync-pill').addEventListener('click', () => {
  S.screen = 'sync-status';
  render();
});

refreshFromStorage();
