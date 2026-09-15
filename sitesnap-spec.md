# SiteSnap — Build Specification

A standalone bookmark manager as a browser extension, with a terminal UI, syncing across
machines through a private GitHub Gist. No server, no hosting cost, no maintenance.

**Status:** ready to build. **Target:** Chrome/Edge (MV3) first, Firefox 121+ second.

---

## 1. Scope

### In scope

- A self-contained bookmark store: folders (a tree) and bookmarks (title, address, description, tags).
- A full-page UI styled as a monochrome phosphor terminal: folder tree on the left, bookmark tiles on the right.
- Create / rename / move / delete for both folders and bookmarks.
- Cross-machine sync via a single private ("secret") GitHub Gist.
- GitHub auth via OAuth **Device Flow** — no client secret, no server.

### Explicitly NOT in scope

| Not building | Why |
|---|---|
| Any use of `chrome.bookmarks` | This store stands alone. Never read it, never write it, never request the permission. |
| Any hosted API, proxy, or serverless function | The entire point. GitHub is the only backend. |
| Sharding the store across multiple gist files | One `bookmarks.json`. See §7.1 for the ceiling. |
| Multi-user / sharing / collaboration | Single user, multiple machines. |
| Keyboard shortcut dispatch into web pages | Not a shortcut manager. No content scripts at all. |
| Full CRDT merge | Last-write-wins plus a cycle-breaker is sufficient and far simpler. See §6. |
| Drag-and-drop reordering | **Deferred to v2, deliberately.** v1 moves and reorders via `F6` and the keyboard. The data model already supports drag (§5) so adding it later is UI-only — do not redesign anything to accommodate it now. |

---

## 2. Decisions already made — do not re-litigate

These were settled during design. Implement them as written; raise a flag only if you find a
concrete technical blocker, not a preference.

1. **Device Flow, not the web OAuth flow.** GitHub's web flow requires a `client_secret` to
   exchange the code, and GitHub does not support PKCE for OAuth Apps. An extension cannot hold a
   secret. Device Flow is the only secret-less path.
2. **Register an OAuth App, not a GitHub App.** OAuth App tokens do not expire. GitHub App tokens
   expire in 8 hours and drag refresh-token handling into the service worker.
3. **All GitHub calls happen in the service worker.** GitHub's OAuth endpoints send no CORS
   headers; only a background context with matching `host_permissions` can reach them.
4. **Local-first.** Every user action writes `storage.local` and returns immediately. The gist push
   is debounced behind it. The UI never blocks on the network.
5. **Whole-record LWW**, not field-level. This is what keeps `parentId` and `position` travelling
   together — resolving them independently can land a record in one parent at a position computed
   for a different one.
6. **Deletes write tombstones.** Without them, a delete on machine A is indistinguishable from
   "machine B has a record A lacks", and the record resurrects on the next pull.
7. **Fractional indexing for order**, so moving one item rewrites one record rather than
   renumbering every sibling — which would turn one move into N conflicting writes on the next
   merge. This holds even without drag-and-drop: two machines inserting into the same folder while
   offline must not fight over sibling numbering.
8. **A full page, not a popup.** Two panes plus tiles do not fit a browser action popup.
9. **The token lives in `storage.local` only.** Never `storage.sync` — that would replicate it
   through Google's servers.

---

## 3. Data model

One JSON document. Flat array of records; the tree is expressed by `parentId`.

```ts
type Id = string;          // uuid v4, lowercase, hyphenated
type FracIdx = string;     // fractional index, see §5

interface BaseRecord {
  id: Id;
  parentId: Id | null;     // null for a top-level item — there is no single root folder;
                           // any number of folders/bookmarks may sit at the top level
  position: FracIdx;       // order among siblings
  updatedAt: number;       // epoch ms, see §6.1 for the clock clamp
  origin: string;          // deviceId of the last writer — LWW tiebreak only
  deleted: boolean;        // tombstone
}

interface Folder extends BaseRecord {
  kind: 'folder';
  name: string;
}

interface Bookmark extends BaseRecord {
  kind: 'bookmark';
  title: string;
  url: string;             // stored as entered; normalised only for dedupe
  description: string;     // may be empty; up to ~500 chars
  tags: string[];          // lowercase, deduped, sorted
  createdAt: number;
  openCount: number;
  lastOpenedAt: number | null;
}

type Record = Folder | Bookmark;

interface Store {
  schema: 1;               // bump only for breaking shape changes
  records: Record[];
}
```

