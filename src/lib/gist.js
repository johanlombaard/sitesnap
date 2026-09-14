// GitHub Gist transport. Spec §7. Runs only in the service worker (§2.3) —
// GitHub sends no CORS headers on these endpoints from a page context.

const API = 'https://api.github.com';
const MARKER_NAME = '.sitesnap-marker';
const STORE_NAME = 'bookmarks.json';
const MARKER_CONTENT = 'sitesnap-store:v1';
export const DESCRIPTION = 'SiteSnap — bookmark store (managed by the SiteSnap extension)';

export class GistAuthError extends Error {}
export class GistNotFoundError extends Error {}
export class GistRateLimitError extends Error {
  constructor(message, resetAt) {
    super(message);
    this.resetAt = resetAt;
  }
}
export class GistParseError extends Error {
  constructor(message, rawContent) {
    super(message);
    this.rawContent = rawContent;
  }
}

function baseHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

function rateInfo(res) {
  const remaining = res.headers.get('x-ratelimit-remaining');
  const limit = res.headers.get('x-ratelimit-limit');
  const reset = res.headers.get('x-ratelimit-reset');
  return {
    remaining: remaining != null ? Number(remaining) : null,
    limit: limit != null ? Number(limit) : null,
    resetAt: reset != null ? Number(reset) * 1000 : null,
  };
}

async function checkCommonErrors(res) {
  if (res.status === 401) throw new GistAuthError('token invalid or revoked');
  if (res.status === 403) {
    const info = rateInfo(res);
    if (info.remaining === 0) {
      throw new GistRateLimitError('rate limited', info.resetAt);
    }
    throw new Error(`forbidden (${res.status})`);
  }
}

function parseNextLink(linkHeader) {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(',')) {
    const m = part.match(/<([^>]+)>\s*;\s*rel="next"/);
    if (m) return m[1];
  }
  return null;
}

function parseStoreContent(raw) {
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new GistParseError(`could not parse bookmarks.json: ${e.message}`, raw);
  }
}

async function fullStoreFromGistPayload(token, gist) {
  const file = gist.files?.[STORE_NAME];
  if (!file) throw new Error('bookmarks.json missing from gist');
  let content = file.content;
  if (file.truncated && file.raw_url) {
    const res = await fetch(file.raw_url);
    if (!res.ok) throw new Error(`could not fetch raw_url: ${res.status}`);
    content = await res.text();
  }
  return parseStoreContent(content);
}

/**
 * Discovery (spec §7.3): find the gist tagged with the marker file. Matches
 * on file presence + content, never on description (a person may edit that).
 * Returns null if none found. If more than one candidate matches, returns
 * the most recently updated with `multiple: true` so the caller can warn.
 */
export async function discover(token) {
  let url = `${API}/gists?per_page=100`;
  const candidateIds = [];
  while (url) {
    const res = await fetch(url, { headers: baseHeaders(token) });
    await checkCommonErrors(res);
    if (!res.ok) throw new Error(`gist list failed: ${res.status}`);
    const gists = await res.json();
    for (const g of gists) {
      if (g.files && Object.prototype.hasOwnProperty.call(g.files, MARKER_NAME)) {
        candidateIds.push(g.id);
      }
    }
    url = parseNextLink(res.headers.get('Link'));
  }
  if (candidateIds.length === 0) return null;

  const confirmed = [];
  for (const id of candidateIds) {
    const res = await fetch(`${API}/gists/${id}`, { headers: baseHeaders(token) });
    await checkCommonErrors(res);
    if (!res.ok) continue;
    const gist = await res.json();
    if (gist.files?.[MARKER_NAME]?.content === MARKER_CONTENT) confirmed.push(gist);
  }
  if (confirmed.length === 0) return null;
  confirmed.sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
  return { gist: confirmed[0], multiple: confirmed.length > 1 };
}

/** Create (spec §7.4). Always `public: false` (a secret gist). */
export async function create(token, store) {
  const res = await fetch(`${API}/gists`, {
    method: 'POST',
    headers: { ...baseHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      description: DESCRIPTION,
      public: false,
      files: {
        [STORE_NAME]: { content: JSON.stringify(store) },
        [MARKER_NAME]: { content: MARKER_CONTENT },
      },
    }),
  });
  await checkCommonErrors(res);
  if (!res.ok) throw new Error(`gist create failed: ${res.status}`);
  const gist = await res.json();
  return {
    gistId: gist.id,
    version: gist.history?.[0]?.version ?? null,
    etag: res.headers.get('ETag'),
    rate: rateInfo(res),
  };
}

/**
 * Pull (spec §7.5). Returns `{ modified: false, rate }` on 304 (free — does
 * not count against rate limit), or `{ modified: true, store, version, etag, rate }` on 200.
 * Throws GistAuthError / GistNotFoundError / GistRateLimitError / GistParseError as appropriate.
 */
export async function pull(token, gistId, etag) {
  const headers = baseHeaders(token);
  if (etag) headers['If-None-Match'] = etag;
  const res = await fetch(`${API}/gists/${gistId}`, { headers });
  if (res.status === 304) {
    return { modified: false, rate: rateInfo(res) };
  }
  if (res.status === 404) throw new GistNotFoundError('gist not found');
  await checkCommonErrors(res);
  if (!res.ok) throw new Error(`gist pull failed: ${res.status}`);
  const gist = await res.json();
  const store = await fullStoreFromGistPayload(token, gist);
  return {
    modified: true,
    store,
    version: gist.history?.[0]?.version ?? null,
    etag: res.headers.get('ETag'),
    rate: rateInfo(res),
  };
}

/**
 * Fetch the gist's current state without a conditional header — used by
 * push (spec §7.6 step 1) since we need the live commit version regardless
 * of etag.
 */
export async function getCurrent(token, gistId) {
  const res = await fetch(`${API}/gists/${gistId}`, { headers: baseHeaders(token) });
  if (res.status === 404) throw new GistNotFoundError('gist not found');
  await checkCommonErrors(res);
  if (!res.ok) throw new Error(`gist read failed: ${res.status}`);
  const gist = await res.json();
  const store = await fullStoreFromGistPayload(token, gist);
  return {
    store,
    version: gist.history?.[0]?.version ?? null,
    etag: res.headers.get('ETag'),
    rate: rateInfo(res),
  };
}

/** Push (spec §7.6 step 3-4). Caller has already reconciled `baseVersion` via getCurrent(). */
export async function patch(token, gistId, store) {
  const res = await fetch(`${API}/gists/${gistId}`, {
    method: 'PATCH',
    headers: { ...baseHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ files: { [STORE_NAME]: { content: JSON.stringify(store) } } }),
  });
  await checkCommonErrors(res);
  if (!res.ok) throw new Error(`gist push failed: ${res.status}`);
  const gist = await res.json();
  return {
    version: gist.history?.[0]?.version ?? null,
    etag: res.headers.get('ETag'),
    rate: rateInfo(res),
  };
}
