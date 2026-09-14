// Service worker: alarms, sync orchestration, auth polling. Spec §10, §13.2.
// Everything that touches GitHub lives here (spec §2.3). MV3 service workers
// terminate on idle — no sync state lives in module scope beyond a debounce
// timer and an in-flight promise chain, both rebuilt cheaply on next wake;
// anything that must survive a restart (dirty flag, device-flow state) is in
// storage.local (spec §13.2, §13.3).
import { ext } from './lib/compat.js';
import { GITHUB_CLIENT_ID } from './config.js';
import {
  Keys,
  getDeviceId,
  loadStore,
  saveStore,
  createFolder,
  createBookmark,
  updateRecord,
  deleteRecord,
  moveRecord,
  reorderWithinSiblings,
  recordOpened,
  getFlags,
  setFlag,
} from './lib/db.js';
import { merge, resolveTree, compactTombstones, highestUpdatedAt } from './lib/merge.js';
import * as gist from './lib/gist.js';
import * as auth from './lib/auth.js';

const PULL_ALARM = 'sitesnap-pull';
const PULL_PERIOD_MINUTES = 5;
const PUSH_DEBOUNCE_MS = 2000;

let pushTimer = null;
let syncChain = Promise.resolve();

/** Serialises pull/push so they never run concurrently (spec §7.7). */
function withSyncLock(fn) {
  const run = syncChain.then(fn, fn);
  syncChain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

function schedulePush(delay = PUSH_DEBOUNCE_MS) {
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    pushTimer = null;
    withSyncLock(doPush).catch((err) => recordError(err));
  }, delay);
}

async function recordError(err) {
  console.error('[sitesnap]', err);
  await setFlag(Keys.LAST_ERROR, err?.message || String(err));
}

async function ensureGistId(token, store) {
  const { [Keys.GIST_ID]: cached } = await getFlags(Keys.GIST_ID);
  if (cached) return cached;

  const found = await gist.discover(token);
  if (found) {
    if (found.multiple) {
      await setFlag(
        Keys.LAST_ERROR,
        'Multiple SiteSnap gists found on this account — using the most recently updated. Not merged automatically.'
      );
    }
    await setFlag(Keys.GIST_ID, found.gist.id);
    return found.gist.id;
  }

  const created = await gist.create(token, store);
  await setFlag(Keys.GIST_ID, created.gistId);
  await setFlag(Keys.BASE_VERSION, created.version);
  await setFlag(Keys.ETAG, created.etag);
  await setFlag(Keys.DIRTY, false);
  await setFlag(Keys.LAST_SYNC_AT, Date.now());
  return created.gistId;
}

/** Pull (spec §7.5), merging remote into local. */
async function doPull() {
  const { [Keys.TOKEN]: token, [Keys.DIRTY]: wasDirty } = await getFlags([Keys.TOKEN, Keys.DIRTY]);
  if (!token) return;

  const store = await loadStore();
  let gistId;
  try {
    gistId = await ensureGistId(token, store);
  } catch (err) {
    return handleSyncError(err);
  }
  // etag may be unset (freshly discovered gist, never pulled) — gist.pull()
  // treats that as "fetch unconditionally", which is exactly what we want.
  const { [Keys.ETAG]: etag } = await getFlags(Keys.ETAG);

  try {
    const result = await gist.pull(token, gistId, etag);
    if (result.rate) await setFlag('rateLimit', result.rate);
    if (!result.modified) {
      await setFlag(Keys.LAST_SYNC_AT, Date.now());
      return;
    }
    const deviceId = await getDeviceId();
    const merged = merge(store, result.store);
    resolveTree(merged.records, { deviceId, highestSeen: highestUpdatedAt(merged.records) });
    merged.records = compactTombstones(merged.records);

    await saveStore(merged, { dirty: !!wasDirty });
    await setFlag(Keys.ETAG, result.etag);
    await setFlag(Keys.BASE_VERSION, result.version);
    await setFlag(Keys.LAST_SYNC_AT, Date.now());
    await setFlag(Keys.LAST_ERROR, null);

    if (wasDirty) schedulePush(0); // still have local edits to send on top of the merge
  } catch (err) {
    return handleSyncError(err, gistId);
  }
}

/** Push (spec §7.6): read-check-write guarded by the commit SHA. */
async function doPush() {
  const { [Keys.TOKEN]: token, [Keys.GIST_ID]: gistId } = await getFlags([Keys.TOKEN, Keys.GIST_ID]);
  if (!token) return;
  if (!gistId) return doPull(); // no gist yet — pull path creates it

  const store = await loadStore();
  const { [Keys.BASE_VERSION]: baseVersion } = await getFlags(Keys.BASE_VERSION);

  try {
    const current = await gist.getCurrent(token, gistId);
    let toPush = store;
    if (current.version !== baseVersion) {
      const deviceId = await getDeviceId();
      const merged = merge(store, current.store);
      resolveTree(merged.records, { deviceId, highestSeen: highestUpdatedAt(merged.records) });
      merged.records = compactTombstones(merged.records);
      toPush = merged;
      await saveStore(toPush, { dirty: true });
    }
    const result = await gist.patch(token, gistId, toPush);
    if (result.rate) await setFlag('rateLimit', result.rate);
    await setFlag(Keys.BASE_VERSION, result.version);
    await setFlag(Keys.ETAG, result.etag);
    await setFlag(Keys.DIRTY, false);
    await setFlag(Keys.LAST_SYNC_AT, Date.now());
    await setFlag(Keys.LAST_ERROR, null);
  } catch (err) {
    return handleSyncError(err, gistId);
  }
}