### Fixed records

- There is **no single root folder**. Any folder or bookmark may have `parentId: null`, meaning
  it sits at the top level as a sibling of every other top-level item. The UI's tree pane wraps
  these in a virtual, non-editable top-level anchor for navigation only — it is never a real
  record and is never sent to the gist.
- A folder with id `"__recovered"` is created **lazily** by the cycle-breaker (§6.3). If it does
  not exist when needed, create it as a top-level folder (`parentId: null`).

### Invariants

- A record either has `parentId: null` (top level) or a `parentId` naming a live folder.
- Every record is reachable by following `parentId` upward until it reaches `null`.
- `(parentId, position)` is unique per sibling set. Collisions are tolerated (sort is stable by
  `position` then `id`) but should not be generated.
- A bookmark is never a parent.

### Migration from the single-root model

Earlier builds seeded a fixed `"root"` folder (`id: "root"`, `parentId: null`) and parented every
top-level item to it. On load, and after every merge, strip any record with `id === "root"` and
reparent whatever pointed at it (`parentId === "root"`) to `null` instead. This runs automatically
and needs no user action; see `normalizeLegacyRoot` in `merge.js`.

---

## 4. Local storage layout

All under `chrome.storage.local`. Nothing goes in `chrome.storage.sync`.

| Key | Type | Meaning |
|---|---|---|
| `store` | `Store` | The full document. Source of truth for the UI. |
| `deviceId` | `string` | Generated once on install: `<hostname-ish slug>-<6 hex>`. Used as `origin`. |
| `token` | `string \| null` | GitHub OAuth access token. |
| `gistId` | `string \| null` | Cached gist id. |
| `etag` | `string \| null` | Last `ETag` from `GET /gists/{id}`, for `If-None-Match`. |
| `baseVersion` | `string \| null` | `history[0].version` (commit SHA) of the last state we know about. |
| `dirty` | `boolean` | Local changes not yet pushed. |
| `lastSyncAt` | `number \| null` | Epoch ms of last successful pull or push. |
| `lastError` | `string \| null` | Human-readable last sync failure, shown in the status screen. |

---

## 5. Fractional indexing

**Vendor the `fractional-indexing` package (MIT, ~1 KB)** rather than writing this from scratch —
the edge cases around adjacent keys and integer-part overflow are where hand-rolled versions break.
Use `generateKeyBetween(a, b)`.

Required behaviour:

- `generateKeyBetween(null, null)` → a valid first key.
- `generateKeyBetween(a, null)` → sorts after `a` (append to end).
- `generateKeyBetween(null, b)` → sorts before `b` (prepend).
- `generateKeyBetween(a, b)` → sorts strictly between, for any `a < b`, including adjacent keys.
- Keys compare correctly under plain lexicographic `<` on the resulting strings.

**Sibling ordering is always** `sort by (position ASC, id ASC)`. The `id` tiebreak makes ordering
deterministic across machines when two records somehow share a position.

**On move**, compute `generateKeyBetween(prevSibling?.position ?? null, nextSibling?.position ?? null)`
in the *destination* folder, and write `parentId` + `position` in the same record update.

---

## 6. Merge

Runs after every successful pull, before the merged result is written to `storage.local`.

```
merge(localStore, remoteStore) -> Store
```

### 6.1 Per-record last-write-wins

```js
function pickWinner(a, b) {
  if (!a) return b;
  if (!b) return a;
  if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt ? a : b;
  return a.origin > b.origin ? a : b;   // deterministic tiebreak, never random
}
```

Union the ids from both sides; for each id, `pickWinner`. Whole records, never field-by-field.

**Clock clamp.** When writing any record locally, set

```js
updatedAt = Math.max(Date.now(), highestUpdatedAtSeenAnywhere + 1)
```

Without this, one machine with a fast clock wins every conflict forever. Track
`highestUpdatedAtSeenAnywhere` across both local records and every record seen in a pull.

