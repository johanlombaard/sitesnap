// Cross-browser API surface. Chrome/Edge/Brave (Chromium, MV3) expose
// `chrome.*` with promise returns when no callback is passed (Chrome 88+).
// Firefox 121+ exposes the same promise-native surface under `browser.*`.
// This is the "small polyfill / feature-detect" called for in spec §13.7 —
// no need to vendor the full webextension-polyfill for what this extension
// touches (storage, alarms, tabs, runtime).
export const ext = globalThis.browser || globalThis.chrome;