async function handleSyncError(err, gistId) {
  if (err instanceof gist.GistAuthError) {
    await setFlag(Keys.TOKEN, null);
    await setFlag(Keys.LAST_ERROR, 'GitHub sign-in expired or was revoked. Please sign in again.');
    return;
  }
  if (err instanceof gist.GistNotFoundError) {
    await setFlag(Keys.GIST_ID, null);
    await setFlag(Keys.LAST_ERROR, 'The SiteSnap gist could not be found; will re-discover on next sync.');
    return;
  }
  if (err instanceof gist.GistRateLimitError) {
    await setFlag(
      Keys.LAST_ERROR,
      `GitHub API rate limit reached. Backing off until ${new Date(err.resetAt).toLocaleTimeString()}.`
    );
    if (err.resetAt) ext.alarms.create(PULL_ALARM, { when: err.resetAt + 1000 });
    return;
  }
  if (err instanceof gist.GistParseError) {
    // Pitfall §13.5: never wipe local data on a parse failure.
    await setFlag(Keys.LAST_ERROR, `Remote store is unreadable — keeping local data untouched: ${err.message}`);
    return;
  }
  await recordError(err);
}

async function performFullSync() {
  await doPull();
  const { [Keys.DIRTY]: dirty } = await getFlags(Keys.DIRTY);
  if (dirty) await doPush();
}

async function ensureInit() {
  await getDeviceId();
  await loadStore();
  ext.alarms.create(PULL_ALARM, { periodInMinutes: PULL_PERIOD_MINUTES });
  const { [Keys.DIRTY]: dirty } = await getFlags(Keys.DIRTY);
  withSyncLock(performFullSync).catch((err) => recordError(err));
  if (dirty) schedulePush(0);
}

ext.runtime.onStartup.addListener(ensureInit);
ext.runtime.onInstalled.addListener(ensureInit);

ext.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === PULL_ALARM) {
    withSyncLock(performFullSync).catch((err) => recordError(err));
  } else if (alarm.name === auth.AUTH_ALARM) {
    auth.pollOnce().then((r) => {
      if (r.status === 'success') withSyncLock(performFullSync).catch((err) => recordError(err));
    });
  }
});

// Toolbar icon opens app.html in a tab (never a popup — spec §2.8, §9), and
// captures the previously-active tab's URL/title via activeTab for "add
// this page" prefill (spec §9 notes). Deliberately just chrome.tabs.create —
// no chrome.tabs.query — since matching-by-URL "focus the existing tab
// instead" would need the "tabs" permission, and spec §9 is explicit that
// activeTab-only is a deliberate minimal-permissions choice, not an oversight.
ext.action.onClicked.addListener(async (tab) => {
  const appUrl = ext.runtime.getURL('ui/app.html');
  if (tab?.url && !tab.url.startsWith(appUrl)) {
    await ext.storage.local.set({ pendingQuickAdd: { url: tab.url, title: tab.title || '' } });
  }
  await ext.tabs.create({ url: appUrl });
});

const MUTATORS = {
  createFolder: (store, args, ctx) => createFolder(store, { ...args, deviceId: ctx.deviceId }),
  createBookmark: (store, args, ctx) => createBookmark(store, { ...args, deviceId: ctx.deviceId }),
  update: (store, args, ctx) => updateRecord(store, args.id, args.patch, ctx),
  delete: (store, args, ctx) => deleteRecord(store, args.id, ctx),
  move: (store, args, ctx) => moveRecord(store, args.id, args.target, ctx),
  reorder: (store, args, ctx) => reorderWithinSiblings(store, args.id, args.direction, ctx),
  recordOpened: (store, args, ctx) => recordOpened(store, args.id, ctx),
};

async function handleMessage(msg) {
  switch (msg?.type) {
    case 'mutate': {
      return withSyncLock(async () => {
        const fn = MUTATORS[msg.op];
        if (!fn) throw new Error(`unknown op: ${msg.op}`);
        const store = await loadStore();
        const deviceId = await getDeviceId();
        const result = fn(store, msg.args, { deviceId });
        await saveStore(store, { dirty: true });
        schedulePush();
        return { ok: true, record: result.record };
      }).catch((err) => ({ ok: false, error: err.message }));
    }
    case 'import': {
      return withSyncLock(async () => {
        await saveStore(msg.store, { dirty: true });
        schedulePush();
        return { ok: true };
      }).catch((err) => ({ ok: false, error: err.message }));
    }
    case 'sync-now': {
      return withSyncLock(performFullSync)
        .then(() => ({ ok: true }))
        .catch((err) => ({ ok: false, error: err.message }));
    }
    case 'auth-start': {
      if (!GITHUB_CLIENT_ID) {
        return { ok: false, error: 'No GitHub OAuth Client ID configured. Set GITHUB_CLIENT_ID in src/config.js.' };
      }
      try {
        const flow = await auth.startDeviceFlow(GITHUB_CLIENT_ID);
        await ext.tabs.create({ url: flow.verificationUriComplete || flow.verificationUri });
        return { ok: true, flow };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    }
    case 'auth-cancel': {
      await auth.clearDeviceFlow();
      return { ok: true };
    }
    default:
      return { ok: false, error: `unknown message type: ${msg?.type}` };
  }
}

ext.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  handleMessage(msg).then(sendResponse);
  return true; // keep the channel open for the async response
});