### 6.2 Tombstones

- Deleting a record sets `deleted: true` and bumps `updatedAt`. It is never removed from the array.
- Deleting a **folder** cascades: every descendant (folders and bookmarks) is tombstoned in the
  same operation, each with its own bumped `updatedAt`.
- **Compaction:** on each successful sync, drop tombstones where `updatedAt` is older than 30 days.
  Both machines converge on dropping them because both use the same rule on the same values.

### 6.3 Cycle-breaker — required

LWW on a tree can produce cycles. Move folder A into B on one machine while the other moves B into
A; both writes are accepted and neither reaches the top level.

Run this after every merge, and also after any local move:

```
resolveTree(records):
  live  := records where !deleted
  byId  := index of live by id
  for node in live:
      seen  := {}
      cur   := node
      ok    := false
      while true:
          if cur.parentId == null:              ok = true; break     // reached the top level
          if seen[cur.id]:                      ok = false; break     // cycle
          seen[cur.id] = true
          parent := byId[cur.parentId]
          if parent == null:                    ok = false; break     // orphan / dead parent
          if parent.kind != 'folder':           ok = false; break     // bookmark as parent
          cur := parent
      if not ok:
          ensure '__recovered' folder exists (top-level, parentId: null)
          node.parentId = '__recovered'
          node.position = generateKeyBetween(lastPositionIn('__recovered'), null)
          node.updatedAt = clampedNow()
          node.origin    = deviceId
```

Notes for the implementer:

- Bumping `updatedAt` is deliberate: the repair must propagate, or the other machine keeps
  re-sending the broken state.
- Both machines may repair independently. They converge because both reparent to the same
  `__recovered` folder; only `position` may differ, and LWW settles that.
- A `parentId` of `null` is always valid — there is no single root to reach, only the top level.
- Cap the upward walk at `live.length` iterations as a belt-and-braces guard.

---

## 7. Gist transport

### 7.1 Shape on GitHub

One secret gist, two files:

| File | Content |
|---|---|
| `bookmarks.json` | `JSON.stringify(store, null, 0)` |
| `.sitesnap-marker` | the literal string `sitesnap-store:v1` |

Description: `SiteSnap — bookmark store (managed by the SiteSnap extension)`.

**Sizing.** At roughly 220 bytes of JSON per record, the Gist API's ~1 MB response-truncation
threshold lands near **5,000 records**. Do not shard. If `files["bookmarks.json"].truncated === true`
in a response, fetch `files["bookmarks.json"].raw_url` for the full content and surface a warning in
the status screen.

### 7.2 Common headers

```
Authorization: Bearer <token>
Accept: application/vnd.github+json
X-GitHub-Api-Version: 2022-11-28
```

### 7.3 Discovery (fresh machine, no cached `gistId`)

1. `GET /gists?per_page=100`, paginating while a `Link: <...>; rel="next"` header is present.
2. Filter to gists whose `files` object has a key `.sitesnap-marker`.
3. For each candidate (normally zero or one), `GET /gists/{id}` and confirm the `.sitesnap-marker`
   content is exactly `sitesnap-store:v1`.
4. If found → cache `gistId`. If not found → create (§7.4).

**Match on the marker file, never on the description** — a person will eventually edit the
description in the GitHub UI.

If more than one matches, pick the most recently `updated_at` and surface a warning. Do not merge
them automatically.

### 7.4 Create

```
POST /gists
{
  "description": "SiteSnap — bookmark store (managed by the SiteSnap extension)",
  "public": false,
  "files": {
    "bookmarks.json":    { "content": "<serialised store>" },
    ".sitesnap-marker":  { "content": "sitesnap-store:v1" }
  }
}
```

`"public": false` produces a *secret* gist — unlisted, but readable by anyone with the URL. This is
the correct and only option; note it in the UI so the user isn't surprised.

### 7.5 Pull

```
GET /gists/{gistId}
If-None-Match: <etag>       (omit if none cached)
```

- **304** → nothing changed. Update `lastSyncAt`. Done. **These do not count against the rate
  limit**, which is what makes a 5-minute poll free.
- **200** → parse `files["bookmarks.json"].content` (or `raw_url` if truncated). Merge (§6). Write
  merged store, new `etag`, and `history[0].version` as `baseVersion`.
