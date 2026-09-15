# SiteSnap

A standalone bookmark manager browser extension — monochrome phosphor-terminal
UI, syncing across machines through a single private GitHub Gist. No server,
no `chrome.bookmarks`, no hosting cost. See `sitesnap-spec.md` for the full
design.

## Browser support

Built as a plain Manifest V3 extension with no Chrome-Store-only APIs (no
`chrome.identity`, which Brave/other Chromium forks support inconsistently —
auth instead uses GitHub's OAuth **Device Flow** directly over `fetch`, per
spec §8). That means it loads and runs identically in:

- **Chrome / Edge / Brave** — same MV3 build, load unpacked from `src/`.
- **Firefox 121+** — same source; `browser_specific_settings.gecko.id` is set
  so `storage` behaves correctly (spec §9).

Brave Shields does not block anything here: the sync calls run from the
extension's own service worker (`chrome-extension://…` origin), not from a
tracked webpage, and Google Fonts have real monospace fallback stacks in case
a font ever fails to load.

## One-time setup

1. **Register a GitHub OAuth App** (not a GitHub App — spec §2.2) at
   <https://github.com/settings/developers> → "New OAuth App". Homepage URL
   and Authorization callback URL can be anything (e.g.
   `https://github.com/settings/developers`) — Device Flow never redirects
   there.
2. Copy the generated **Client ID** into `src/config.js`:
   ```js
   export const GITHUB_CLIENT_ID = 'Iv1.xxxxxxxxxxxxxxxx';
   ```
   The client ID is not a secret (spec §8) — this file just isn't
   pre-filled because the OAuth App is yours to register.
3. Load the extension:
   - **Chrome / Edge / Brave**: open `chrome://extensions` (or
     `brave://extensions`), enable **Developer mode**, **Load unpacked**,
     select the `src/` folder.
   - **Firefox**: open `about:debugging#/runtime/this-firefox`, **Load
     Temporary Add-on…**, select `src/manifest.json`. (Temporary add-ons
     unload on browser restart — for a permanent install you'd sign the
     build through addons.mozilla.org, out of scope here.)
4. Click the toolbar icon to open the manager in a tab, then use the sync
   status screen (click the `sync` pill, top right) → **Sign in with
   GitHub** to connect. Everything works fully offline before that — sync is
   additive, not required (spec §2.4).

## Project layout

```
src/
  manifest.json
  config.js              GITHUB_CLIENT_ID — fill this in, see above
  sw.js                   service worker: alarms, sync orchestration, auth polling
  lib/
    db.js                 storage.local access; record CRUD; clock clamp
    merge.js               pickWinner, merge, resolveTree, compactTombstones
    fracidx.js              vendored fractional-indexing
    gist.js                GitHub Gist client (discover/create/pull/push)
    auth.js                 device flow
    tree.js                  flat records -> nested tree; sibling ordering
    compat.js                 chrome.*/browser.* namespace shim
  ui/
    app.html / app.js / app.css   the terminal UI
tests/
  merge.test.mjs           pure-function tests incl. the cycle-breaker test
  fracidx.test.mjs
```

## Tests

```
npm test
```

Runs `merge.js` and `fracidx.js` unit tests (pure functions, no browser
needed) with Node's built-in test runner, including the two-machine cycle
test from spec §6.3 (fold A into B on one machine, B into A on another,
verify both converge with every node reaching the top level).

## Keyboard reference

`F2` rename · `F4` edit · `F9` move (mark multiple with `Space` first) ·
`F` new folder · `F8` delete · `N` new bookmark · `/` find in folder ·
`//` find everywhere · `Shift+↑/↓` reorder among siblings · `Ctrl+S` sync now

Note: spec §11 originally specified `F6`/`F7`/`Ctrl+N` for move/new
folder/new bookmark. Those are hard-reserved by Chrome and Firefox (`Ctrl+N`
opens a new browser window, `F6` refocuses the address bar, `F7` pops a
"turn on caret browsing?" prompt) and a page cannot `preventDefault()` its
way out of them, so they were remapped to unmodified keys that browsers
never bind to anything.
· `Esc` close/back.
