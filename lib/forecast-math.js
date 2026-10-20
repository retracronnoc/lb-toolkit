// Toolkit for Liquid Budget — forecast math (pace and burn per bucket).
// Plain script with no dependencies: loaded by the content script, the
// service worker (importScripts) and Node tests (require). Money stays in
// Liquid Budget's scale-4 integers (123400 = $12.34) until it's displayed.
(function (root) {
'use strict';

const pad = (n) => String(n).padStart(2, '0');

/** Today's calendar date in the browser's time zone, as YYYY-MM-DD. */
function localToday(now = new Date()) {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * Calendar date (YYYY-MM-DD) of a transaction's dateEpoch (seconds).
 * An exact UTC midnight is read as that UTC date; any other timestamp is read
 * in the browser's local time zone.
 */
function txDate(dateEpoch) {
  const d = new Date(dateEpoch * 1000);
  if (dateEpoch % 86400 === 0) {
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  }
  return localToday(d);
}

/**
 * Compact API transactions for caching and messaging:
 *   [accountId, dateEpoch, amount, pending, bucket, payee, type]
 * where bucket is null, a bucket ID, or { bucketId: positiveAmount } for a split,
 * payee is a string ('' if none) and type is 'T' (transaction), 'X' (transfer)
 * or 'A' (adjustment).
 */
function compactTransactions(transactions) {
  const out = [];
  for (const t of transactions || []) {
    if (!t || !t.accountId || typeof t.amount !== 'number') continue;
    let bucket = null;
    const alloc = t.bucketSplit && t.bucketSplit.allocations;
    if (alloc && typeof alloc === 'object' && Object.keys(alloc).length) bucket = { ...alloc };
    else if (t.bucketId) bucket = t.bucketId;
    const type = t.type === 'TRANSFER' ? 'X' : t.type === 'ADJUSTMENT' ? 'A' : 'T';
    const payee = typeof t.payee === 'string' ? t.payee.slice(0, 80) : '';
    out.push([t.accountId, typeof t.dateEpoch === 'number' ? t.dateEpoch : 0, t.amount, t.status === 'PENDING' ? 1 : 0, bucket, payee, type]);
  }
  return out;
}

/** 'YYYY-MM' for a 'YYYY-MM-DD' date. */
/** IDs of off-budget accounts (OFF_BUDGET_ASSET / OFF_BUDGET_LIABILITY) from an account list. */
function offBudgetIds(accounts) {
  return (accounts || []).filter((a) => a && /^OFF_BUDGET/i.test(String(a.type || ''))).map((a) => a.id);
}

const ymOf = (date) => date.slice(0, 7);

/** Shift a 'YYYY-MM' by n months. */
function addMonths(ym, n) {
  const [y, m] = ym.split('-').map(Number);
  const idx = y * 12 + (m - 1) + n;
  return `${Math.floor(idx / 12)}-${pad((idx % 12) + 1)}`;
}

/** Calendar facts about the month containing `today` (YYYY-MM-DD). */
function monthInfo(today) {
  const [y, m, d] = today.split('-').map(Number);
  const daysInMonth = new Date(y, m, 0).getDate();
  return {
    today,
    ym: `${y}-${pad(m)}`,
    day: d,
    daysInMonth,
    daysLeft: daysInMonth - d, // full days after today
    elapsed: d / daysInMonth, // today counts as elapsed
  };
}

/**
 * Net activity per bucket per month: { [bucketId]: { [ym]: scale4 } }.
 * Rows are compact transactions [accountId, dateEpoch, amount, pending, bucket]
 * (see liquidbudget.js). Anything dated after `asOf` is ignored. Splits give
 * each bucket its share, signed like the transaction (outflows negative).
 */
function eachBucketShare(rows, asOf, { includePending = true, dateOf = txDate } = {}, fn) {
  for (const [, dateEpoch, amount, pending, bucket] of rows || []) {
    if (!bucket || !dateEpoch) continue;
    if (pending && !includePending) continue;
    const date = dateOf(dateEpoch);
    if (date > asOf) continue;
    const ym = ymOf(date);
    if (typeof bucket === 'string') {
      fn(bucket, ym, amount);
    } else {
      const sign = amount < 0 ? -1 : 1;
      for (const [id, part] of Object.entries(bucket)) fn(id, ym, sign * Math.abs(part));
    }
  }
}

function bucketActivity(rows, asOf, opts) {
  const out = {};
  eachBucketShare(rows, asOf, opts, (id, ym, amt) => {
    const b = (out[id] ||= {});
    b[ym] = (b[ym] || 0) + amt;
  });
  return out;
}

/** Number of outflow transactions per bucket per month: { [bucketId]: { [ym]: n } }. */
function bucketOutflowCounts(rows, asOf, opts) {
  const out = {};
  eachBucketShare(rows, asOf, opts, (id, ym, amt) => {
    if (amt >= 0) return;
    const b = (out[id] ||= {});
    b[ym] = (b[ym] || 0) + 1;
  });
  return out;
}

/**
 * A bucket is "steady" spending (groceries, dining, fuel) when it averaged at
 * least 2 outflows a month over the previous 3 months, or already has 2 this
 * month. Anything else (mortgage, utilities, a one-off purchase) is treated as
 * a bill: once it's paid, it isn't projected forward at a daily rate.
 */
function isSteady(counts, ym) {
  const c = counts || {};
  if ((c[ym] || 0) >= 2) return true;
  let past = 0;
  for (let i = 1; i <= 3; i++) past += c[addMonths(ym, -i)] || 0;
  return past / 3 >= 2;
}

const assignYm = (a) => `${a.year}-${pad(a.month)}`;

/** Amount assigned to a bucket in one month. */
function assignedIn(bucket, ym) {
  let sum = 0;
  for (const a of bucket.assignments || []) if (assignYm(a) === ym) sum += a.amount;
  return sum;
}

/** Everything assigned to a bucket up to and including `ym`. */
function assignedThrough(bucket, ym) {
  let sum = 0;
  for (const a of bucket.assignments || []) if (assignYm(a) <= ym) sum += a.amount;
  return sum;
}

/**
 * A bucket's Available at `ym`, the way Liquid Budget shows it: balances roll
 * forward month to month, but an overspent (negative) balance does not carry
 * into the next month; it starts that month at $0. `months` is the bucket's
 * { [ym]: activity } with only activity up to "now" in it.
 */
function availableAt(bucket, months, ym) {
  const asg = {};
  for (const a of bucket.assignments || []) {
    const k = assignYm(a);
    if (k <= ym) asg[k] = (asg[k] || 0) + a.amount;
  }
  const keys = [...new Set([...Object.keys(asg), ...Object.keys(months || {}).filter((k) => k <= ym)])].sort();
  let bal = 0;
  keys.forEach((k, i) => {
    if (i > 0) bal = Math.max(0, bal);
    bal += (asg[k] || 0) + ((months || {})[k] || 0);
  });
  if (keys.length && keys[keys.length - 1] < ym) bal = Math.max(0, bal);
  return bal;
}

/**
 * Pace forecast for one bucket in the current month.
 * - spent: net outflow this month so far (refunds reduce it; never below 0)
 * - available: Liquid Budget's "Available" (see availableAt)
 * - spendable: what the month started with plus this month's assignments
 *   (available + spent), the basis for the pace check
 * - kind: 'steady' or 'bill' (see isSteady)
 * - dailyBurn, projected: straight-line pace to month end for steady
 *   spending; a paid bill or an emptied envelope projects to what's spent
 * - lastsDays / runsOutOn: when available hits $0 at this pace (steady only)
 * - safePerDay: available spread over the rest of the month
 * - avg3: average monthly spending over the previous 3 full months
 */
function forecastBucket(bucket, activity, mi, counts = null) {
  const months = activity[bucket.id] || {};
  const activityNow = months[mi.ym] || 0;

  const assigned = assignedIn(bucket, mi.ym);
  const available = availableAt(bucket, months, mi.ym);
  const spent = Math.max(0, -activityNow);
  const spendable = available + spent;
  const dailyBurn = spent / mi.day;
  // Without counts (older callers/tests) every bucket is treated as steady.
  const kind = !counts || isSteady(counts[bucket.id], mi.ym) ? 'steady' : 'bill';
  // A paid bill, or an envelope that's empty but not overspent, is assumed done
  // for the month: you'd have to move money in to spend more.
  const settled = spent > 0 && (kind === 'bill' || available === 0) && available >= 0;
  const projected = settled ? spent : Math.round(dailyBurn * mi.daysInMonth);
  const safePerDay = available > 0 ? Math.round(available / Math.max(1, mi.daysLeft)) : 0;

  let lastsDays = Infinity;
  if (dailyBurn > 0 && kind === 'steady') lastsDays = Math.max(0, available) / dailyBurn;
  let runsOutOn = null;
  if (Number.isFinite(lastsDays) && lastsDays < mi.daysLeft) {
    const [y, m] = mi.ym.split('-').map(Number);
    const d = new Date(y, m - 1, mi.day + Math.ceil(lastsDays));
    runsOutOn = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  let past = 0;
  for (let i = 1; i <= 3; i++) past += Math.max(0, -(months[addMonths(mi.ym, -i)] || 0));
  const avg3 = Math.round(past / 3);

  return {
    id: bucket.id,
    name: bucket.name,
    categoryId: bucket.categoryId,
    kind,
    assigned,
    spent,
    available,
    spendable,
    dailyBurn,
    projected,
    lastsDays,
    runsOutOn,
    safePerDay,
    avg3,
    pctSpent: spendable > 0 ? spent / spendable : null,
    status: kind === 'bill' && spent > 0 && available >= 0 ? 'billed' : paceStatus({ spent, available, spendable, projected }),
  };
}

/**
 * billed  – (set by forecastBucket) a bill-type bucket that's been paid this month
 * idle    – nothing spent and nothing available
 * over    – available is negative (overspent)
 * done    – spent this month and nothing left (bill paid / envelope emptied)
 * ok      – projected month-end spending fits what's available
 * watch   – projected to go up to 10% over
 * risk    – projected to go more than 10% over
 */
function paceStatus({ spent, available, spendable, projected }) {
  if (available < 0) return 'over';
  if (spent === 0) return available > 0 ? 'ok' : 'idle';
  if (available === 0) return 'done';
  if (projected <= spendable) return 'ok';
  if (projected <= spendable * 1.1) return 'watch';
  return 'risk';
}

/**
 * Forecast every active bucket, grouped by category in API order.
 * Returns { month, groups: [{ id, name, rows, totals }], totals }.
 */
function buildForecast({ categories, buckets, rows, today, includePending = true }) {
  const mi = monthInfo(today);
  const activity = bucketActivity(rows, today, { includePending });
  const counts = bucketOutflowCounts(rows, today, { includePending });
  const live = (buckets || []).filter((b) => !b.archived);
  const groups = [];
  const known = new Set((categories || []).map((c) => c.id));
  const cats = [...(categories || [])];
  const orphans = live.filter((b) => !known.has(b.categoryId));
  if (orphans.length) cats.push({ id: '__none', name: 'Other' });
  for (const cat of cats) {
    const inCat = cat.id === '__none' ? orphans : live.filter((b) => b.categoryId === cat.id);
    if (!inCat.length) continue;
    const rowsOut = inCat.map((b) => forecastBucket(b, activity, mi, counts));
    groups.push({ id: cat.id, name: cat.name, rows: rowsOut, totals: sumRows(rowsOut, mi) });
  }
  return { month: mi, groups };
}

/** Totals for a set of forecast rows (same fields as a single row, where they add up). */
function sumRows(rows, mi) {
  const t = { assigned: 0, spent: 0, available: 0, spendable: 0, projected: 0, avg3: 0 };
  for (const r of rows) for (const k of Object.keys(t)) t[k] += r[k];
  // Daily pace counts only steady spending that's still going; paid bills and
  // emptied envelopes would otherwise inflate it.
  let live = 0;
  for (const r of rows) if (r.kind !== 'bill' && r.status !== 'done') live += r.spent;
  t.dailyBurn = live / mi.day;
  t.safePerDay = t.available > 0 ? Math.round(t.available / Math.max(1, mi.daysLeft)) : 0;
  t.pctSpent = t.spendable > 0 ? t.spent / t.spendable : null;
  t.status = paceStatus(t);
  return t;
}

const api = { localToday, txDate, compactTransactions, offBudgetIds, ymOf, addMonths, monthInfo, bucketActivity, bucketOutflowCounts, isSteady, assignedIn, assignedThrough, availableAt, forecastBucket, paceStatus, buildForecast, sumRows };
root.LBTForecast = api;
if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