- **401** → token dead. Clear `token`, set `lastError`, trigger the auth flow (§8).
- **404** → gist deleted or inaccessible. Clear `gistId` and re-run discovery.
- **403 with `x-ratelimit-remaining: 0`** → back off until `x-ratelimit-reset`.

### 7.6 Push

The Gist API has no compare-and-swap, so guard with the commit SHA:

1. `GET /gists/{gistId}` **without** `If-None-Match` (we need the current version).
2. If `history[0].version !== baseVersion`, the remote moved: merge it into local first (§6), then
   continue with the merged document.
3. ```
   PATCH /gists/{gistId}
   { "files": { "bookmarks.json": { "content": "<serialised merged store>" } } }
   ```
4. On 200, store the response's `history[0].version` as the new `baseVersion` and the new `ETag`.
   Clear `dirty`.

The race window between step 1 and step 3 is milliseconds and there is one user. Accept it.

### 7.7 Scheduling

- **Push:** debounce **2000 ms** after the last local write. This is load-bearing, not a nicety —
  a single-file store means every push re-uploads the whole document, so without coalescing,
  typing in the description field would upload the entire library per keystroke.
- **Pull:** `chrome.alarms` every 5 minutes, plus on `chrome.runtime.onStartup`, plus when the
  manager page regains focus.
- Never run a push and a pull concurrently. Serialise through a single in-flight promise.

---

## 8. Authentication — OAuth Device Flow

Register an **OAuth App** at `https://github.com/settings/developers`. Scope: `gist` only. The
`client_id` is not a secret and ships in the extension.

### 8.1 Request a device code

```
POST https://github.com/login/device/code
Accept: application/json
Content-Type: application/json

{ "client_id": "<CLIENT_ID>", "scope": "gist" }
```

Response: `{ device_code, user_code, verification_uri, expires_in, interval }`

### 8.2 Send the user

`chrome.tabs.create({ url: verification_uri })`. If the response includes
`verification_uri_complete`, prefer it — it pre-fills the code.

Display `user_code` prominently in the extension UI, with a copy button.

> If the user is already signed in to github.com, this is a single Authorize click. If their
> session has expired, GitHub shows its own login page. The extension never sees a password.

### 8.3 Poll for the token

