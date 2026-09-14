// GitHub OAuth Device Flow (spec §8). Runs only in the service worker —
// github.com/login/* sends no CORS headers to a page context (spec §13.1).
import { ext } from './compat.js';
import { Keys } from './db.js';

const DEVICE_CODE_URL = 'https://github.com/login/device/code';
const TOKEN_URL = 'https://github.com/login/oauth/access_token';
const SCOPE = 'gist';
export const AUTH_ALARM = 'sitesnap-auth-poll';

// chrome.alarms clamps delays under ~1 minute in packed/production extensions
// (unpacked dev-mode installs can go faster). GitHub's device flow only
// forbids polling *faster* than the server's requested interval — polling
// slower is always fine — so a 1-minute floor here is compliant, just
// occasionally slower than the server's 5s suggestion to pick up the token.
const ALARM_FLOOR_MINUTES = 1;

async function get(keys) {
  return ext.storage.local.get(keys);
}
async function set(obj) {
  return ext.storage.local.set(obj);
}

function armAlarm(intervalSeconds) {
  ext.alarms.create(AUTH_ALARM, { delayInMinutes: Math.max(intervalSeconds / 60, ALARM_FLOOR_MINUTES) });
}

export async function clearDeviceFlow() {
  await set({ [Keys.DEVICE_FLOW]: null });
  ext.alarms.clear(AUTH_ALARM);
}

/** Step 1 (spec §8.1): request a device code and persist resumable poll state. */
export async function startDeviceFlow(clientId) {
  const res = await fetch(DEVICE_CODE_URL, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: clientId, scope: SCOPE }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    throw new Error(`device code request failed: ${data.error_description || data.error || res.status}`);
  }
  const interval = data.interval || 5;
  const deviceFlow = {
    clientId,
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUri: data.verification_uri,
    verificationUriComplete: data.verification_uri_complete || null,
    interval,
    deadline: Date.now() + data.expires_in * 1000,
    status: 'pending',
    message: null,
  };
  await set({ [Keys.DEVICE_FLOW]: deviceFlow });
  armAlarm(interval);
  return deviceFlow;
}

/**
 * Step 2 (spec §8.3): a single poll attempt. Persists the outcome to
 * storage.local so the UI (which cannot see alarm callbacks directly) picks
 * it up via chrome.storage.onChanged, and re-arms itself while pending.
 */
export async function pollOnce() {
  const { [Keys.DEVICE_FLOW]: flow } = await get(Keys.DEVICE_FLOW);
  if (!flow) return { status: 'idle' };

  if (Date.now() > flow.deadline) {
    await clearDeviceFlow();
    return { status: 'expired' };
  }

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: flow.clientId,
      device_code: flow.deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    }),
  });
  const data = await res.json().catch(() => ({}));

  if (data.access_token) {
    await set({ [Keys.TOKEN]: data.access_token });
    await clearDeviceFlow();
    return { status: 'success' };
  }

  switch (data.error) {
    case 'authorization_pending': {
      const next = { ...flow, status: 'pending' };
      await set({ [Keys.DEVICE_FLOW]: next });
      armAlarm(flow.interval);
      return { status: 'pending' };
    }
    case 'slow_down': {
      const interval = flow.interval + 5; // required by spec §8.3
      const next = { ...flow, interval, status: 'pending' };
      await set({ [Keys.DEVICE_FLOW]: next });
      armAlarm(interval);
      return { status: 'pending', interval };
    }
    case 'expired_token': {
      await set({ [Keys.DEVICE_FLOW]: { ...flow, status: 'expired' } });
      ext.alarms.clear(AUTH_ALARM);
      return { status: 'expired' };
    }
    case 'access_denied': {
      await set({ [Keys.DEVICE_FLOW]: { ...flow, status: 'denied' } });
      ext.alarms.clear(AUTH_ALARM);
      return { status: 'denied' };
    }
    default: {
      const message = data.error_description || data.error || `unexpected response (${res.status})`;
      await set({ [Keys.DEVICE_FLOW]: { ...flow, status: 'error', message } });
      armAlarm(flow.interval);
      return { status: 'error', message };
    }
  }
}
