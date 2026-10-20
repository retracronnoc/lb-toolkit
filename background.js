/**
 * Toolkit for Liquid Budget — service worker
 *
 * Talks to the Liquid Budget Developer API for the Pacing page, so the API
 * token never touches the web page. Uses the API's ETags: unchanged data comes
 * back as 304 Not Modified, which is served from cache and doesn't count
 * toward the 100 requests/hour limit.
 */

importScripts('lib/forecast-math.js');

const API = 'https://www.liquidbudget.com/developer';
// One storage key per endpoint, so parallel requests don't overwrite each other.
// v2: cached transactions also carry payee and type (for Pacing).
const CACHE_PREFIX = 'lbtApiCache2:';
const OLD_CACHE_PREFIXES = ['lbtApiCache:'];

chrome.runtime.onInstalled.addListener(async () => {
  const all = await chrome.storage.local.get(null);
  const stale = Object.keys(all).filter((k) => OLD_CACHE_PREFIXES.some((p) => k.startsWith(p)));
  if (stale.length) await chrome.storage.local.remove(stale);
  await chrome.storage.sync.remove('includePending'); // Pacing always counts pending and future-dated transactions
});

class ApiError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.status = status;
  }
}

async function getToken() {
  const { lbToken } = await chrome.storage.local.get('lbToken');
  if (!lbToken) throw new ApiError('Add your Liquid Budget API token in the Toolkit settings to use this feature.', 401);
  return lbToken;
}

async function apiFetch(token, path, etag) {
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
  if (etag) headers['If-None-Match'] = etag;
  let res;
  try {
    res = await fetch(API + path, { headers, cache: 'no-store' });
  } catch {
    throw new ApiError('Could not reach Liquid Budget. Check your internet connection.');
  }
  if (res.status === 304) return { notModified: true };
  if (res.status === 401) throw new ApiError('Liquid Budget rejected the API token. It may be mistyped or revoked; update it in Toolkit settings.', 401);
  if (res.status === 403) throw new ApiError('This API token does not have access to that budget.', 403);
  if (res.status === 404) throw new ApiError('Liquid Budget could not find this budget through the API.', 404);
  if (res.status === 429) {
    const secs = parseInt(res.headers.get('Retry-After') || '0', 10);
    throw new ApiError(`Liquid Budget's API limit (100 requests/hour) was reached.${secs ? ` Try again in about ${Math.ceil(secs / 60)} minute(s).` : ''}`, 429);
  }
  if (!res.ok) throw new ApiError(`Liquid Budget returned an error (HTTP ${res.status}).`, res.status);
  return { data: await res.json(), etag: res.headers.get('ETag') };
}

// GET with ETag caching. `transform` shrinks the body before it's stored.
async function cachedGet(token, path, transform = (x) => x) {
  const key = CACHE_PREFIX + path;
  const entry = (await chrome.storage.local.get(key))[key];
  let res = await apiFetch(token, path, entry && entry.etag);
  if (res.notModified) {
    if (entry) return entry.value;
    res = await apiFetch(token, path, null);
  }
  const value = transform(res.data);
  if (res.etag) await chrome.storage.local.set({ [key]: { etag: res.etag, value } });
  return value;
}

async function pacingData(budgetId) {
  const token = await getToken();
  const b = `/budget/${encodeURIComponent(budgetId)}`;
  const [budget, categories, buckets, rows, offBudgetAccounts] = await Promise.all([
    cachedGet(token, b),
    cachedGet(token, `${b}/category`),
    cachedGet(token, `${b}/bucket`),
    cachedGet(token, `${b}/transaction`, LBTForecast.compactTransactions),
    offBudgetAccountIds(token, b),
  ]);
  return { budget, categories, buckets, rows, offBudgetAccounts };
}

// Off-budget account IDs (assets/liabilities), or null if the Developer API
// has no account list. A missing endpoint is remembered for a day so it
// doesn't use up requests; the page then reads the app's own account list.
const NO_ACCOUNTS_KEY = 'lbtNoAccountEndpoint';
async function offBudgetAccountIds(token, b) {
  const { [NO_ACCOUNTS_KEY]: miss } = await chrome.storage.local.get(NO_ACCOUNTS_KEY);
  if (miss && Date.now() - miss < 24 * 3600 * 1000) return null;
  try {
    return await cachedGet(token, `${b}/account`, LBTForecast.offBudgetIds);
  } catch (e) {
    if (e.status === 404) await chrome.storage.local.set({ [NO_ACCOUNTS_KEY]: Date.now() });
    return null;
  }
}

async function testToken(token) {
  const res = await apiFetch(token, '/budget', null);
  return { budgets: (res.data || []).map((x) => ({ id: x.id, name: x.name })) };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const run = async () => {
    switch (msg && msg.type) {
      case 'lbt-pacing-data':
        return pacingData(msg.budgetId);
      case 'lbt-test-token':
        return testToken(msg.token);
      case 'lbt-clear-cache': {
        const keys = Object.keys(await chrome.storage.local.get(null)).filter((k) => k.startsWith(CACHE_PREFIX));
        await chrome.storage.local.remove(keys);
        return { ok: true };
      }
      case 'lbt-open-options':
        await chrome.runtime.openOptionsPage();
        return { ok: true };
      default:
        return undefined;
    }
  };
  run().then(
    (result) => sendResponse({ ok: true, result }),
    (e) => sendResponse({ ok: false, error: e.message, status: e.status || 0 }),
  );
  return true; // async response
});