Every `interval` seconds (start with the server's value, default 5):

```
POST https://github.com/login/oauth/access_token
Accept: application/json
Content-Type: application/json

{
  "client_id": "<CLIENT_ID>",
  "device_code": "<device_code>",
  "grant_type": "urn:ietf:params:oauth:grant-type:device_code"
}
```

| Response | Action |
|---|---|
| `{ access_token }` | Store in `storage.local`. Done. |
| `{ error: "authorization_pending" }` | Keep polling at the current interval. |
| `{ error: "slow_down" }` | **Increase interval by 5 s** and keep polling. Required by spec. |
| `{ error: "expired_token" }` | Stop. Show "code expired", offer restart. |
| `{ error: "access_denied" }` | Stop. User declined. |

Stop after `expires_in` regardless.

### 8.4 Re-auth

Any `401` from the API → clear `token`, set `lastError`, surface the auth screen. That is the whole
"login expired" path.

---

## 9. Manifest

```json
{
  "manifest_version": 3,
  "name": "SiteSnap",
  "version": "1.0.0",
  "description": "A bookmark manager that syncs through a private GitHub Gist.",
  "permissions": ["storage", "alarms", "activeTab"],
  "host_permissions": [
    "https://github.com/*",
    "https://api.github.com/*"
  ],
  "background": { "service_worker": "sw.js", "type": "module" },
  "action": { "default_title": "SiteSnap" },
  "browser_specific_settings": {
    "gecko": { "id": "sitesnap@example.com", "strict_min_version": "121.0" }
  }
}
```

Notes:

- **`activeTab`, not `tabs`.** It is granted on action click and is all that's needed to read the
  current page's URL and title for "add this page". `tabs` would be over-asking.
- **No `bookmarks` permission.** Do not add it. This store is independent, and asking for a user's
  entire bookmark tree draws real Web Store review scrutiny for no benefit.
- Clicking the action opens `app.html` in a tab (`chrome.tabs.create`), not a popup.
- Firefox needs `browser_specific_settings.gecko.id` or `storage` behaves inconsistently.

---

## 10. Module layout

```
src/
  sw.js                  service worker: alarms, sync orchestration, auth polling
  lib/
    db.js                storage.local access; record CRUD; clock clamp
    merge.js             pickWinner, merge, resolveTree, compactTombstones
    fracidx.js           vendored fractional-indexing
    gist.js              GitHub Gist client (discover/create/pull/push)
    auth.js              device flow
    tree.js              flat records -> nested tree; sibling ordering
  ui/
    app.html
    app.js               render + interaction
    app.css              the terminal theme
```

The UI talks to the service worker via `chrome.runtime.sendMessage` for sync actions, and reads
`storage.local` directly for the store. Subscribe to `chrome.storage.onChanged` to re-render when
a background sync lands.

---

## 11. UI

A working visual mockup of every screen is at:
**https://claude.ai/code/artifact/e0daa6d0-0c9e-4794-a856-0b2bf8643825**

Match its layout and behaviour. Key points:

### Theme

- Single committed dark theme, monochrome. No light mode.
- Default **P1 green**: ground `#0b1410`, text `#74d68a`, bright `#c4f0cf`, dim `#479660`,
  rules `#1d4230`.
- Optional **P3 amber** toggle: ground `#12100a`, text `#e0a743`, bright `#f6d8a0`,
  dim `#8d6526`, rules `#42320f`.
- Fonts: `VT323` for terminal content, `IBM Plex Mono` for annotations. Both from Google Fonts,
  with real monospace fallback stacks.
- **Emphasis is intensity, reverse video, and underline only.** No second hue — not for errors,
  not for success. A monochrome phosphor tube has one colour. This is the design constraint;
  hold it.
- Subtle scanline overlay and vignette. Keep them light — they were tuned down once already
  because they caused eye strain.

### Screens

1. **Browser** (primary, 120 columns) — folder tree left (30ch, indented, `+`/`-` collapse
   markers; no bookmark counts — a virtual top-level anchor wraps the real, multi-root forest of
   folders for navigation only), bookmark tiles right (3-across grid; index letter, title, host,
   description). Selected folder and selected tile in reverse video. Bottom bar:
   `F2 rename · F4 edit · F6 move · F7 new folder · F8 delete · ^N new bookmark · / find · ^S sync`.
2. **Bookmark editor** (80 col dialog) — title, address, description, folder, tags, plus read-only
   added/opened stats.
3. **Folder management** — new folder dialog and a move target picker.
4. **Auth** — device code displayed large in reverse video, with the waiting state.
5. **Sync status** — gist id, version, record counts, rate limit, tree consistency, per-device
   last-seen table.

### Interaction requirements

- Clicking a folder loads its tiles. Clicking `+`/`-` collapses a branch without changing selection.
- `/` filters bookmarks within the current folder; `//` searches all folders.
- **No drag-and-drop in v1.** All moving and reordering happens through:
  - `F6` on a selected tile or folder → a move dialog listing folders as targets (screen 03 of the
    mockup). `Space` marks multiple tiles first for a bulk move.
  - `Shift+Up` / `Shift+Down` on a selected tile → move it one place among its siblings.
  - Both write `parentId` + `position` via `generateKeyBetween` exactly as §5 describes.
- Full keyboard operation: arrows move, `Enter` opens, the F-keys above, `Esc` closes dialogs.
- Visible focus states. Respect `prefers-reduced-motion` (the only animation is a blinking cursor).

---

## 12. Acceptance criteria

Ship when all of these pass.

### Store

- [ ] Create, rename, move, and delete folders and bookmarks; all persist across a browser restart.
- [ ] Deleting a folder tombstones every descendant.
- [ ] Reordering one bookmark among 50 siblings (via `Shift+Up`/`Shift+Down`) modifies exactly
      **one** record.
- [ ] `F6` moves a single selection, and a multi-selection marked with `Space`, into another folder.
- [ ] A folder cannot be moved into itself or into one of its own descendants — the move dialog
      excludes those targets rather than relying on the cycle-breaker to clean up afterwards.
- [ ] Any number of folders and bookmarks can sit at the top level (`parentId: null`) as full
      siblings of each other — there is no single fixed root folder to route them through.

### Sync

- [ ] First run with no gist creates one; `.sitesnap-marker` and `bookmarks.json` are both present and
      the gist is secret.
- [ ] A second machine with the same account finds the existing gist via the marker and pulls it —
      no duplicate gist is created.
- [ ] An idle hour of 5-minute polling consumes **0** rate-limit units (all 304s). Verify against
      `x-ratelimit-remaining`.
- [ ] Editing a description with rapid typing produces exactly one PATCH, not one per keystroke.

### Merge

- [ ] Edit the same bookmark's title on two machines while both are offline; on reconnect both
      converge to the same title, and it is the one with the later `updatedAt`.
- [ ] Delete a bookmark on A while editing it on B; after both sync, the record is deleted on both
      (the tombstone's `updatedAt` is later) — and it does **not** reappear on a subsequent poll.
- [ ] Set one machine's clock 2 hours fast, make a change on the other; the slow machine's later
      edit still wins. (Clock clamp.)
- [ ] **Cycle test:** offline, move folder A into B on machine 1 and B into A on machine 2. After
      both sync, both machines show an identical tree, every node reaches the top level, and the
      displaced folder sits in `__recovered`. Nothing is lost.
- [ ] Tombstones older than 30 days disappear from both machines' stores.

### Auth

- [ ] With a live github.com session, the device flow completes in one Authorize click.
- [ ] With no session, GitHub's own login page appears; after signing in, the flow completes.
- [ ] Revoking the app at github.com/settings/applications produces a 401 on the next sync, which
      surfaces the auth screen rather than failing silently.
- [ ] A `slow_down` response increases the poll interval by 5 s.
- [ ] The token appears nowhere in `chrome.storage.sync` and is never logged.

### UI

- [ ] The manager works entirely from the keyboard.
- [ ] 500 bookmarks across 20 folders renders and filters without visible lag.
- [ ] Long titles, long descriptions, and long folder names truncate or wrap — never overflow the
      pane or force horizontal page scroll.
- [ ] Both phosphor themes are legible; no colour is used to carry meaning.

---

## 13. Known pitfalls

1. **CORS on the OAuth endpoints.** `https://github.com/login/*` sends no CORS headers. Calling it
   from the UI page fails. It must run in the service worker, which bypasses CORS for hosts in
   `host_permissions`.
2. **MV3 service workers terminate.** Do not hold sync state in module-level variables across an
   idle period. Persist anything that must survive (the in-flight device-flow `device_code`, the
   dirty flag) to `storage.local`. Use `chrome.alarms`, never `setInterval`, for the poll.
3. **Device-flow polling across a worker restart.** The poll loop must be resumable — store
   `device_code`, `interval`, and the deadline, and re-arm via an alarm.
4. **Echo loops.** After a pull writes the merged store, `chrome.storage.onChanged` fires. Make
   sure the UI re-render path does not treat that as a user edit and mark the store dirty.
5. **`JSON.parse` on gist content can fail** — a truncated response or a hand-edit in the GitHub
   UI. Never let a parse failure wipe local data. On failure: keep local, set `lastError`, do not
   push over the remote until the user resolves it.
6. **Secret gists are not private gists.** Anyone with the URL can read it. Say so in the UI.
7. **Firefox needs the gecko id** and its `browser.*` namespace; use a small polyfill or feature-detect.
8. **Do not normalise URLs destructively.** Store what the user entered. Normalise only for
   duplicate detection, and only for comparison.

---

## 14. Build order

1. `db.js` + the data model + a seeded store. No network.
2. The UI against local data only — tree, tiles, all CRUD, keyboard. Fully usable offline.
3. `merge.js` with unit tests, including the cycle test. Pure functions, no I/O — test it hard here,
   because debugging it through the network later is miserable.
4. `auth.js` — device flow end to end.
5. `gist.js` — discover, create, pull, push, with the SHA guard.
6. Wire into `sw.js`: alarms, debounce, serialisation.
7. Export/import JSON. Cheap, and it is the backup, the migration path, and the debugging tool.
